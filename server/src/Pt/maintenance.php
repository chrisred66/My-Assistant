<?php

declare(strict_types=1);

/**
 * PT Management: Repair & Maintenance (new; tables from gba-migrations/002_maintenance.sql).
 * Work orders (maintenance_db) per fleet bus, and preventive plans (maintenance_plan_db) whose due dates come from
 * the last completed work order for that plan and the bus's latest odometer reading in the trip logs.
 * A work order is created first (open) and closed later, when the workshop reports back: closing sets the closing
 * date (completed_date) and the outcome, and is when downtime, labour and costs are usually known.
 * view: read; edit: add and update work orders and plans; admin: delete them.
 */

/** @var ChrisManager\Router $router */

use ChrisManager\Auth;
use ChrisManager\Env;
use ChrisManager\HttpException;
use ChrisManager\Pt\GbaDb;
use ChrisManager\Pt\MaintImport;
use ChrisManager\Pt\TripLog;
use ChrisManager\Request;

const PT_MAINT_TYPES = ['preventive', 'corrective', 'breakdown', 'inspection', 'accident', 'warranty'];
const PT_MAINT_STATUSES = ['open', 'in_progress', 'waiting_parts', 'completed', 'cancelled'];
const PT_MAINT_PRIORITIES = ['low', 'normal', 'high', 'critical'];
const PT_MAINT_CATEGORIES = [
    'battery' => 'Battery & high voltage', 'drivetrain' => 'Motor & drivetrain', 'fuel_cell' => 'Fuel cell & hydrogen',
    'charging' => 'Charging port & on-board charger', 'brakes' => 'Brakes', 'tyres' => 'Tyres & wheels',
    'suspension' => 'Suspension & steering', 'hvac' => 'Air conditioning', 'electrical' => 'Low-voltage electrical',
    'body' => 'Body, glass & interior', 'doors' => 'Doors & ramps', 'its' => 'ITS, cameras & ticketing', 'general' => 'General / other',
];
const PT_MAINT_CLOSED = ['completed', 'cancelled'];
const PT_DUE_SOON_KM = 1000;  // a plan is "due soon" within this distance…
const PT_DUE_SOON_DAYS = 14;  // …or this many days

/** Latest odometer reading per fleet bus (highest end km in its trip logs) and the date of that trip. */
function ptOdometers(): array
{
    $out = [];
    foreach (GbaDb::all('SELECT bus_id, MAX(end_km) AS km, MAX(date) AS last_trip FROM triplog_db WHERE bus_id IS NOT NULL AND end_km IS NOT NULL GROUP BY bus_id') as $r) {
        $out[(int) $r['bus_id']] = ['km' => (float) $r['km'], 'last_trip' => $r['last_trip']];
    }
    return $out;
}

