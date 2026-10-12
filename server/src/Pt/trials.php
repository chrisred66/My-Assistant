<?php

declare(strict_types=1);

/**
 * PT Management: Trials. A trial bus (trial_fleet_db) is a bus on loan for evaluation, with a model from model_db;
 * a trial (trial_db) runs one trial bus on a route for a period. Trial trips (trial_triplog_db) are analysed with
 * the Operations endpoints using dataset=trial (see operations.php).
 * view: read; edit: add trials and trial buses, change status, promote a trial bus into the fleet.
 */

/** @var ChrisManager\Router $router */

use ChrisManager\Auth;
use ChrisManager\HttpException;
use ChrisManager\Pt\GbaDb;
use ChrisManager\Request;

const PT_TRIAL_STATUSES = ['planned', 'in_progress', 'completed'];

function ptDate(mixed $v, bool $required): ?string
{
    $v = trim((string) $v);
    if ($v === '' && !$required) {
        return null;
    }
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $v) || !checkdate((int) substr($v, 5, 2), (int) substr($v, 8, 2), (int) substr($v, 0, 4))) {
        throw new HttpException(422, 'Dates must be YYYY-MM-DD');
    }
    return $v;
}

// Trials with their bus, model and trip figures, newest first.
$router->get('/pt/trials', function (Request $r) {
    Auth::requirePtModule($r, 'planning', 'view');
    return array_map(fn ($t) => [
        'trial_id' => (int) $t['trial_id'], 'trial_name' => $t['trial_name'], 'trial_bus_id' => $t['trial_bus_id'] === null ? null : (int) $t['trial_bus_id'],
        'bus_label' => $t['bus_label'], 'model' => $t['model'], 'manufacturer' => $t['manufacturer'], 'route' => $t['route'],
        'start_date' => $t['start_date'], 'end_date' => $t['end_date'], 'load_condition' => $t['load_condition'], 'status' => $t['status'],
        'notes' => $t['notes'], 'created_at' => $t['created_at'], 'trips' => (int) $t['trips'], 'distance' => round((float) $t['distance'], 1),
        'first_trip' => $t['first_trip'], 'last_trip' => $t['last_trip'],
    ], GbaDb::all(
        'SELECT t.*, tf.bus_id AS bus_label, m.model, m.manufacturer,
                COUNT(tt.id) AS trips, COALESCE(SUM(CASE WHEN tt.distance > 0 THEN tt.distance END), 0) AS distance,
                MIN(tt.date) AS first_trip, MAX(tt.date) AS last_trip
           FROM trial_db t
           LEFT JOIN trial_fleet_db tf ON tf.trial_bus_id = t.trial_bus_id
           LEFT JOIN model_db m ON m.model_id = tf.model_id
           LEFT JOIN trial_triplog_db tt ON tt.trial_id = t.trial_id
          GROUP BY t.trial_id ORDER BY t.created_at DESC, t.trial_id DESC',
    ));
});

// Body: {trial_name, trial_bus_id, route?, start_date, end_date?, load_condition?, notes?}.
$router->post('/pt/trials', function (Request $r) {
    $user = Auth::requirePtModule($r, 'planning', 'add');
    $name = trim((string) $r->input('trial_name', ''));
    $busId = (int) $r->input('trial_bus_id', 0);
    if ($name === '') {
        throw new HttpException(422, 'Give the trial a name');
    }
    if (!GbaDb::one('SELECT 1 FROM trial_fleet_db WHERE trial_bus_id = ?', [$busId])) {
        throw new HttpException(422, 'Choose a trial bus (add one first if needed)');
    }
    $start = ptDate($r->input('start_date'), true);
    $end = ptDate($r->input('end_date'), false);
    if ($end !== null && $end < $start) {
        throw new HttpException(422, 'The end date is before the start date');
    }
    GbaDb::run(
        'INSERT INTO trial_db (trial_name, trial_bus_id, route, start_date, end_date, load_condition, notes, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [mb_substr($name, 0, 255), $busId, trim((string) $r->input('route', '')) ?: null, $start, $end,
         trim((string) $r->input('load_condition', '')) ?: null, trim((string) $r->input('notes', '')) ?: null,
         $start <= date('Y-m-d') ? 'in_progress' : 'planned', $user['id']],
    );
    return ['trial_id' => (int) GbaDb::pdo()->lastInsertId()];
});

// Body: any of {status, end_date, route, load_condition, notes}.
$router->post('/pt/trials/{id}', function (Request $r) {
    Auth::requirePtModule($r, 'planning', 'manage');
    $id = (int) $r->params['id'];
    $trial = GbaDb::one('SELECT * FROM trial_db WHERE trial_id = ?', [$id]);
    if ($trial === null) {
        throw new HttpException(404, 'Trial not found');
    }
    $set = [];
    if (($status = $r->input('status')) !== null) {
        if (!in_array($status, PT_TRIAL_STATUSES, true)) {
            throw new HttpException(422, 'Status must be planned, in_progress or completed');
        }
        $set['status'] = $status;
        // Completing a trial without an end date closes it today (or on its last trip, if later).
        if ($status === 'completed' && $trial['end_date'] === null && $r->input('end_date') === null) {
            $last = GbaDb::one('SELECT MAX(date) AS d FROM trial_triplog_db WHERE trial_id = ?', [$id])['d'];
            $set['end_date'] = max(date('Y-m-d'), (string) $last);
        }
    }
    if ($r->input('end_date') !== null) {
        $set['end_date'] = ptDate($r->input('end_date'), false);
        if ($set['end_date'] !== null && $set['end_date'] < $trial['start_date']) {
            throw new HttpException(422, 'The end date is before the start date');
        }
    }
    foreach (['route', 'load_condition', 'notes'] as $k) {
        if ($r->input($k) !== null) {
            $set[$k] = trim((string) $r->input($k)) ?: null;
        }
    }
    if ($set) {
        GbaDb::run('UPDATE trial_db SET ' . implode(', ', array_map(fn ($k) => "$k = ?", array_keys($set))) . ' WHERE trial_id = ?',
            [...array_values($set), $id]);
    }
    return ['ok' => true];
});

