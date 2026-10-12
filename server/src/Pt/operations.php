<?php

declare(strict_types=1);

/**
 * PT Management: Operations (trip logs, KPIs, trends, exceptions).
 * view: read; edit: upload and enter trips; admin: resolve conflicting duplicates.
 *
 * Electric and hydrogen buses are reported separately: energy_used is kWh for battery buses and kg of
 * hydrogen for fuel-cell buses, so they can't be added together. Totals of distance and energy leave out
 * trips with an impossible distance (≤ 0 or over PT_MAX_TRIP_KM), which are listed as exceptions instead.
 */

/** @var ChrisManager\Router $router */

use ChrisManager\Auth;
use ChrisManager\HttpException;
use ChrisManager\Pt\GbaDb;
use ChrisManager\Pt\TripLog;
use ChrisManager\Request;

const PT_MAX_TRIP_KM = 500;
const PT_HIGH_KWH_PER_100KM = 140; // the original app's 1.4 kWh/km
const PT_HIGH_KG_PER_100KM = 14;   // hydrogen: ~p97 of the imported trips (median 8.6)
const PT_LOW_END_SOC = 20;
const PT_LOW_START_SOC = 80;

/**
 * Every read endpoint works on one of two datasets, chosen with ?dataset=:
 *   fleet (default) — triplog_db, buses from fleet_db;
 *   trial           — trial_triplog_db, buses from trial_fleet_db (optionally one trial: ?trial=ID).
 * Both are exposed as `t` with the same columns (bus_id = trial_bus_id for trials) and `m` = the bus's model.
 */
function ptIsTrial(Request $r): bool
{
    return $r->query('dataset', $r->input('dataset')) === 'trial';
}

/** FROM clause for the dataset. Buses no longer in the fleet show as energy 'Unknown'. */
function ptFrom(Request $r): string
{
    return ptIsTrial($r)
        ? 'FROM (SELECT tt.*, tt.id AS trip_id, tt.trial_bus_id AS bus_id, NULL AS extra_data FROM trial_triplog_db tt) t
           LEFT JOIN trial_fleet_db tf ON tf.trial_bus_id = t.trial_bus_id LEFT JOIN model_db m ON m.model_id = tf.model_id'
        : 'FROM triplog_db t LEFT JOIN fleet_db f ON f.bus_id = t.bus_id LEFT JOIN model_db m ON m.model_id = f.model_id';
}

/** PT module the request belongs to: trial trips are Planning, fleet trips Operations. */
function ptOpsModule(Request $r): string
{
    return ptIsTrial($r) ? 'planning' : 'operations';
}

/** What people call the bus: the fleet number, or a trial bus's own label. */
function ptBusLabel(Request $r): string
{
    return ptIsTrial($r) ? 'COALESCE(tf.bus_id, CAST(t.bus_id AS CHAR))' : 'CAST(t.bus_id AS CHAR)';
}
// Lenient: the imported data has "Hyrrogen".
const PT_ENERGY = "CASE WHEN m.energy_source LIKE 'Hy%' AND m.energy_source <> 'Hybrid' THEN 'Hydrogen' ELSE COALESCE(m.energy_source, 'Unknown') END";
const PT_VALID = '(t.distance > 0 AND t.distance <= ' . PT_MAX_TRIP_KM . ')';

/** Exception rules, most serious first: [code, label, severity, SQL condition]. */
function ptIssueRules(): array
{
    $e = PT_ENERGY;
    return [
        ['invalid_distance', 'Distance zero or negative', 'critical', 't.distance <= 0'],
        ['implausible_distance', 'Distance over ' . PT_MAX_TRIP_KM . ' km', 'critical', 't.distance > ' . PT_MAX_TRIP_KM],
        ['low_end_soc', 'Ended below ' . PT_LOW_END_SOC . '% SOC', 'serious', 't.end_soc < ' . PT_LOW_END_SOC],
        ['charged_during_trip', 'SOC rose during the trip', 'warning', 't.end_soc > t.start_soc'],
        ['high_consumption', 'High consumption', 'warning',
            "(($e = 'Hydrogen' AND t.energy_consumption > " . PT_HIGH_KG_PER_100KM . ") OR ($e = 'Electric' AND t.energy_consumption > " . PT_HIGH_KWH_PER_100KM . '))'],
        ['missing_time', 'Start or end time missing', 'warning', '(t.start_time IS NULL OR t.end_time IS NULL)'],
        ['low_start_soc', 'Started below ' . PT_LOW_START_SOC . '% SOC', 'info', 't.start_soc < ' . PT_LOW_START_SOC],
    ];
}