/** Validated work-order fields from the body; $partial allows leaving fields out (updates). */
function ptMaintFields(Request $r, bool $partial): array
{
    $f = [];
    $has = fn (string $k) => $r->input($k) !== null;
    if (!$partial || $has('bus_id')) {
        $bus = (int) $r->input('bus_id', 0);
        if (!GbaDb::one('SELECT 1 FROM fleet_db WHERE bus_id = ?', [$bus])) {
            throw new HttpException(422, 'Choose a bus from the fleet');
        }
        $f['bus_id'] = $bus;
    }
    foreach (['type' => PT_MAINT_TYPES, 'status' => PT_MAINT_STATUSES, 'priority' => PT_MAINT_PRIORITIES] as $k => $allowed) {
        if ($has($k) || (!$partial && $k === 'type')) {
            $v = (string) $r->input($k, '');
            if (!in_array($v, $allowed, true)) {
                throw new HttpException(422, "$k must be one of: " . implode(', ', $allowed));
            }
            $f[$k] = $v;
        }
    }
    if ($has('category') || !$partial) {
        $c = (string) $r->input('category', 'general');
        if (!isset(PT_MAINT_CATEGORIES[$c])) {
            throw new HttpException(422, 'Unknown category');
        }
        $f['category'] = $c;
    }
    if ($has('title') || !$partial) {
        $t = trim((string) $r->input('title', ''));
        if ($t === '') {
            throw new HttpException(422, 'Describe the work in a few words (title)');
        }
        $f['title'] = mb_substr($t, 0, 255);
    }
    foreach (['description', 'closing_note'] as $k) {
        if ($has($k)) {
            $f[$k] = trim((string) $r->input($k)) ?: null;
        }
    }
    // The workshop is one of the manufacturers (they service their own buses); stored by display name.
    if ($has('workshop')) {
        $w = trim((string) $r->input('workshop'));
        if ($w === '') {
            $f['workshop'] = null;
        } else {
            $row = GbaDb::one('SELECT display_name FROM manufacturer_db WHERE display_name = ? OR manufacturer = ?', [$w, $w]);
            if ($row === null) {
                throw new HttpException(422, 'Choose the workshop from the list of manufacturers');
            }
            $f['workshop'] = $row['display_name'];
        }
    }
    foreach (['reported_date', 'completed_date'] as $k) {
        if ($has($k) || (!$partial && $k === 'reported_date')) {
            $v = trim((string) $r->input($k, ''));
            if ($v === '' && $k === 'completed_date') {
                $f[$k] = null;
                continue;
            }
            if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $v)) {
                throw new HttpException(422, "$k must be a date (YYYY-MM-DD)");
            }
            $f[$k] = $v;
        }
    }
    foreach (['odometer_km', 'downtime_hours', 'labour_hours', 'parts_cost', 'labour_cost'] as $k) {
        if ($has($k)) {
            $v = $r->input($k);
            if ($v === '' ) {
                $f[$k] = null;
            } elseif (!is_numeric($v) || (float) $v < 0) {
                throw new HttpException(422, "$k must be a number of 0 or more");
            } else {
                $f[$k] = (float) $v;
            }
        }
    }
    if ($has('plan_id')) {
        $p = $r->input('plan_id');
        $f['plan_id'] = ($p === '' || $p === 0) ? null : (int) $p;
        if ($f['plan_id'] !== null && !GbaDb::one('SELECT 1 FROM maintenance_plan_db WHERE plan_id = ?', [$f['plan_id']])) {
            throw new HttpException(422, 'Unknown maintenance plan');
        }
    }
    return $f;
}

function ptMaintRow(array $m): array
{
    foreach (['record_id', 'bus_id'] as $k) {
        $m[$k] = (int) $m[$k];
    }
    $m['plan_id'] = $m['plan_id'] === null ? null : (int) $m['plan_id'];
    foreach (['odometer_km', 'downtime_hours', 'labour_hours', 'parts_cost', 'labour_cost'] as $k) {
        $m[$k] = $m[$k] === null ? null : (float) $m[$k];
    }
    $m['total_cost'] = $m['parts_cost'] === null && $m['labour_cost'] === null ? null : round(($m['parts_cost'] ?? 0) + ($m['labour_cost'] ?? 0), 2);
    return $m;
}