// Trial buses with their model and how much they've been trialled.
$router->get('/pt/trial-buses', function (Request $r) {
    Auth::requirePtModule($r, 'planning', 'view');
    return array_map(fn ($b) => [
        'trial_bus_id' => (int) $b['trial_bus_id'], 'bus_id' => $b['bus_id'], 'model_id' => $b['model_id'], 'model' => $b['model'],
        'model_year' => $b['model_year'] === null ? null : (int) $b['model_year'], 'manufacturer' => $b['manufacturer_name'] ?? $b['manufacturer'],
        'energy_source' => $b['energy_source'], 'bus_length' => $b['bus_length'] === null ? null : (float) $b['bus_length'],
        'bus_type' => $b['bus_type'], 'status' => $b['status'], 'notes' => $b['notes'],
        'promoted_to_bus_id' => $b['promoted_to_bus_id'] === null ? null : (int) $b['promoted_to_bus_id'],
        'trials' => (int) $b['trials'], 'trips' => (int) $b['trips'], 'created_at' => $b['created_at'],
    ], GbaDb::all(
        'SELECT tf.*, m.model, m.model_year, m.energy_source, m.bus_length, m.bus_type, mf.display_name AS manufacturer_name,
                (SELECT COUNT(*) FROM trial_db t WHERE t.trial_bus_id = tf.trial_bus_id) AS trials,
                (SELECT COUNT(*) FROM trial_triplog_db tt WHERE tt.trial_bus_id = tf.trial_bus_id) AS trips
           FROM trial_fleet_db tf
           LEFT JOIN model_db m ON m.model_id = tf.model_id
           LEFT JOIN manufacturer_db mf ON mf.manufacturer = m.manufacturer
          ORDER BY tf.created_at DESC, tf.trial_bus_id DESC',
    ));
});

// Body: {bus_id (the bus's own label, e.g. its plate or the vendor's number), model_id, notes?}.
$router->post('/pt/trial-buses', function (Request $r) {
    Auth::requirePtModule($r, 'planning', 'add');
    $label = trim((string) $r->input('bus_id', ''));
    if ($label === '' || mb_strlen($label) > 50) {
        throw new HttpException(422, 'Give the trial bus a label (up to 50 characters), e.g. its plate or the vendor\'s number');
    }
    $model = GbaDb::one('SELECT model_id, manufacturer FROM model_db WHERE model_id = ?', [(string) $r->input('model_id', '')]);
    if ($model === null) {
        throw new HttpException(422, 'Choose the bus model (add it in Fleet first if it\'s new)');
    }
    if (GbaDb::one("SELECT 1 FROM trial_fleet_db WHERE bus_id = ? AND status <> 'promoted'", [$label])) {
        throw new HttpException(409, 'A trial bus with that label already exists');
    }
    GbaDb::run('INSERT INTO trial_fleet_db (bus_id, manufacturer, model_id, notes) VALUES (?, ?, ?, ?)',
        [$label, $model['manufacturer'], $model['model_id'], trim((string) $r->input('notes', '')) ?: null]);
    return ['trial_bus_id' => (int) GbaDb::pdo()->lastInsertId()];
});

// Moves a trial bus into the fleet. Body: {fleet_bus_id (number used in trip logs), plate?}. Its trial trips stay with the trial.
$router->post('/pt/trial-buses/{id}/promote', function (Request $r) {
    Auth::requirePtModule($r, 'planning', 'manage');
    $bus = GbaDb::one('SELECT * FROM trial_fleet_db WHERE trial_bus_id = ?', [(int) $r->params['id']]);
    if ($bus === null) {
        throw new HttpException(404, 'Trial bus not found');
    }
    if ($bus['status'] === 'promoted') {
        throw new HttpException(409, "Already in the fleet as bus {$bus['promoted_to_bus_id']}");
    }
    if ($bus['model_id'] === null || !GbaDb::one('SELECT 1 FROM model_db WHERE model_id = ?', [$bus['model_id']])) {
        throw new HttpException(422, 'This trial bus has no model in the fleet list');
    }
    $fleetId = (int) $r->input('fleet_bus_id', 0);
    if ($fleetId < 1) {
        throw new HttpException(422, 'Give the fleet bus number (as used in trip logs)');
    }
    if (GbaDb::one('SELECT 1 FROM fleet_db WHERE bus_id = ?', [$fleetId])) {
        throw new HttpException(409, "Bus {$fleetId} is already in the fleet");
    }
    $pdo = GbaDb::pdo();
    $pdo->beginTransaction();
    try {
        GbaDb::run('INSERT INTO fleet_db (bus_id, model_id, plate) VALUES (?, ?, ?)', [$fleetId, $bus['model_id'], trim((string) $r->input('plate', ''))]);
        GbaDb::run("UPDATE trial_fleet_db SET status = 'promoted', promoted_to_bus_id = ? WHERE trial_bus_id = ?", [$fleetId, $bus['trial_bus_id']]);
        $pdo->commit();
    } catch (\Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
    return ['bus_id' => $fleetId];
});