/** SQL listing a trip's issue codes, comma-separated (NULL when none). */
function ptIssuesSql(): string
{
    return 'CONCAT_WS(\',\', ' . implode(', ', array_map(fn ($r) => "IF({$r[3]}, '{$r[0]}', NULL)", ptIssueRules())) . ')';
}

/** WHERE clause and parameters from the common filters: from, to, bus, route, energy. */
function ptTripFilter(Request $r): array
{
    $from = (string) $r->query('from', '');
    $to = (string) $r->query('to', '');
    foreach ([$from, $to] as $d) {
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $d)) {
            throw new HttpException(422, 'from and to must be dates (YYYY-MM-DD)');
        }
    }
    $where = ['t.date BETWEEN ? AND ?'];
    $params = [$from, $to];
    if (($bus = (string) $r->query('bus', '')) !== '') {
        $where[] = 't.bus_id = ?';
        $params[] = (int) $bus;
    }
    if (($route = (string) $r->query('route', '')) !== '') {
        $where[] = 't.route = ?';
        $params[] = $route;
    }
    if (($energy = (string) $r->query('energy', '')) !== '') {
        $where[] = PT_ENERGY . ' = ?';
        $params[] = $energy;
    }
    if (ptIsTrial($r) && ($trial = (string) $r->query('trial', '')) !== '') {
        $where[] = 't.trial_id = ?';
        $params[] = (int) $trial;
    }
    return [implode(' AND ', $where), $params];
}

/** For trial uploads and entries: the trial (from the trial field) and its bus, or null for fleet trips. */
function ptTrialContext(Request $r): ?array
{
    if (!ptIsTrial($r)) {
        return null;
    }
    $row = GbaDb::one(
        'SELECT t.trial_id, t.trial_bus_id, tf.bus_id AS label FROM trial_db t LEFT JOIN trial_fleet_db tf ON tf.trial_bus_id = t.trial_bus_id
          WHERE t.trial_id = ?',
        [(int) $r->input('trial', 0)],
    );
    if ($row === null) {
        throw new HttpException(422, 'Choose the trial these trips belong to');
    }
    if ($row['trial_bus_id'] === null || $row['label'] === null) {
        throw new HttpException(422, 'This trial has no trial bus; set its bus first');
    }
    return ['trial_id' => (int) $row['trial_id'], 'trial_bus_id' => (int) $row['trial_bus_id'], 'label' => (string) $row['label']];
}

function ptRound(mixed $v, int $digits = 1): ?float
{
    return $v === null ? null : round((float) $v, $digits);
}

// --- Read ---------------------------------------------------------------------

