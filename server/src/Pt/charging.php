<?php

declare(strict_types=1);

/**
 * PT Management: Charging. Stations (charging_station_db) hold chargers; each charger has one row per gun in
 * charger_db (charger_id + gun_id). A charger's guns share its power: one gun alone delivers one_gun_output kW,
 * two at once deliver two_gun_output kW each (0 = not stated; the simulation then uses one_gun_output).
 * view: read and simulate; edit: add stations and chargers; admin: remove them.
 */

/** @var ChrisManager\Router $router */

use ChrisManager\Auth;
use ChrisManager\HttpException;
use ChrisManager\Pt\ChargingAi;
use ChrisManager\Pt\GbaDb;
use ChrisManager\Request;

function ptRefreshChargerCount(int $stationId): void
{
    GbaDb::run('UPDATE charging_station_db SET charger_count = (SELECT COUNT(DISTINCT charger_id) FROM charger_db WHERE station_id = ?)
                 WHERE station_id = ?', [$stationId, $stationId]);
}

// Stations with their chargers (guns grouped under each charger).
$router->get('/pt/charging/assets', function (Request $r) {
    Auth::requirePtModule($r, 'planning', 'view');
    $stations = [];
    foreach (GbaDb::all('SELECT station_id, station_name FROM charging_station_db ORDER BY station_id') as $s) {
        $stations[(int) $s['station_id']] = ['station_id' => (int) $s['station_id'], 'station_name' => $s['station_name'], 'chargers' => []];
    }
    foreach (GbaDb::all('SELECT * FROM charger_db ORDER BY station_id, charger_id, gun_id') as $g) {
        $sid = (int) $g['station_id'];
        if (!isset($stations[$sid])) {
            continue;
        }
        $key = (string) $g['charger_id'];
        $stations[$sid]['chargers'][$key] ??= [
            'charger_id' => $key, 'output_type' => $g['output_type'], 'location' => $g['charger_location'],
            'charger_output' => (int) $g['charger_output'], 'one_gun_output' => (int) $g['one_gun_output'],
            'two_gun_output' => (int) $g['two_gun_output'], 'guns' => [],
        ];
        $stations[$sid]['chargers'][$key]['guns'][] = (int) $g['gun_id'];
    }
    return array_values(array_map(fn ($s) => ['chargers' => array_values($s['chargers'])] + $s, $stations));
});

// Body: {station_name}. station_id has no auto-increment in this schema, so the next number is used.
$router->post('/pt/charging/stations', function (Request $r) {
    Auth::requirePtModule($r, 'planning', 'manage');
    $name = trim((string) $r->input('station_name', ''));
    if ($name === '') {
        throw new HttpException(422, 'Give the station a name');
    }
    if (GbaDb::one('SELECT 1 FROM charging_station_db WHERE station_name = ?', [$name])) {
        throw new HttpException(409, 'A station with that name already exists');
    }
    $id = (int) GbaDb::one('SELECT COALESCE(MAX(station_id), 0) + 1 AS id FROM charging_station_db')['id'];
    GbaDb::run('INSERT INTO charging_station_db (station_id, station_name, charger_count) VALUES (?, ?, 0)', [$id, mb_substr($name, 0, 255)]);
    return ['station_id' => $id];
});

// Only an empty station.
$router->delete('/pt/charging/stations/{id}', function (Request $r) {
    Auth::requirePtModule($r, 'planning', 'manage');
    $id = (int) $r->params['id'];
    if (!GbaDb::one('SELECT 1 FROM charging_station_db WHERE station_id = ?', [$id])) {
        throw new HttpException(404, 'Station not found');
    }
    $n = (int) GbaDb::one('SELECT COUNT(DISTINCT charger_id) AS n FROM charger_db WHERE station_id = ?', [$id])['n'];
    if ($n > 0) {
        throw new HttpException(409, "This station still has {$n} charger(s); remove them first");
    }
    GbaDb::run('DELETE FROM charging_station_db WHERE station_id = ?', [$id]);
    return ['ok' => true];
});

// Body: {station_id, charger_id, location?, output_type (DC|AC), gun_count (1-4), charger_output, one_gun_output, two_gun_output?}.
$router->post('/pt/charging/chargers', function (Request $r) {
    Auth::requirePtModule($r, 'planning', 'manage');
    $stationId = (int) $r->input('station_id', 0);
    $station = GbaDb::one('SELECT station_name FROM charging_station_db WHERE station_id = ?', [$stationId]);
    if ($station === null) {
        throw new HttpException(422, 'Choose a station');
    }
    $chargerId = trim((string) $r->input('charger_id', ''));
    if ($chargerId === '' || mb_strlen($chargerId) > 100) {
        throw new HttpException(422, 'Give the charger a name or number');
    }
    if (GbaDb::one('SELECT 1 FROM charger_db WHERE station_id = ? AND charger_id = ?', [$stationId, $chargerId])) {
        throw new HttpException(409, "Charger {$chargerId} already exists at this station");
    }
    $type = strtoupper((string) $r->input('output_type', 'DC'));
    if (!in_array($type, ['DC', 'AC'], true)) {
        throw new HttpException(422, 'Output type must be DC or AC');
    }
    $guns = (int) $r->input('gun_count', 0);
    if ($guns < 1 || $guns > 4) {
        throw new HttpException(422, 'A charger has 1 to 4 guns');
    }
    $total = (int) $r->input('charger_output', 0);
    $one = (int) $r->input('one_gun_output', 0);
    $two = $guns > 1 ? (int) $r->input('two_gun_output', 0) : 0;
    if ($total <= 0 || $one <= 0 || $one > $total || $two < 0 || $two > $total) {
        throw new HttpException(422, 'Give the charger\'s total output and the output per gun (kW, not more than the total)');
    }
    $location = trim((string) $r->input('location', '')) ?: $station['station_name'];
    $pdo = GbaDb::pdo();
    $pdo->beginTransaction();
    try {
        for ($gun = 1; $gun <= $guns; $gun++) {
            GbaDb::run(
                'INSERT INTO charger_db (charger_id, station_id, output_type, charger_location, gun_count, gun_id, charger_output, one_gun_output, two_gun_output)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [$chargerId, $stationId, $type, mb_substr($location, 0, 255), $guns, $gun, $total, $one, $two],
            );
        }
        ptRefreshChargerCount($stationId);
        $pdo->commit();
    } catch (\Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
    return ['ok' => true];
});

$router->delete('/pt/charging/stations/{sid}/chargers/{cid}', function (Request $r) {
    Auth::requirePtModule($r, 'planning', 'manage');
    $sid = (int) $r->params['sid'];
    $cid = rawurldecode($r->params['cid']);
    $pdo = GbaDb::pdo();
    $pdo->beginTransaction();
    try {
        $n = GbaDb::run('DELETE FROM charger_db WHERE station_id = ? AND charger_id = ?', [$sid, $cid])->rowCount();
        ptRefreshChargerCount($sid);
        $pdo->commit();
    } catch (\Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
    if ($n === 0) {
        throw new HttpException(404, 'Charger not found');
    }
    return ['ok' => true];
});

// Charging demand for one operating day: each battery-electric bus's energy used, distance and when its last trip
// ended (when it can start charging). Hydrogen buses are listed separately (they refuel, not charge).
// Also the days that have trips, for the date picker.
$router->get('/pt/charging/demand', function (Request $r) {
    Auth::requirePtModule($r, 'planning', 'view');
    $days = GbaDb::all('SELECT date, COUNT(DISTINCT bus_id) AS buses FROM triplog_db GROUP BY date ORDER BY date DESC LIMIT 400');
    $date = (string) $r->query('date', '');
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        // Default: the latest day with a normal amount of service (the last day of an export is often partial).
        $busiest = max(array_map(fn ($d) => (int) $d['buses'], array_slice($days, 0, 30)) ?: [0]);
        $typical = array_values(array_filter($days, fn ($d) => (int) $d['buses'] >= $busiest / 2));
        $date = (string) ($typical[0]['date'] ?? $days[0]['date'] ?? date('Y-m-d'));
    }
    $energy = "CASE WHEN m.energy_source LIKE 'Hy%' AND m.energy_source <> 'Hybrid' THEN 'Hydrogen' ELSE COALESCE(m.energy_source, 'Unknown') END";
    $rows = GbaDb::all(
        "SELECT t.bus_id, m.model, m.manufacturer, $energy AS energy, m.energy_capacity, m.one_port_intake, m.two_port_intake,
                m.charging_port_count, COUNT(*) AS trips,
                SUM(CASE WHEN t.distance > 0 AND t.distance <= 500 THEN t.distance END) AS distance,
                SUM(CASE WHEN t.distance > 0 AND t.distance <= 500 THEN t.energy_used END) AS energy_used,
                MIN(t.start_time) AS first_start, MAX(t.end_time) AS last_end,
                -- Trips running past midnight end 'earlier' than they started; the latest such end wins.
                MAX(CASE WHEN t.end_time < t.start_time THEN t.end_time END) AS overnight_end
           FROM triplog_db t LEFT JOIN fleet_db f ON f.bus_id = t.bus_id LEFT JOIN model_db m ON m.model_id = f.model_id
          WHERE t.date = ? AND t.bus_id IS NOT NULL
          GROUP BY t.bus_id, m.model, m.manufacturer, energy, m.energy_capacity, m.one_port_intake, m.two_port_intake, m.charging_port_count
          ORDER BY t.bus_id",
        [$date],
    );
    $buses = [];
    $other = [];
    foreach ($rows as $b) {
        $bus = [
            'bus_id' => (int) $b['bus_id'], 'model' => $b['model'], 'manufacturer' => $b['manufacturer'], 'energy' => $b['energy'],
            'battery_kwh' => $b['energy_capacity'] === null ? null : (float) $b['energy_capacity'],
            'max_intake_kw' => (int) ($b['one_port_intake'] ?? 0) ?: null, // 0 in the data = not stated
            'trips' => (int) $b['trips'], 'distance' => round((float) $b['distance'], 1),
            'energy_kwh' => $b['energy_used'] === null ? null : round((float) $b['energy_used'], 1),
            'first_start' => $b['first_start'], 'last_end' => $b['overnight_end'] ?? $b['last_end'],
        ];
        if ($b['energy'] === 'Electric') {
            $buses[] = $bus;
        } else {
            $other[] = $bus;
        }
    }
    return [
        'date' => $date,
        'buses' => $buses,
        'not_charged' => $other,
        'days' => array_map(fn ($d) => ['date' => $d['date'], 'buses' => (int) $d['buses']], $days),
    ];
});

/** Median of a list of numbers (null when empty). */
function ptMedian(array $v): ?float
{
    if (!$v) {
        return null;
    }
    sort($v);
    $n = count($v);
    return $n % 2 ? (float) $v[intdiv($n, 2)] : ($v[$n / 2 - 1] + $v[$n / 2]) / 2;
}

// A "typical day" for planning, from each battery-electric bus's recent history: its daily energy (average,
// 85th percentile or highest), and the median time its last trip ends and its first trip starts. Same shape as
// /pt/charging/demand, so the simulation treats it like an operating day.
// Query: days (7-365, default 30), weekdays (all | mon-fri | sat-sun), stat (avg | p85 | max), end (YYYY-MM-DD; default latest data).
$router->get('/pt/charging/history', function (Request $r) {
    Auth::requirePtModule($r, 'planning', 'view');
    $days = max(7, min(365, (int) $r->query('days', 30)));
    $stat = in_array($r->query('stat'), ['avg', 'p85', 'max'], true) ? $r->query('stat') : 'p85';
    $which = in_array($r->query('weekdays'), ['all', 'mon-fri', 'sat-sun'], true) ? $r->query('weekdays') : 'all';
    $end = (string) $r->query('end', '');
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $end)) {
        $end = (string) (GbaDb::one('SELECT MAX(date) AS d FROM triplog_db')['d'] ?? date('Y-m-d'));
    }
    $start = date('Y-m-d', strtotime("$end -" . ($days - 1) . ' days'));
    $energy = "CASE WHEN m.energy_source LIKE 'Hy%' AND m.energy_source <> 'Hybrid' THEN 'Hydrogen' ELSE COALESCE(m.energy_source, 'Unknown') END";
    $rows = GbaDb::all(
        "SELECT t.bus_id, t.date, m.model, m.manufacturer, $energy AS energy, m.energy_capacity, m.one_port_intake,
                SUM(CASE WHEN t.distance > 0 AND t.distance <= 500 THEN t.distance END) AS distance,
                SUM(CASE WHEN t.distance > 0 AND t.distance <= 500 THEN t.energy_used END) AS energy_used,
                COUNT(*) AS trips, MIN(t.start_time) AS first_start, MAX(t.end_time) AS last_end,
                MAX(CASE WHEN t.end_time < t.start_time THEN t.end_time END) AS overnight_end
           FROM triplog_db t LEFT JOIN fleet_db f ON f.bus_id = t.bus_id LEFT JOIN model_db m ON m.model_id = f.model_id
          WHERE t.date BETWEEN ? AND ? AND t.bus_id IS NOT NULL
          GROUP BY t.bus_id, t.date, m.model, m.manufacturer, energy, m.energy_capacity, m.one_port_intake",
        [$start, $end],
    );
    // Window minutes (19:00 = 0) so medians work across midnight.
    $win = fn (?string $t) => $t === null ? null : ((int) substr($t, 0, 2) * 60 + (int) substr($t, 3, 2) - 19 * 60 + 1440) % 1440;
    $clk = fn (?float $m) => $m === null ? null : sprintf('%02d:%02d:00', intdiv(((int) round($m) + 19 * 60) % 1440, 60), ((int) round($m) + 19 * 60) % 60);
    $per = [];
    foreach ($rows as $d) {
        $dow = (int) date('N', strtotime($d['date'])); // 1 = Monday
        if (($which === 'mon-fri' && $dow > 5) || ($which === 'sat-sun' && $dow <= 5) || $d['energy'] !== 'Electric' || $d['energy_used'] === null) {
            continue;
        }
        $b = (int) $d['bus_id'];
        $per[$b] ??= ['info' => $d, 'energy' => [], 'distance' => [], 'trips' => [], 'first' => [], 'last' => []];
        $per[$b]['energy'][] = (float) $d['energy_used'];
        $per[$b]['distance'][] = (float) $d['distance'];
        $per[$b]['trips'][] = (int) $d['trips'];
        if ($d['first_start'] !== null) {
            $per[$b]['first'][] = $win($d['first_start']);
        }
        if (($d['overnight_end'] ?? $d['last_end']) !== null) {
            $per[$b]['last'][] = $win($d['overnight_end'] ?? $d['last_end']);
        }
    }
    $buses = [];
    foreach ($per as $b => $x) {
        $e = $x['energy'];
        sort($e);
        $value = match ($stat) {
            'avg' => array_sum($e) / count($e),
            'max' => max($e),
            'p85' => $e[(int) floor(0.85 * (count($e) - 1))],
        };
        $buses[] = [
            'bus_id' => $b, 'model' => $x['info']['model'], 'manufacturer' => $x['info']['manufacturer'], 'energy' => 'Electric',
            'battery_kwh' => $x['info']['energy_capacity'] === null ? null : (float) $x['info']['energy_capacity'],
            'max_intake_kw' => (int) ($x['info']['one_port_intake'] ?? 0) ?: null,
            'trips' => (int) round(ptMedian($x['trips'])), 'distance' => round(ptMedian($x['distance']), 1),
            'energy_kwh' => round($value, 1), 'days_operated' => count($e),
            'first_start' => $clk(ptMedian($x['first'])), 'last_end' => $clk(ptMedian($x['last'])),
        ];
    }
    usort($buses, fn ($a, $b) => $a['bus_id'] <=> $b['bus_id']);
    return [
        'date' => "typical ($start to $end)",
        'basis' => ['from' => $start, 'to' => $end, 'days' => $days, 'weekdays' => $which, 'stat' => $stat],
        'buses' => $buses,
        'not_charged' => [],
        'days' => [],
    ];
});

