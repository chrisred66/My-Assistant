<?php

declare(strict_types=1);

namespace ChrisManager;

/** Token-usage logging and reporting. */
final class Usage
{
    public static function log(array $row): void
    {
        Db::insert('token_usage', $row + ['occurred_at' => date('Y-m-d H:i:s')]);
    }

    /** Logs one chat-model call (DeepSeek calls with their exact cost: its prices depend on the time of day). */
    public static function logChat(int $userId, string $provider, Ai\ChatResult $result, string $feature): void
    {
        $cost = $provider === 'deepseek'
            ? self::deepSeekCost($result->model, $result->inputTokens, $result->cacheReadTokens, $result->outputTokens, new \DateTimeImmutable())
            : null;
        self::log([
            'user_id'            => $userId,
            'provider'           => $provider,
            'model'              => $result->model,
            'feature'            => $feature,
            'input_tokens'       => $result->inputTokens,
            'output_tokens'      => $result->outputTokens,
            'cache_read_tokens'  => $result->cacheReadTokens,
            'cache_write_tokens' => $result->cacheWriteTokens,
            'request_id'         => $result->requestId,
        ] + ($cost !== null ? ['cost_usd' => $cost] : []));
    }

    /**
     * DeepSeek's peak hours: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday, except mainland China's public
     * holidays (ChinaHolidays). Both windows fall on the same calendar day in Beijing (09:00-12:00 and 14:00-18:00),
     * so the UTC date is the Chinese date. Weekend make-up working days (调休) stay off-peak: DeepSeek counts all
     * weekends as off-peak.
     */
    public static function deepSeekPeak(\DateTimeInterface $at): bool
    {
        $utc = \DateTimeImmutable::createFromInterface($at)->setTimezone(new \DateTimeZone('UTC'));
        $hour = (int) $utc->format('G');
        return (int) $utc->format('N') <= 5 && (($hour >= 1 && $hour < 4) || ($hour >= 6 && $hour < 10))
            && !ChinaHolidays::isHoliday($utc->format('Y-m-d'));
    }

    /**
     * A DeepSeek call's cost in USD: model_prices holds the peak rates (migration 012), halved off-peak.
     * NULL when the model has no price row.
     */
    public static function deepSeekCost(string $model, int $input, int $cacheRead, int $output, \DateTimeInterface $at): ?float
    {
        $p = Db::one(
            "SELECT input_per_mtok, output_per_mtok, cache_read_per_mtok FROM model_prices
              WHERE provider = 'deepseek' AND model = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1",
            [$model, $at->format('Y-m-d')],
        );
        if ($p === null) {
            return null;
        }
        $peak = ($input * (float) $p['input_per_mtok'] + $output * (float) $p['output_per_mtok']
            + $cacheRead * (float) ($p['cache_read_per_mtok'] ?? $p['input_per_mtok'])) / 1_000_000;
        return round(self::deepSeekPeak($at) ? $peak : $peak / 2, 6);
    }

    /**
     * Totals grouped by day, month or model. Cost is the provider-billed amount where synced, else
     * estimated from the latest model_prices row effective on each usage date (NULL if no price is set).
     *
     * $view "providers": everything each provider reported (synced rows), plus manual entries. For a
     *                    provider that has never been synced (e.g. DeepSeek, which has no usage API),
     *                    this app's own relay rows stand in. Synced rows already include this app's
     *                    calls, so relay rows are never added on top of them.
     * $view "app":       only calls made through this app.
     */
    public static function summary(int $userId, string $from, string $to, string $groupBy, string $view = 'providers'): array
    {
        $groupExpr = match ($groupBy) {
            'day'   => 'DATE(u.occurred_at)',
            'month' => "DATE_FORMAT(u.occurred_at, '%Y-%m')",
            'model' => "CONCAT(u.provider, '/', u.model)",
            default => throw new HttpException(422, 'group must be day, month or model'),
        };
        $viewFilter = match ($view) {
            'app'       => "u.source = 'relay'",
            'providers' => "(u.source IN ('sync', 'manual')
                             OR (u.source = 'relay' AND u.provider NOT IN
                                 (SELECT s.provider FROM usage_sync s WHERE s.synced_at IS NOT NULL)))",
            default     => throw new HttpException(422, 'view must be providers or app'),
        };

        $sql = "
            SELECT {$groupExpr} AS bucket,
                   u.provider,
                   SUM(u.request_count)     AS requests,
                   SUM(u.input_tokens)      AS input_tokens,
                   SUM(u.output_tokens)     AS output_tokens,
                   SUM(u.cache_read_tokens) AS cache_read_tokens,
                   SUM(u.audio_seconds)     AS audio_seconds,
                   SUM(COALESCE(u.cost_usd,
                       (u.input_tokens * p.input_per_mtok
                        + u.output_tokens * p.output_per_mtok
                        + u.cache_read_tokens * COALESCE(p.cache_read_per_mtok, p.input_per_mtok)
                        + u.cache_write_tokens * COALESCE(p.cache_write_per_mtok, p.input_per_mtok)) / 1000000
                       + COALESCE(u.audio_seconds / 60 * p.per_audio_minute, 0)
                   )) AS cost_usd
              FROM token_usage u
              LEFT JOIN model_prices p
                     ON p.provider = u.provider AND p.model = u.model
                    AND p.effective_from = (
                        SELECT MAX(p2.effective_from) FROM model_prices p2
                         WHERE p2.provider = u.provider AND p2.model = u.model
                           AND p2.effective_from <= DATE(u.occurred_at))
             WHERE (u.user_id = :uid OR u.user_id IS NULL)
               AND {$viewFilter}
               AND u.occurred_at >= :from AND u.occurred_at < DATE_ADD(:to, INTERVAL 1 DAY)
             GROUP BY bucket, u.provider
             ORDER BY bucket, u.provider";

        return Db::all($sql, ['uid' => $userId, 'from' => $from, 'to' => $to]);
    }
}
