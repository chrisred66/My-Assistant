<?php

declare(strict_types=1);

namespace ChrisManager\Pt;

use ChrisManager\Ai\OpenAiCompatProvider;
use ChrisManager\HttpException;
use ChrisManager\Usage;

/**
 * Overnight charging schedule planned with DeepSeek. The app sends what the simulation currently uses (requirements
 * after any ad-hoc adjustments, the enabled guns and their rates), so the plan fits what's on screen.
 * DeepSeek decides the strategy — which gun each bus uses, the order on each gun and, if useful, the earliest time a
 * bus should start (night tariff, spreading the load, the planner's instructions). The app then computes the actual
 * times: each session starts as soon as its bus, gun and "not before" time allow and is long enough for the bus's
 * full energy at the shared rate. (Tested: when asked for exact times, the model's sessions were often far too short.)
 *
 * Times on the 24 h window: minutes from 19:00 (0) to 19:00 the next day (1440), like the app's chargingModel.ts.
 */
final class ChargingAi
{
    public const GOALS = [
        'all_charged'  => 'Every bus fully charged before its first departure; then keep peak power low.',
        'lowest_peak'  => 'Keep total site power as low and flat as possible, while still charging every bus fully before departure.',
        'night_tariff' => 'Charge as much as possible between 23:00 and 07:00 (cheaper night tariff), while still charging every bus fully before departure.',
        'fewest_guns'  => 'Use as few guns as possible (leave the rest free), while still charging every bus fully before departure.',
    ];
    private const SNAP = 10;
    private const DAY = 1440;
    private const WINDOW_START = 19 * 60;

    /**
     * @param list<array{key: string, label: string, charger: string, one_gun: float, two_gun: float}> $lanes
     * @param list<array{bus_id: int, required_kwh: float, available: int, deadline: ?int, max_intake_kw: ?float, model?: string}> $buses
     * @return array{sessions: list<array{bus_id: int, lane: string, start: int, duration: int}>, unplaced: list<int>, notes: string, repairs: list<string>, model: string, tokens: int}
     */
    public static function propose(int $userId, array $lanes, array $buses, int $buffer, string $goal, string $instructions): array
    {
        if (!$lanes || !$buses) {
            throw new HttpException(422, 'Nothing to schedule: choose at least one charger and a day with buses');
        }
        $provider = new OpenAiCompatProvider('deepseek');
        $result = $provider->complete(self::systemPrompt(), self::userPrompt($lanes, $buses, $buffer, $goal, $instructions), $provider->defaultModel(), null, true, 8000);
        Usage::logChat($userId, 'deepseek', $result, 'charging_schedule');

        $text = trim(preg_replace('/^```(?:json)?\s*|\s*```$/', '', $result->text));
        $reply = json_decode($text, true);
        $plan = $reply['plan'] ?? $reply['sessions'] ?? null;
        if (!is_array($plan)) {
            throw new HttpException(502, 'The AI did not return a usable plan; try again');
        }
        [$sessions, $unplaced, $repairs] = self::pack($plan, $lanes, $buses, $buffer);
        return [
            'sessions' => $sessions,
            'unplaced' => $unplaced,
            'notes' => mb_substr(trim((string) ($reply['notes'] ?? '')), 0, 2000),
            'repairs' => $repairs,
            'model' => $result->model,
            'tokens' => $result->inputTokens + $result->cacheReadTokens + $result->outputTokens,
        ];
    }