// DeepSeek proposes a schedule for what the simulation currently shows. Body: {lanes: [{key, label, charger, one_gun,
// two_gun}], buses: [{bus_id, required_kwh, available, deadline, max_intake_kw}], buffer, goal, instructions}.
// Times are minutes on the 19:00→19:00 window. Needs edit access (it's a paid API call, logged under Usage).
$router->post('/pt/charging/ai-schedule', function (Request $r) {
    $user = Auth::requirePtModule($r, 'planning', 'manage');
    $lanes = [];
    foreach ((array) $r->input('lanes', []) as $l) {
        if (!is_array($l) || !isset($l['key'])) {
            continue;
        }
        $lanes[] = ['key' => (string) $l['key'], 'label' => mb_substr((string) ($l['label'] ?? $l['key']), 0, 100), 'charger' => (string) ($l['charger'] ?? $l['key']),
            'one_gun' => max(0, (float) ($l['one_gun'] ?? 0)), 'two_gun' => max(0, (float) ($l['two_gun'] ?? 0))];
    }
    $buses = [];
    foreach ((array) $r->input('buses', []) as $b) {
        if (!is_array($b) || !isset($b['bus_id'], $b['required_kwh'])) {
            continue;
        }
        $deadline = $b['deadline'] ?? null;
        $buses[] = ['bus_id' => (int) $b['bus_id'], 'required_kwh' => max(0, (float) $b['required_kwh']),
            'available' => max(0, min(1440, (int) ($b['available'] ?? 0))), 'deadline' => $deadline === null ? null : max(0, min(1440, (int) $deadline)),
            'max_intake_kw' => isset($b['max_intake_kw']) && (float) $b['max_intake_kw'] > 0 ? (float) $b['max_intake_kw'] : null];
    }
    if (count($lanes) > 60 || count($buses) > 200) {
        throw new HttpException(422, 'Too many guns or buses for one request');
    }
    $goal = (string) $r->input('goal', 'all_charged');
    return ChargingAi::propose((int) $user['id'], $lanes, $buses, max(0, min(120, (int) $r->input('buffer', 15))),
        isset(ChargingAi::GOALS[$goal]) ? $goal : 'all_charged', trim((string) $r->input('instructions', '')));
});