// Date range of the data and the filter choices.
$router->get('/pt/trips/options', function (Request $r) {
    Auth::requirePtModule($r, ptOpsModule($r), 'view');
    $trial = ptIsTrial($r);
    $table = $trial ? 'trial_triplog_db' : 'triplog_db';
    $range = GbaDb::one("SELECT MIN(date) AS min_date, MAX(date) AS max_date, COUNT(*) AS trips FROM $table");
    // Trials list every trial bus (even before it has trips); the fleet lists buses that have trips.
    $buses = $trial
        ? GbaDb::all('SELECT tf.trial_bus_id AS bus_id, tf.bus_id AS label, ' . PT_ENERGY . ' AS energy, m.model
                        FROM trial_fleet_db tf LEFT JOIN model_db m ON m.model_id = tf.model_id ORDER BY tf.bus_id')
        : GbaDb::all('SELECT DISTINCT t.bus_id, CAST(t.bus_id AS CHAR) AS label, ' . PT_ENERGY . ' AS energy, m.model ' . ptFrom($r) . ' WHERE t.bus_id IS NOT NULL ORDER BY t.bus_id');
    $routes = GbaDb::all("SELECT route, COUNT(*) AS trips FROM $table WHERE route IS NOT NULL GROUP BY route ORDER BY trips DESC");
    return [
        'min_date' => $range['min_date'],
        'max_date' => $range['max_date'],
        'trips'    => (int) $range['trips'],
        'buses'    => array_map(fn ($b) => ['bus_id' => (int) $b['bus_id'], 'label' => (string) $b['label'], 'energy' => $b['energy'], 'model' => $b['model']], $buses),
        'routes'   => array_column($routes, 'route'),
        'issues'   => array_map(fn ($i) => ['code' => $i[0], 'label' => $i[1], 'severity' => $i[2]], ptIssueRules()),
        'thresholds' => [
            'max_trip_km' => PT_MAX_TRIP_KM, 'high_kwh_per_100km' => PT_HIGH_KWH_PER_100KM,
            'high_kg_per_100km' => PT_HIGH_KG_PER_100KM, 'low_end_soc' => PT_LOW_END_SOC, 'low_start_soc' => PT_LOW_START_SOC,
        ],
    ];
});

// Everything the Operations dashboard shows for a filter: KPIs, daily trend, per bus, per route, exceptions.
$router->get('/pt/operations', function (Request $r) {
    Auth::requirePtModule($r, ptOpsModule($r), 'view');
    [$where, $params] = ptTripFilter($r);
    $e = PT_ENERGY;
    $v = PT_VALID;
    // Consumption = energy ÷ distance over trips that have an energy figure (not an average of per-trip ratios).
    $consumption = "SUM(CASE WHEN $v THEN t.energy_used END) / NULLIF(SUM(CASE WHEN $v AND t.energy_used IS NOT NULL THEN t.distance END), 0) * 100";

    $totals = GbaDb::one(
        "SELECT COUNT(*) AS trips, COUNT(DISTINCT t.bus_id) AS buses, COUNT(DISTINCT t.driver_id) AS drivers,
                COUNT(DISTINCT t.date) AS days, SUM(CASE WHEN $v THEN t.distance END) AS distance, SUM(NOT $v) AS excluded,
                AVG(t.soc_drop) AS avg_soc_drop, MIN(t.end_soc) AS min_end_soc, MAX(CASE WHEN $v THEN t.distance END) AS longest
           " . ptFrom($r) . " WHERE $where",
        $params,
    );
    $byEnergy = [];
    foreach (GbaDb::all(
        "SELECT $e AS energy, COUNT(*) AS trips, COUNT(DISTINCT t.bus_id) AS buses, SUM(CASE WHEN $v THEN t.distance END) AS distance,
                SUM(CASE WHEN $v THEN t.energy_used END) AS energy_used, $consumption AS consumption
           " . ptFrom($r) . " WHERE $where GROUP BY energy ORDER BY trips DESC",
        $params,
    ) as $row) {
        $byEnergy[] = [
            'energy' => $row['energy'], 'unit' => $row['energy'] === 'Hydrogen' ? 'kg' : 'kWh',
            'trips' => (int) $row['trips'], 'buses' => (int) $row['buses'], 'distance' => ptRound($row['distance']),
            'energy_used' => ptRound($row['energy_used']), 'consumption' => ptRound($row['consumption'], 2),
        ];
    }

    $daily = array_map(fn ($d) => [
        'date' => $d['date'], 'trips' => (int) $d['trips'], 'buses' => (int) $d['buses'], 'distance' => ptRound($d['distance']) ?? 0.0,
        'electric_kwh' => ptRound($d['electric_kwh']), 'hydrogen_kg' => ptRound($d['hydrogen_kg'], 2),
        'electric_per_100km' => ptRound($d['electric_cons'], 2), 'hydrogen_per_100km' => ptRound($d['hydrogen_cons'], 2),
    ], GbaDb::all(
        "SELECT t.date, COUNT(*) AS trips, COUNT(DISTINCT t.bus_id) AS buses, SUM(CASE WHEN $v THEN t.distance END) AS distance,
                SUM(CASE WHEN $v AND $e = 'Electric' THEN t.energy_used END) AS electric_kwh,
                SUM(CASE WHEN $v AND $e = 'Hydrogen' THEN t.energy_used END) AS hydrogen_kg,
                SUM(CASE WHEN $v AND $e = 'Electric' THEN t.energy_used END)
                  / NULLIF(SUM(CASE WHEN $v AND $e = 'Electric' AND t.energy_used IS NOT NULL THEN t.distance END), 0) * 100 AS electric_cons,
                SUM(CASE WHEN $v AND $e = 'Hydrogen' THEN t.energy_used END)
                  / NULLIF(SUM(CASE WHEN $v AND $e = 'Hydrogen' AND t.energy_used IS NOT NULL THEN t.distance END), 0) * 100 AS hydrogen_cons
           " . ptFrom($r) . " WHERE $where GROUP BY t.date ORDER BY t.date",
        $params,
    ));

    $issues = ptIssuesSql();
    $byBus = array_map(fn ($b) => [
        'bus_id' => (int) $b['bus_id'], 'label' => (string) $b['label'], 'model' => $b['model'], 'manufacturer' => $b['manufacturer'], 'energy' => $b['energy'],
        'unit' => $b['energy'] === 'Hydrogen' ? 'kg' : 'kWh', 'trips' => (int) $b['trips'], 'days' => (int) $b['days'],
        'distance' => ptRound($b['distance']) ?? 0.0, 'energy_used' => ptRound($b['energy_used']),
        'consumption' => ptRound($b['consumption'], 2), 'avg_soc_drop' => ptRound($b['avg_soc_drop']),
        'min_end_soc' => ptRound($b['min_end_soc']), 'exceptions' => (int) $b['exceptions'],
    ], GbaDb::all(
        "SELECT t.bus_id, " . ptBusLabel($r) . " AS label, m.model, m.manufacturer, $e AS energy, COUNT(*) AS trips, COUNT(DISTINCT t.date) AS days,
                SUM(CASE WHEN $v THEN t.distance END) AS distance, SUM(CASE WHEN $v THEN t.energy_used END) AS energy_used,
                $consumption AS consumption, AVG(t.soc_drop) AS avg_soc_drop, MIN(t.end_soc) AS min_end_soc,
                SUM($issues IS NOT NULL AND $issues <> 'low_start_soc') AS exceptions
           " . ptFrom($r) . " WHERE $where GROUP BY t.bus_id, label, m.model, m.manufacturer, energy ORDER BY t.bus_id",
        $params,
    ));

    $byRoute = array_map(fn ($x) => [
        'route' => $x['route'], 'trips' => (int) $x['trips'], 'buses' => (int) $x['buses'], 'distance' => ptRound($x['distance']) ?? 0.0,
        'avg_trip_km' => ptRound($x['avg_trip_km']), 'electric_per_100km' => ptRound($x['electric_cons'], 2),
        'hydrogen_per_100km' => ptRound($x['hydrogen_cons'], 2), 'avg_soc_drop' => ptRound($x['avg_soc_drop']),
    ], GbaDb::all(
        "SELECT COALESCE(t.route, '(none)') AS route, COUNT(*) AS trips, COUNT(DISTINCT t.bus_id) AS buses,
                SUM(CASE WHEN $v THEN t.distance END) AS distance, AVG(CASE WHEN $v THEN t.distance END) AS avg_trip_km,
                SUM(CASE WHEN $v AND $e = 'Electric' THEN t.energy_used END)
                  / NULLIF(SUM(CASE WHEN $v AND $e = 'Electric' AND t.energy_used IS NOT NULL THEN t.distance END), 0) * 100 AS electric_cons,
                SUM(CASE WHEN $v AND $e = 'Hydrogen' THEN t.energy_used END)
                  / NULLIF(SUM(CASE WHEN $v AND $e = 'Hydrogen' AND t.energy_used IS NOT NULL THEN t.distance END), 0) * 100 AS hydrogen_cons,
                AVG(t.soc_drop) AS avg_soc_drop
           " . ptFrom($r) . " WHERE $where GROUP BY route ORDER BY trips DESC",
        $params,
    ));

    $counts = [];
    foreach (ptIssueRules() as [$code, $label, $severity, $cond]) {
        $counts[$code] = 0;
    }
    $sums = implode(', ', array_map(fn ($rule) => "SUM({$rule[3]}) AS `{$rule[0]}`", ptIssueRules()));
    foreach (GbaDb::one('SELECT ' . $sums . ' ' . ptFrom($r) . " WHERE $where", $params) ?? [] as $code => $n) {
        $counts[$code] = (int) $n;
    }

    // Which buses each exception type comes from (most affected first), for the chart's hover.
    $exceptionBuses = [];
    foreach (ptIssueRules() as [$code, , , $cond]) {
        $exceptionBuses[$code] = array_map(fn ($b) => ['bus_id' => (int) $b['bus_id'], 'label' => (string) $b['label'], 'trips' => (int) $b['trips']], GbaDb::all(
            'SELECT t.bus_id, ' . ptBusLabel($r) . ' AS label, COUNT(*) AS trips ' . ptFrom($r) . " WHERE $where AND $cond AND t.bus_id IS NOT NULL
              GROUP BY t.bus_id, label ORDER BY trips DESC, t.bus_id",
            $params,
        ));
    }

    // SOC drop distribution (10-point bands) for valid trips.
    $socBands = array_map(fn ($x) => ['band' => (int) $x['band'], 'trips' => (int) $x['trips']], GbaDb::all(
        "SELECT LEAST(FLOOR(t.soc_drop / 10) * 10, 90) AS band, COUNT(*) AS trips " . ptFrom($r) . "
          WHERE $where AND $v AND t.soc_drop >= 0 GROUP BY band ORDER BY band",
        $params,
    ));

    return [
        'totals' => [
            'trips' => (int) $totals['trips'], 'buses' => (int) $totals['buses'], 'drivers' => (int) $totals['drivers'],
            'days' => (int) $totals['days'], 'distance' => ptRound($totals['distance']) ?? 0.0,
            'excluded_trips' => (int) $totals['excluded'], 'avg_soc_drop' => ptRound($totals['avg_soc_drop']),
            'min_end_soc' => ptRound($totals['min_end_soc']), 'longest_trip' => ptRound($totals['longest']),
        ],
        'by_energy' => $byEnergy,
        'daily' => $daily,
        'by_bus' => $byBus,
        'by_route' => $byRoute,
        'exceptions' => $counts,
        'exception_buses' => $exceptionBuses,
        'soc_drop_bands' => $socBands,
    ];
});

// Trip list for the filters, optionally only trips with a given issue (or any issue: issue=any). Newest first.
$router->get('/pt/trips', function (Request $r) {
    Auth::requirePtModule($r, ptOpsModule($r), 'view');
    [$where, $params] = ptTripFilter($r);
    $issue = (string) $r->query('issue', '');
    if ($issue === 'any') {
        $where .= ' AND (' . implode(' OR ', array_map(fn ($x) => $x[3], array_filter(ptIssueRules(), fn ($x) => $x[0] !== 'low_start_soc'))) . ')';
    } elseif ($issue !== '') {
        $rule = array_values(array_filter(ptIssueRules(), fn ($x) => $x[0] === $issue))[0] ?? null;
        if ($rule === null) {
            throw new HttpException(422, 'Unknown issue type');
        }
        $where .= " AND {$rule[3]}";
    }
    $limit = max(1, min(1000, (int) $r->query('limit', 200)));
    $offset = max(0, (int) $r->query('offset', 0));
    $total = (int) GbaDb::one('SELECT COUNT(*) AS n ' . ptFrom($r) . " WHERE $where", $params)['n'];
    $rows = GbaDb::all(
        'SELECT t.trip_id, t.date, t.driver_id, t.bus_id, ' . ptBusLabel($r) . ' AS bus_label, t.route, t.start_time, t.end_time, t.start_km, t.end_km, t.start_soc,
                t.end_soc, t.distance, t.soc_drop, t.energy_used, t.energy_consumption, ' . PT_ENERGY . ' AS energy, ' . ptIssuesSql() . " AS issues
           " . ptFrom($r) . " WHERE $where ORDER BY t.date DESC, t.bus_id, t.start_time LIMIT $limit OFFSET $offset",
        $params,
    );
    foreach ($rows as &$t) {
        foreach (['trip_id', 'driver_id', 'bus_id'] as $k) {
            $t[$k] = $t[$k] === null ? null : (int) $t[$k];
        }
        foreach (['start_km', 'end_km', 'start_soc', 'end_soc', 'distance', 'soc_drop'] as $k) {
            $t[$k] = $t[$k] === null ? null : (float) $t[$k];
        }
        $t['energy_used'] = ptRound($t['energy_used'], 2);
        $t['energy_consumption'] = ptRound($t['energy_consumption'], 2);
        $t['issues'] = $t['issues'] ? explode(',', $t['issues']) : [];
    }
    unset($t);
    return ['total' => $total, 'rows' => $rows];
});

// --- Add (edit) ---------------------------------------------------------------

// Multipart: file (.csv or .xlsx), action=preview|import, date_order=dmy|mdy (optional; detected from the file).
// Trials: dataset=trial and trial=ID; the Bus ID column is then optional (every row is the trial's bus).
$router->post('/pt/trips/upload', function (Request $r) {
    Auth::requirePtModule($r, ptOpsModule($r), 'add');
    $file = $_FILES['file'] ?? null;
    if ($file === null || $file['error'] !== UPLOAD_ERR_OK) {
        throw new HttpException(422, 'No file uploaded' . ($file ? " (upload error {$file['error']})" : ''));
    }
    $action = (string) $r->input('action', 'preview');
    $trial = ptTrialContext($r);
    $table = TripLog::readFile($file['tmp_name'], $file['name'], $trial === null);
    $dateOrder = (string) $r->input('date_order', '');
    $detected = TripLog::detectDateOrder($table['rows']);
    $dateOrder = in_array($dateOrder, ['dmy', 'mdy'], true) ? $dateOrder : $detected;

    $log = new TripLog($trial);
    $rows = [];
    $skipped = [];
    foreach ($table['rows'] as $i => $raw) {
        [$row, $reason] = $log->normalize($raw, $dateOrder);
        if ($row === null) {
            $skipped[] = ['line' => $i + 2, 'reason' => $reason]; // +1 header, +1 one-based
        } else {
            $rows[] = $row;
        }
    }
    $dates = array_count_values(array_column($rows, 'date'));
    ksort($dates);
    $unknownBuses = array_values(array_unique(array_column(array_filter($rows, fn ($x) => !$x['in_fleet']), 'bus_id')));
    sort($unknownBuses);
    $summary = [
        'file' => $file['name'],
        'rows' => count($rows),
        'skipped' => count($skipped),
        'skipped_examples' => array_slice($skipped, 0, 20),
        'date_order' => $dateOrder,
        'date_order_detected' => $detected,
        'first_date' => array_key_first($dates),
        'last_date' => array_key_last($dates),
        'days' => count($dates),
        'unknown_buses' => $unknownBuses,
        'extra_columns' => $trial === null ? array_values(array_filter(array_diff($table['headers'], TripLog::REQUIRED))) : [],
    ];
    if ($action === 'import') {
        if (!$rows) {
            throw new HttpException(422, 'No readable trips in the file');
        }
        return $summary + $log->save($rows, $file['name']);
    }
    $classified = $log->classify($rows);
    $preview = array_map(function ($row, $status) {
        unset($row['row_hash'], $row['extra_data'], $row['in_fleet']);
        return $row + ['status' => $status];
    }, array_slice($rows, 0, 25), array_slice($classified['status'], 0, 25));
    unset($classified['status']);
    return $summary + ['would' => $classified, 'preview' => $preview];
});

// Manual entry. Body: {date, driver_id, bus_id, route, trips: [{start_time, end_time, start_km, end_km, start_soc, end_soc, route?}]}.
// Trials: {dataset: "trial", trial: ID, ...} and bus_id may be left out.
$router->post('/pt/trips', function (Request $r) {
    Auth::requirePtModule($r, ptOpsModule($r), 'add');
    $trips = $r->input('trips');
    if (!is_array($trips) || !$trips || count($trips) > 50) {
        throw new HttpException(422, 'Give between 1 and 50 trips');
    }
    $log = new TripLog(ptTrialContext($r));
    $rows = [];
    foreach (array_values($trips) as $i => $t) {
        [$row, $reason] = $log->normalize([
            'date' => $r->input('date'), 'driverid' => $r->input('driver_id'), 'busid' => $r->input('bus_id'),
            'route' => $t['route'] ?? $r->input('route'), 'starttime' => $t['start_time'] ?? null, 'endtime' => $t['end_time'] ?? null,
            'startkm' => $t['start_km'] ?? null, 'endkm' => $t['end_km'] ?? null, 'startsoc' => $t['start_soc'] ?? null, 'endsoc' => $t['end_soc'] ?? null,
        ]);
        if ($row === null) {
            throw new HttpException(422, 'Trip ' . ($i + 1) . ": {$reason}");
        }
        if ($row['distance'] <= 0) {
            throw new HttpException(422, 'Trip ' . ($i + 1) . ': end km must be more than start km');
        }
        $rows[] = $row;
    }
    return $log->save($rows, 'manual entry');
});

// --- Conflicting duplicates ------------------------------------------------------

// Uploaded trips whose key matched an existing trip with different values, with the existing trip beside them.
$router->get('/pt/trips/duplicates', function (Request $r) {
    Auth::requirePtModule($r, 'operations', 'view');
    $rows = GbaDb::all(
        'SELECT d.id, d.entry_key, d.incoming_data, d.source_file, d.detected_at, t.trip_id, t.date, t.driver_id, t.bus_id, t.route,
                t.start_time, t.end_time, t.start_km, t.end_km, t.start_soc, t.end_soc
           FROM triplog_duplicates d LEFT JOIN triplog_db t ON t.entry_key = d.entry_key
          ORDER BY d.detected_at DESC, d.id DESC LIMIT 500',
    );
    return array_map(function ($d) {
        $existing = $d['trip_id'] === null ? null : array_intersect_key($d, array_flip(
            ['trip_id', 'date', 'driver_id', 'bus_id', 'route', 'start_time', 'end_time', 'start_km', 'end_km', 'start_soc', 'end_soc']));
        return ['id' => (int) $d['id'], 'entry_key' => $d['entry_key'], 'source_file' => $d['source_file'], 'detected_at' => $d['detected_at'],
            'incoming' => json_decode($d['incoming_data'], true), 'existing' => $existing];
    }, $rows);
});

// Body: {action: "keep" (discard the incoming values) | "replace" (overwrite the existing trip with them)}.
$router->post('/pt/trips/duplicates/{id}', function (Request $r) {
    Auth::requirePtModule($r, 'operations', 'manage');
    $d = GbaDb::one('SELECT * FROM triplog_duplicates WHERE id = ?', [(int) $r->params['id']]);
    if ($d === null) {
        throw new HttpException(404, 'Duplicate not found');
    }
    $action = (string) $r->input('action', '');
    if (!in_array($action, ['keep', 'replace'], true)) {
        throw new HttpException(422, 'action must be keep or replace');
    }
    $pdo = GbaDb::pdo();
    $pdo->beginTransaction();
    try {
        if ($action === 'replace') {
            $in = json_decode($d['incoming_data'], true);
            // Older rows (manual entries from the original app) don't have the full normalised trip.
            if (!is_array($in) || !isset($in['row_hash'], $in['distance'])) {
                throw new HttpException(422, 'This duplicate was saved by the original app without full trip data; enter the trip again instead');
            }
            GbaDb::run(
                'UPDATE triplog_db SET date = ?, driver_id = ?, bus_id = ?, route = ?, start_time = ?, end_time = ?, start_km = ?, end_km = ?,
                        start_soc = ?, end_soc = ?, distance = ?, soc_drop = ?, energy_used = ?, energy_consumption = ?, row_hash = ?
                  WHERE entry_key = ?',
                [$in['date'], $in['driver_id'], $in['bus_id'], $in['route'], $in['start_time'], $in['end_time'], $in['start_km'],
                 $in['end_km'], $in['start_soc'], $in['end_soc'], $in['distance'], $in['soc_drop'], $in['energy_used'],
                 $in['energy_consumption'], $in['row_hash'], $d['entry_key']],
            );
        }
        GbaDb::run('DELETE FROM triplog_duplicates WHERE id = ?', [$d['id']]);
        $pdo->commit();
    } catch (\Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
    return ['ok' => true];
});