/** Each active plan × each bus it applies to, with when it was last done and when it's next due. */
function ptPlanStatus(): array
{
    $odo = ptOdometers();
    $buses = GbaDb::all('SELECT f.bus_id, f.model_id, m.model FROM fleet_db f JOIN model_db m ON m.model_id = f.model_id ORDER BY f.bus_id');
    $last = [];
    foreach (GbaDb::all(
        "SELECT plan_id, bus_id, MAX(completed_date) AS done, MAX(odometer_km) AS km FROM maintenance_db
          WHERE plan_id IS NOT NULL AND status = 'completed' GROUP BY plan_id, bus_id",
    ) as $l) {
        $last[$l['plan_id'] . '/' . $l['bus_id']] = $l;
    }
    $today = date('Y-m-d');
    $out = [];
    foreach (GbaDb::all('SELECT * FROM maintenance_plan_db WHERE active = 1 ORDER BY name') as $p) {
        foreach ($buses as $b) {
            if ($p['model_id'] !== null && strcasecmp($p['model_id'], $b['model_id']) !== 0) {
                continue;
            }
            $busId = (int) $b['bus_id'];
            $l = $last[$p['plan_id'] . '/' . $busId] ?? null;
            $km = $odo[$busId]['km'] ?? null;
            // Nothing recorded yet: buses were serviced before this system, so there's nothing to count from; the first
            // recorded service (with its odometer reading) starts the clock.
            $dueKm = $p['interval_km'] !== null && $l !== null && $l['km'] !== null ? (float) $l['km'] + (int) $p['interval_km'] : null;
            $dueDate = $p['interval_days'] !== null && $l !== null
                ? date('Y-m-d', strtotime($l['done'] . ' +' . (int) $p['interval_days'] . ' days')) : null;
            $kmLeft = $dueKm !== null && $km !== null ? $dueKm - $km : null;
            $daysLeft = $dueDate !== null ? (int) round((strtotime($dueDate) - strtotime($today)) / 86400) : null;
            $state = match (true) {
                $l === null => 'never_done',
                ($kmLeft !== null && $kmLeft < 0) || ($daysLeft !== null && $daysLeft < 0) => 'overdue',
                ($kmLeft !== null && $kmLeft <= PT_DUE_SOON_KM) || ($daysLeft !== null && $daysLeft <= PT_DUE_SOON_DAYS) => 'due_soon',
                default => 'ok',
            };
            $out[] = [
                'plan_id' => (int) $p['plan_id'], 'plan' => $p['name'], 'category' => $p['category'], 'bus_id' => $busId, 'model' => $b['model'],
                'last_done' => $l['done'] ?? null, 'last_km' => $l === null || $l['km'] === null ? null : (float) $l['km'],
                'odometer_km' => $km, 'due_km' => $dueKm, 'km_left' => $kmLeft === null ? null : round($kmLeft),
                'due_date' => $dueDate, 'days_left' => $daysLeft, 'state' => $state,
            ];
        }
    }
    $rank = ['overdue' => 0, 'due_soon' => 1, 'never_done' => 2, 'ok' => 3];
    usort($out, fn ($a, $b) => [$rank[$a['state']], $a['km_left'] ?? PHP_INT_MAX, $a['days_left'] ?? PHP_INT_MAX, $a['bus_id']]
        <=> [$rank[$b['state']], $b['km_left'] ?? PHP_INT_MAX, $b['days_left'] ?? PHP_INT_MAX, $b['bus_id']]);
    return $out;
}

// --- Read ---------------------------------------------------------------------