    private static function systemPrompt(): string
    {
        return <<<'TXT'
            You plan overnight charging for a battery-electric bus depot. Reply with a JSON object only.

            You decide the strategy; the depot software computes the exact times. For every bus choose:
            - "gun": which gun charges it (one session per bus);
            - "order": its position in the queue on that gun (1 = first). Each gun charges one bus at a time, in order;
            - "not_before" (optional, HH:MM): the earliest time it may start, when holding it back helps the goal.
            The software starts each session at the latest of: the bus's "available" time, its "not_before", and the end
            of the previous session on the same gun plus buffer_minutes. The session lasts "minutes_needed" (already
            calculated at the gun's shared rate, so the bus gets its full energy).

            How charging works, to help you choose:
            - Guns belong to chargers. One gun alone on a charger gives its one_gun kW; two guns of the same charger in
              use at once give two_gun kW each. Higher-power guns finish buses sooner.
            - The window runs 19:00 → 19:00 next day. A bus should finish before its "deadline" (first departure) when
              one is given; buses with early deadlines or large needs should go first on fast guns.
            - "feasibility" says whether everything fits before departures. If not, spread buses over all guns so the
              fewest buses run late.

            The "instructions" field is from the depot planner; follow it when possible.

            Reply format:
            {"plan": [{"bus_id": 3001, "gun": "1/1/1", "order": 1, "not_before": "23:00"}],
             "notes": "one or two sentences on the strategy and which buses may run late"}
            TXT;
    }

    private static function userPrompt(array $lanes, array $buses, int $buffer, string $goal, string $instructions): string
    {
        $clock = fn (?int $t) => $t === null ? null : self::clock($t);
        // Minutes each bus needs on each gun, worked out here (models are poor at this arithmetic).
        $duration = fn (array $b, array $l): int => self::duration($b, $l);
        // Rough feasibility: energy needed vs what all guns could deliver (at their shared rate) from the earliest
        // plug-in to the typical deadline.
        $needed = array_sum(array_column($buses, 'required_kwh'));
        $deadlines = array_filter(array_column($buses, 'deadline'), fn ($d) => $d !== null);
        $earliest = min(array_column($buses, 'available'));
        $until = $deadlines ? (int) round(array_sum($deadlines) / count($deadlines)) : self::DAY;
        $capacity = array_sum(array_map(fn ($l) => ($l['two_gun'] ?: $l['one_gun']), $lanes)) * max(0, $until - $earliest) / 60;
        return json_encode([
            'goal' => self::GOALS[$goal] ?? self::GOALS['all_charged'],
            'buffer_minutes' => $buffer,
            'feasibility' => sprintf(
                'Buses need %d kWh in total. All guns together can deliver about %d kWh between %s and %s (the typical departure). %s',
                $needed, $capacity, self::clock($earliest), self::clock($until),
                $needed > $capacity ? 'That is not enough: some sessions will have to run past their departure.' : 'That should be enough if sessions are spread well.',
            ),
            'guns' => array_map(fn ($l) => ['gun' => $l['key'], 'charger' => $l['charger'], 'label' => $l['label'], 'one_gun_kw' => $l['one_gun'], 'two_gun_kw' => $l['two_gun']], $lanes),
            'buses' => array_map(fn ($b) => [
                'bus_id' => $b['bus_id'], 'required_kwh' => round($b['required_kwh'], 1), 'available' => $clock($b['available']),
                'deadline' => $clock($b['deadline']), 'max_intake_kw' => $b['max_intake_kw'],
                'minutes_needed' => array_combine(array_column($lanes, 'key'), array_map(fn ($l) => $duration($b, $l), $lanes)),
            ], $buses),
            'instructions' => mb_substr($instructions, 0, 1000),
        ], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    }

    /** Window minutes → "HH:MM". */
    public static function clock(int $t): string
    {
        $c = ((self::WINDOW_START + $t) % self::DAY + self::DAY) % self::DAY;
        return sprintf('%02d:%02d', intdiv($c, 60), $c % 60);
    }

    /** "HH:MM" → window minutes; null if unreadable. */
    private static function toWindow(mixed $v): ?int
    {
        if (!is_string($v) || !preg_match('/^(\d{1,2}):(\d{2})/', trim($v), $m) || (int) $m[1] > 24 || (int) $m[2] > 59) {
            return null;
        }
        return ((int) $m[1] * 60 + (int) $m[2] - self::WINDOW_START + self::DAY) % self::DAY;
    }

    private static function snap(float $m): int
    {
        return (int) (round($m / self::SNAP) * self::SNAP);
    }

    /** Session length for a bus on a gun: its full energy at the gun's shared rate (as the auto-scheduler plans). */
    private static function duration(array $bus, array $lane): int
    {
        $kw = min($lane['two_gun'] ?: $lane['one_gun'], $bus['max_intake_kw'] ?: INF);
        return max(30, (int) (ceil($bus['required_kwh'] / max(1, $kw) * 60 / self::SNAP) * self::SNAP));
    }

    /** Turns DeepSeek's plan into timed sessions; returns [sessions, unplaced bus ids, notes on what was changed]. */
    private static function pack(array $plan, array $lanes, array $buses, int $buffer): array
    {
        $laneBy = array_column($lanes, null, 'key');
        $busBy = array_column($buses, null, 'bus_id');
        $repairs = [];
        $queues = []; // gun => list of [order, bus, not_before]
        $seen = [];
        foreach ($plan as $i => $p) {
            $bus = (int) ($p['bus_id'] ?? 0);
            if (!isset($busBy[$bus])) {
                continue;
            }
            if (isset($seen[$bus])) {
                $repairs[] = "Bus {$bus}: planned twice, kept the first";
                continue;
            }
            $gun = (string) ($p['gun'] ?? $p['lane'] ?? '');
            if (!isset($laneBy[$gun])) {
                $repairs[] = "Bus {$bus}: unknown gun \"{$gun}\", placed by the app";
                continue;
            }
            $seen[$bus] = true;
            $queues[$gun][] = [(float) ($p['order'] ?? $i + 1), $bus, self::toWindow($p['not_before'] ?? null)];
        }
        $placed = [];
        $taken = []; // gun => list of [start, end]
        foreach ($queues as $gun => $q) {
            usort($q, fn ($x, $y) => $x[0] <=> $y[0]);
            $lane = $laneBy[$gun];
            $cursor = 0;
            foreach ($q as [, $busId, $notBefore]) {
                $bus = $busBy[$busId];
                $len = self::duration($bus, $lane);
                $start = max($bus['available'], $notBefore !== null ? self::snap($notBefore) : 0, $cursor);
                $start = (int) (ceil($start / self::SNAP) * self::SNAP);
                if ($start + $len > self::DAY) {
                    $repairs[] = "Bus {$busId}: no room left on gun {$gun} before 19:00, placed by the app";
                    continue;
                }
                $placed[$busId] = ['bus_id' => $busId, 'lane' => $gun, 'start' => $start, 'duration' => $len];
                $taken[$gun][] = [$start, $start + $len];
                $cursor = $start + $len + $buffer;
            }
        }
        // Buses the plan left out (or that didn't fit): earliest free slot on any gun.
        $unplaced = [];
        foreach ($buses as $bus) {
            if (isset($placed[$bus['bus_id']])) {
                continue;
            }
            $best = null;
            foreach ($lanes as $lane) {
                $len = self::duration($bus, $lane);
                for ($t = $bus['available']; $t + $len <= self::DAY; $t += self::SNAP) {
                    $free = true;
                    foreach ($taken[$lane['key']] ?? [] as [$s0, $e0]) {
                        if ($t < $e0 + $buffer && $t + $len + $buffer > $s0) {
                            $free = false;
                            break;
                        }
                    }
                    if ($free) {
                        if ($best === null || $t < $best['start']) {
                            $best = ['bus_id' => $bus['bus_id'], 'lane' => $lane['key'], 'start' => $t, 'duration' => $len];
                        }
                        break;
                    }
                }
            }
            if ($best === null) {
                $unplaced[] = $bus['bus_id'];
                continue;
            }
            if (!isset($seen[$bus['bus_id']])) {
                $repairs[] = "Bus {$bus['bus_id']}: not in the AI's plan, placed by the app at " . self::clock($best['start']);
            }
            $taken[$best['lane']][] = [$best['start'], $best['start'] + $best['duration']];
            $placed[$bus['bus_id']] = $best;
        }
        return [array_values($placed), $unplaced, $repairs];
    }
}