// Choices for the forms and filters: fleet buses (with odometer), types, statuses, categories, plans, currency.
$router->get('/pt/maintenance/options', function (Request $r) {
    Auth::requirePtModule($r, 'maintenance', 'view');
    $odo = ptOdometers();
    $range = GbaDb::one('SELECT MIN(reported_date) AS min_date, MAX(reported_date) AS max_date, COUNT(*) AS records FROM maintenance_db');
    return [
        'currency' => Env::get('PT_CURRENCY', 'AED'),
        'buses' => array_map(fn ($b) => [
            'bus_id' => (int) $b['bus_id'], 'model' => $b['model'], 'model_id' => $b['model_id'], 'manufacturer' => $b['display_name'],
            'odometer_km' => $odo[(int) $b['bus_id']]['km'] ?? null, 'last_trip' => $odo[(int) $b['bus_id']]['last_trip'] ?? null,
        ], GbaDb::all('SELECT f.bus_id, f.model_id, m.model, mf.display_name FROM fleet_db f JOIN model_db m ON m.model_id = f.model_id
                         LEFT JOIN manufacturer_db mf ON mf.manufacturer = m.manufacturer ORDER BY f.bus_id')),
        'models' => array_map(fn ($m) => ['model_id' => $m['model_id'], 'label' => "{$m['display_name']} {$m['model']} ({$m['model_year']})"],
            GbaDb::all('SELECT m.model_id, m.model, m.model_year, mf.display_name FROM model_db m LEFT JOIN manufacturer_db mf ON mf.manufacturer = m.manufacturer ORDER BY mf.display_name, m.model')),
        'types' => PT_MAINT_TYPES,
        'statuses' => PT_MAINT_STATUSES,
        'priorities' => PT_MAINT_PRIORITIES,
        'categories' => array_map(fn ($k, $v) => ['code' => $k, 'label' => \ChrisManager\I18n::t($v)], array_keys(PT_MAINT_CATEGORIES), PT_MAINT_CATEGORIES),
        'workshops' => array_column(GbaDb::all('SELECT display_name FROM manufacturer_db ORDER BY display_name'), 'display_name'),
        'plans' => array_map(fn ($p) => ['plan_id' => (int) $p['plan_id'], 'name' => $p['name'], 'model_id' => $p['model_id']],
            GbaDb::all('SELECT plan_id, name, model_id FROM maintenance_plan_db WHERE active = 1 ORDER BY name')),
        'min_date' => $range['min_date'], 'max_date' => $range['max_date'], 'records' => (int) $range['records'],
    ];
});

// Work orders reported in a date range (filters: bus, type, category, status), plus the dashboard figures.
// Open work orders are always included whatever their date, so nothing outstanding drops out of view.
$router->get('/pt/maintenance', function (Request $r) {
    Auth::requirePtModule($r, 'maintenance', 'view');
    $from = (string) $r->query('from', '');
    $to = (string) $r->query('to', '');
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $from) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $to)) {
        throw new HttpException(422, 'from and to must be dates (YYYY-MM-DD)');
    }
    $where = ['1 = 1'];
    $params = [];
    foreach (['bus' => 'm.bus_id', 'type' => 'm.type', 'category' => 'm.category', 'status' => 'm.status'] as $q => $col) {
        if (($v = (string) $r->query($q, '')) !== '') {
            $where[] = "$col = ?";
            $params[] = $q === 'bus' ? (int) $v : $v;
        }
    }
    $w = implode(' AND ', $where);
    $rows = array_map('ptMaintRow', GbaDb::all(
        "SELECT m.*, mo.model, p.name AS plan_name FROM maintenance_db m
           LEFT JOIN fleet_db f ON f.bus_id = m.bus_id LEFT JOIN model_db mo ON mo.model_id = f.model_id
           LEFT JOIN maintenance_plan_db p ON p.plan_id = m.plan_id
          WHERE $w AND (m.reported_date BETWEEN ? AND ? OR m.status IN ('open', 'in_progress', 'waiting_parts'))
          ORDER BY FIELD(m.status, 'open', 'in_progress', 'waiting_parts', 'completed', 'cancelled'),
                   FIELD(m.priority, 'critical', 'high', 'normal', 'low'), m.reported_date DESC, m.record_id DESC",
        [...$params, $from, $to],
    ));
    $inRange = array_values(array_filter($rows, fn ($m) => $m['reported_date'] >= $from && $m['reported_date'] <= $to && $m['status'] !== 'cancelled'));

    // Distance each bus ran in the range (for cost per km and failures per 10,000 km).
    $kmParams = [$from, $to];
    $kmWhere = '';
    if (($bus = (string) $r->query('bus', '')) !== '') {
        $kmWhere = ' AND bus_id = ?';
        $kmParams[] = (int) $bus;
    }
    $km = [];
    foreach (GbaDb::all("SELECT bus_id, SUM(distance) AS km FROM triplog_db WHERE date BETWEEN ? AND ? AND distance > 0 AND distance <= 500$kmWhere GROUP BY bus_id", $kmParams) as $k) {
        $km[(int) $k['bus_id']] = (float) $k['km'];
    }
    $fleetSize = $bus !== '' ? 1 : (int) GbaDb::one('SELECT COUNT(*) AS n FROM fleet_db')['n'];
    $hours = ((strtotime($to) - strtotime($from)) / 86400 + 1) * 24;

    $sum = fn (array $list, string $k) => array_sum(array_map(fn ($m) => $m[$k] ?? 0, $list));
    $failures = array_filter($inRange, fn ($m) => in_array($m['type'], ['corrective', 'breakdown'], true));
    $downtime = $sum($inRange, 'downtime_hours');
    $totalKm = array_sum($km);
    $cost = $sum($inRange, 'total_cost');

    $group = function (callable $key) use ($inRange): array {
        $g = [];
        foreach ($inRange as $m) {
            $k = $key($m);
            $g[$k] ??= ['key' => $k, 'records' => 0, 'cost' => 0.0, 'parts' => 0.0, 'labour' => 0.0, 'downtime_hours' => 0.0, 'failures' => 0];
            $g[$k]['records']++;
            $g[$k]['cost'] += $m['total_cost'] ?? 0;
            $g[$k]['parts'] += $m['parts_cost'] ?? 0;
            $g[$k]['labour'] += $m['labour_cost'] ?? 0;
            $g[$k]['downtime_hours'] += $m['downtime_hours'] ?? 0;
            $g[$k]['failures'] += in_array($m['type'], ['corrective', 'breakdown'], true) ? 1 : 0;
        }
        return $g;
    };
    $byMonth = $group(fn ($m) => substr($m['reported_date'], 0, 7));
    ksort($byMonth);
    $byBus = $group(fn ($m) => $m['bus_id']);
    foreach ($byBus as $b => &$g) {
        $g['km'] = $km[$b] ?? 0.0;
        $g['availability'] = round(max(0, 1 - $g['downtime_hours'] / $hours) * 100, 1);
    }
    unset($g);
    // Repeat failures: the same bus and category failing more than once in the range.
    $repeat = [];
    foreach ($failures as $m) {
        $repeat[$m['bus_id'] . '/' . $m['category']][] = $m['record_id'];
    }
    $repeat = array_values(array_map(fn ($k, $ids) => ['bus_id' => (int) explode('/', $k)[0], 'category' => explode('/', $k)[1], 'count' => count($ids)],
        array_keys(array_filter($repeat, fn ($ids) => count($ids) > 1)), array_filter($repeat, fn ($ids) => count($ids) > 1)));

    return [
        'records' => $rows,
        'totals' => [
            'open' => count(array_filter($rows, fn ($m) => in_array($m['status'], ['open', 'in_progress', 'waiting_parts'], true))),
            'reported' => count($inRange),
            'completed' => count(array_filter($inRange, fn ($m) => $m['status'] === 'completed')),
            'failures' => count($failures),
            'cost' => round($cost, 2), 'parts' => round($sum($inRange, 'parts_cost'), 2), 'labour' => round($sum($inRange, 'labour_cost'), 2),
            'downtime_hours' => round($downtime, 1),
            'availability' => $fleetSize ? round(max(0, 1 - $downtime / ($fleetSize * $hours)) * 100, 1) : null,
            'km' => round($totalKm),
            'cost_per_km' => $totalKm > 0 ? round($cost / $totalKm, 3) : null,
            'failures_per_10k_km' => $totalKm > 0 ? round(count($failures) / $totalKm * 10000, 2) : null,
            'fleet_size' => $fleetSize,
        ],
        'by_month' => array_values($byMonth),
        'by_category' => array_values($group(fn ($m) => $m['category'])),
        'by_type' => array_values($group(fn ($m) => $m['type'])),
        'by_bus' => array_values($byBus),
        'repeat_failures' => $repeat,
    ];
});

// Preventive plans with each bus's due status, most urgent first.
$router->get('/pt/maintenance/plans', function (Request $r) {
    Auth::requirePtModule($r, 'maintenance', 'view');
    return [
        'plans' => array_map(fn ($p) => [
            'plan_id' => (int) $p['plan_id'], 'name' => $p['name'], 'model_id' => $p['model_id'], 'model' => $p['model'],
            'category' => $p['category'], 'interval_km' => $p['interval_km'] === null ? null : (int) $p['interval_km'],
            'interval_days' => $p['interval_days'] === null ? null : (int) $p['interval_days'], 'notes' => $p['notes'], 'active' => (bool) $p['active'],
        ], GbaDb::all('SELECT p.*, m.model FROM maintenance_plan_db p LEFT JOIN model_db m ON m.model_id = p.model_id ORDER BY p.active DESC, p.name')),
        'due' => ptPlanStatus(),
    ];
});

// --- Add / change (edit) --------------------------------------------------------

// Body: {bus_id, type, category, title, reported_date, description?, priority?, status?, completed_date?, odometer_km?,
//        downtime_hours?, labour_hours?, parts_cost?, labour_cost?, workshop?, plan_id?}.
// New work orders are open (or in progress / waiting for parts); they're closed later with /close.
$router->post('/pt/maintenance', function (Request $r) {
    $user = Auth::requirePtModule($r, 'maintenance', 'add');
    $f = ptMaintFields($r, false) + ['created_by' => $user['id']];
    if (in_array($f['status'] ?? 'open', PT_MAINT_CLOSED, true)) {
        throw new HttpException(422, 'Create the work order as open, then close it when the work is done');
    }
    unset($f['completed_date']);
    GbaDb::run('INSERT INTO maintenance_db (' . implode(', ', array_keys($f)) . ') VALUES (' . implode(', ', array_fill(0, count($f), '?')) . ')', array_values($f));
    return ['record_id' => (int) GbaDb::pdo()->lastInsertId()];
});

// Body: {name, category?, model_id? (empty: all buses), interval_km?, interval_days?, notes?}. At least one interval.
$router->post('/pt/maintenance/plans', function (Request $r) {
    Auth::requirePtModule($r, 'maintenance', 'manage');
    $name = trim((string) $r->input('name', ''));
    $category = (string) $r->input('category', 'general');
    $model = trim((string) $r->input('model_id', '')) ?: null;
    $km = $r->input('interval_km');
    $days = $r->input('interval_days');
    $km = ($km === null || $km === '') ? null : (int) $km;
    $days = ($days === null || $days === '') ? null : (int) $days;
    if ($name === '') {
        throw new HttpException(422, 'Give the plan a name, e.g. "A-service" or "Brake inspection"');
    }
    if (!isset(PT_MAINT_CATEGORIES[$category])) {
        throw new HttpException(422, 'Unknown category');
    }
    if ($model !== null && !GbaDb::one('SELECT 1 FROM model_db WHERE model_id = ?', [$model])) {
        throw new HttpException(422, 'Unknown model');
    }
    if (($km === null || $km <= 0) && ($days === null || $days <= 0)) {
        throw new HttpException(422, 'Give an interval in km, in days, or both');
    }
    GbaDb::run('INSERT INTO maintenance_plan_db (name, model_id, category, interval_km, interval_days, notes) VALUES (?, ?, ?, ?, ?, ?)',
        [mb_substr($name, 0, 255), $model, $category, $km > 0 ? $km : null, $days > 0 ? $days : null, trim((string) $r->input('notes', '')) ?: null]);
    return ['plan_id' => (int) GbaDb::pdo()->lastInsertId()];
});

// Access export import. Multipart: file (.xlsx/.csv), action=preview|import, date_order=dmy|mdy (optional),
// columns (JSON field → header; optional: saved or guessed), values (JSON field → {file value → app value}).
// Preview returns the mapping it used, the distinct values to map, and what importing would do.
$router->post('/pt/maintenance/import', function (Request $r) {
    $user = Auth::requirePtModule($r, 'maintenance', 'manage');
    $file = $_FILES['file'] ?? null;
    if ($file === null || $file['error'] !== UPLOAD_ERR_OK) {
        throw new HttpException(422, 'No file uploaded' . ($file ? " (upload error {$file['error']})" : ''));
    }
    [$headers, $rows] = MaintImport::read($file['tmp_name'], $file['name']);
    $signature = MaintImport::signature($headers);
    $saved = GbaDb::one('SELECT columns, `values` FROM maintenance_import_map_db WHERE signature = ?', [$signature]);
    $workshops = array_column(GbaDb::all('SELECT display_name FROM manufacturer_db ORDER BY display_name'), 'display_name');

    $columnsIn = json_decode((string) $r->input('columns', ''), true);
    $columns = is_array($columnsIn)
        ? array_filter($columnsIn, fn ($h, $f) => isset(MaintImport::FIELDS[$f]) && in_array($h, $headers, true), ARRAY_FILTER_USE_BOTH)
        : MaintImport::columnMap($headers, $saved ? json_decode($saved['columns'], true) : null);

    // Value mappings: what was sent, then what was saved; only valid app values are kept.
    $allowed = ['type' => PT_MAINT_TYPES, 'status' => PT_MAINT_STATUSES, 'priority' => PT_MAINT_PRIORITIES,
        'category' => array_keys(PT_MAINT_CATEGORIES), 'workshop' => $workshops];
    $valuesIn = json_decode((string) $r->input('values', ''), true);
    $values = array_replace_recursive($saved ? json_decode($saved['values'], true) ?: [] : [], is_array($valuesIn) ? $valuesIn : []);
    foreach ($values as $f => $map) {
        if (!isset($allowed[$f]) || !is_array($map)) {
            unset($values[$f]);
            continue;
        }
        $values[$f] = array_filter($map, fn ($v) => $v === null || in_array($v, $allowed[$f], true));
    }
    $valueMaps = MaintImport::valueMaps($headers, $rows, $columns, $values, $workshops);
    // Fill in the guesses for values not mapped yet, so the import uses what the preview showed.
    foreach ($valueMaps as $f => $list) {
        foreach ($list as $v) {
            if (!array_key_exists($v['value'], $values[$f] ?? [])) {
                $values[$f][$v['value']] = $v['maps_to'];
            }
        }
    }

    $dateOrder = (string) $r->input('date_order', '');
    $detected = 'mdy';
    if (isset($columns['reported_date'])) {
        $i = array_search($columns['reported_date'], $headers, true);
        $detected = TripLog::detectDateOrder(array_map(fn ($row) => ['date' => $row[$i] ?? null], $rows));
    }
    $dateOrder = in_array($dateOrder, ['dmy', 'mdy'], true) ? $dateOrder : $detected;

    $summary = [
        'file' => $file['name'], 'headers' => $headers, 'total_rows' => count($rows),
        'sample' => array_slice($rows, 0, 3), 'remembered' => $saved !== null,
        'columns' => (object) $columns, 'value_maps' => (object) $valueMaps,
        'date_order' => $dateOrder, 'date_order_detected' => $detected,
        'fields' => array_map(fn ($f, $d) => ['field' => $f, 'label' => \ChrisManager\I18n::t($d[0]), 'required' => $d[1]], array_keys(MaintImport::FIELDS), MaintImport::FIELDS),
    ];
    $missing = array_values(array_diff(['bus_id', 'reported_date', 'title'], array_keys($columns)));
    if ($missing) {
        return $summary + ['ready' => false, 'missing' => $missing];
    }
    [$parsed, $skipped] = MaintImport::normalize($headers, $rows, $columns, $values, $dateOrder);
    $fields = MaintImport::writtenFields($columns);
    $summary += ['ready' => true, 'missing' => [], 'rows' => count($parsed), 'skipped' => count($skipped), 'skipped_examples' => array_slice($skipped, 0, 25)];

    if ((string) $r->input('action', 'preview') === 'import') {
        if (!$parsed) {
            throw new HttpException(422, 'No rows could be read with this mapping');
        }
        $result = MaintImport::save($parsed, $fields, (int) $user['id']);
        GbaDb::run('REPLACE INTO maintenance_import_map_db (signature, headers, columns, `values`) VALUES (?, ?, ?, ?)',
            [$signature, json_encode($headers, JSON_UNESCAPED_UNICODE), json_encode($columns, JSON_UNESCAPED_UNICODE), json_encode($values, JSON_UNESCAPED_UNICODE)]);
        return $summary + $result;
    }
    $status = MaintImport::classify($parsed, $fields);
    $counts = array_count_values($status) + ['new' => 0, 'update' => 0, 'unchanged' => 0];
    $preview = array_map(fn ($row, $st) => $row + ['import_status' => $st], array_slice($parsed, 0, 30), array_slice($status, 0, 30));
    return $summary + ['would' => ['new' => $counts['new'], 'update' => $counts['update'], 'unchanged' => $counts['unchanged']], 'preview' => $preview];
});

// Body: {closed_date, outcome: completed|cancelled, downtime_hours?, labour_hours?, parts_cost?, labour_cost?, closing_note?}.
$router->post('/pt/maintenance/{id}/close', function (Request $r) {
    Auth::requirePtModule($r, 'maintenance', 'manage');
    $id = (int) $r->params['id'];
    $cur = GbaDb::one('SELECT * FROM maintenance_db WHERE record_id = ?', [$id]);
    if ($cur === null) {
        throw new HttpException(404, 'Work order not found');
    }
    $date = trim((string) $r->input('closed_date', ''));
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        throw new HttpException(422, 'Give the closing date');
    }
    if ($date < $cur['reported_date']) {
        throw new HttpException(422, "The closing date is before the work order was reported ({$cur['reported_date']})");
    }
    $outcome = (string) $r->input('outcome', 'completed');
    if (!in_array($outcome, PT_MAINT_CLOSED, true)) {
        throw new HttpException(422, 'Outcome must be completed or cancelled');
    }
    $f = array_intersect_key(ptMaintFields($r, true), array_flip(['downtime_hours', 'labour_hours', 'parts_cost', 'labour_cost', 'closing_note']));
    $f += ['status' => $outcome, 'completed_date' => $date];
    GbaDb::run('UPDATE maintenance_db SET ' . implode(', ', array_map(fn ($k) => "$k = ?", array_keys($f))) . ' WHERE record_id = ?', [...array_values($f), $id]);
    return ['ok' => true];
});

// Back to open (e.g. closed by mistake or the fault came back); keeps costs and notes.
$router->post('/pt/maintenance/{id}/reopen', function (Request $r) {
    Auth::requirePtModule($r, 'maintenance', 'manage');
    $n = GbaDb::run("UPDATE maintenance_db SET status = 'open', completed_date = NULL WHERE record_id = ? AND status IN ('completed', 'cancelled')",
        [(int) $r->params['id']])->rowCount();
    if ($n === 0) {
        throw new HttpException(409, 'Only a closed work order can be reopened');
    }
    return ['ok' => true];
});

// Body: any work-order fields. Closing goes through /close (it needs a closing date); a closed work order's
// closing details can be corrected here.
$router->post('/pt/maintenance/{id}', function (Request $r) {
    Auth::requirePtModule($r, 'maintenance', 'manage');
    $id = (int) $r->params['id'];
    $cur = GbaDb::one('SELECT * FROM maintenance_db WHERE record_id = ?', [$id]);
    if ($cur === null) {
        throw new HttpException(404, 'Work order not found');
    }
    $f = ptMaintFields($r, true);
    $closedNow = in_array($cur['status'], PT_MAINT_CLOSED, true);
    if (isset($f['status']) && in_array($f['status'], PT_MAINT_CLOSED, true) !== $closedNow) {
        throw new HttpException(422, $closedNow ? 'Reopen the work order instead' : 'Close the work order with its closing date instead');
    }
    if (array_key_exists('completed_date', $f) && (!$closedNow || $f['completed_date'] === null)) {
        throw new HttpException(422, 'The closing date is set when closing the work order');
    }
    if ($f) {
        GbaDb::run('UPDATE maintenance_db SET ' . implode(', ', array_map(fn ($k) => "$k = ?", array_keys($f))) . ' WHERE record_id = ?', [...array_values($f), $id]);
    }
    return ['ok' => true];
});

// Body: {active} — pausing a plan hides its due list without losing history.
$router->post('/pt/maintenance/plans/{id}', function (Request $r) {
    Auth::requirePtModule($r, 'maintenance', 'manage');
    $n = GbaDb::run('UPDATE maintenance_plan_db SET active = ? WHERE plan_id = ?', [(bool) $r->input('active', true) ? 1 : 0, (int) $r->params['id']])->rowCount();
    if ($n === 0 && !GbaDb::one('SELECT 1 FROM maintenance_plan_db WHERE plan_id = ?', [(int) $r->params['id']])) {
        throw new HttpException(404, 'Plan not found');
    }
    return ['ok' => true];
});

// --- Delete (admin) ---------------------------------------------------------------

$router->delete('/pt/maintenance/{id}', function (Request $r) {
    Auth::requirePtModule($r, 'maintenance', 'manage');
    if (GbaDb::run('DELETE FROM maintenance_db WHERE record_id = ?', [(int) $r->params['id']])->rowCount() === 0) {
        throw new HttpException(404, 'Work order not found');
    }
    return ['ok' => true];
});

// Only a plan no work order refers to (otherwise pause it).
$router->delete('/pt/maintenance/plans/{id}', function (Request $r) {
    Auth::requirePtModule($r, 'maintenance', 'manage');
    $id = (int) $r->params['id'];
    $used = (int) GbaDb::one('SELECT COUNT(*) AS n FROM maintenance_db WHERE plan_id = ?', [$id])['n'];
    if ($used > 0) {
        throw new HttpException(409, "{$used} work order(s) refer to this plan; pause it instead");
    }
    if (GbaDb::run('DELETE FROM maintenance_plan_db WHERE plan_id = ?', [$id])->rowCount() === 0) {
        throw new HttpException(404, 'Plan not found');
    }
    return ['ok' => true];
});
