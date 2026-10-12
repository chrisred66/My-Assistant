<?php

declare(strict_types=1);

/**
 * PT Management: Fleet (manufacturers → models → buses).
 * view: read; edit: add, set a plate; admin: remove. Removed rows are copied to the removed_* tables first,
 * as the original app did, and trips keep their bus_id.
 */

/** @var ChrisManager\Router $router */

use ChrisManager\Auth;
use ChrisManager\HttpException;
use ChrisManager\Pt\GbaDb;
use ChrisManager\Request;

const PT_ENERGY_SOURCES = ['Electric', 'Hydrogen', 'Hybrid', 'Diesel'];
const PT_MANUFACTURER_CATEGORIES = ['Electric', 'Hydrogen', 'Hybrid', 'Diesel'];

/** Manufacturer row for a {id} route parameter (keys compare case-insensitively, like the original app). */
function ptManufacturer(Request $r): array
{
    $row = GbaDb::one('SELECT manufacturer, display_name, category, created_at FROM manufacturer_db WHERE manufacturer = ?', [rawurldecode($r->params['id'])]);
    if ($row === null) {
        throw new HttpException(404, 'Manufacturer not found');
    }
    return $row;
}

/** Runs $fn in a transaction on the GBA database. */
function ptTransaction(callable $fn): mixed
{
    $pdo = GbaDb::pdo();
    $pdo->beginTransaction();
    try {
        $result = $fn();
        $pdo->commit();
        return $result;
    } catch (\Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
}

// Archive copies. REPLACE: removing something with the same key twice (re-added, then removed again) keeps the latest copy.
const PT_ARCHIVE_BUSES = 'REPLACE INTO removed_bus_db (bus_id, model_id, plate, created_at, updated_at)
    SELECT f.bus_id, f.model_id, f.plate, f.created_at, f.updated_at FROM fleet_db f';
const PT_MODEL_COLUMNS = 'model_id, manufacturer, model, model_year, energy_source, bus_length, bus_width, bus_height, curb_weight,
    axle_count, bus_type, energy_capacity, charging_port_count, one_port_intake, two_port_intake, gvw, created_at, updated_at';

// --- Read ---------------------------------------------------------------------

// Manufacturers with their models (and bus counts), for the Fleet overview.
$router->get('/pt/manufacturers', function (Request $r) {
    Auth::requirePtModule($r, 'planning', 'view');
    $models = GbaDb::all(
        'SELECT m.model_id, m.manufacturer, m.model, m.model_year, m.bus_type, m.bus_length, m.energy_source, m.energy_capacity,
                COUNT(f.bus_id) AS bus_count
           FROM model_db m LEFT JOIN fleet_db f ON f.model_id = m.model_id
          GROUP BY m.model_id ORDER BY m.model, m.model_year',
    );
    $byMaker = [];
    foreach ($models as $m) {
        $m['model_year'] = (int) $m['model_year'];
        $m['bus_length'] = (float) $m['bus_length'];
        $m['energy_capacity'] = (float) $m['energy_capacity'];
        $m['bus_count'] = (int) $m['bus_count'];
        $byMaker[strtolower($m['manufacturer'])][] = $m;
    }
    return array_map(function ($mf) use ($byMaker) {
        $models = $byMaker[strtolower($mf['manufacturer'])] ?? [];
        return $mf + ['models' => $models, 'bus_count' => array_sum(array_column($models, 'bus_count'))];
    }, GbaDb::all('SELECT manufacturer, display_name, category, created_at FROM manufacturer_db ORDER BY category, display_name'));
});

// One manufacturer: full model specs and its buses, with each bus's trip count and last trip date.
$router->get('/pt/manufacturers/{id}', function (Request $r) {
    Auth::requirePtModule($r, 'planning', 'view');
    $mf = ptManufacturer($r);
    $models = GbaDb::all(
        'SELECT m.*, COUNT(f.bus_id) AS bus_count
           FROM model_db m LEFT JOIN fleet_db f ON f.model_id = m.model_id
          WHERE m.manufacturer = ? GROUP BY m.model_id ORDER BY m.model, m.model_year',
        [$mf['manufacturer']],
    );
    $buses = GbaDb::all(
        'SELECT f.bus_id, f.plate, f.model_id, m.model, m.model_year, f.created_at,
                (SELECT COUNT(*) FROM triplog_db t WHERE t.bus_id = f.bus_id) AS trip_count,
                (SELECT MAX(t.date) FROM triplog_db t WHERE t.bus_id = f.bus_id) AS last_trip
           FROM fleet_db f JOIN model_db m ON m.model_id = f.model_id
          WHERE m.manufacturer = ? ORDER BY f.bus_id',
        [$mf['manufacturer']],
    );
    foreach ($models as &$m) {
        foreach (['model_year', 'axle_count', 'charging_port_count', 'one_port_intake', 'two_port_intake', 'bus_count'] as $k) {
            $m[$k] = (int) $m[$k];
        }
        foreach (['bus_length', 'bus_width', 'bus_height', 'curb_weight', 'energy_capacity'] as $k) {
            $m[$k] = (float) $m[$k];
        }
        $m['gvw'] = $m['gvw'] === null ? null : (int) $m['gvw'];
    }
    unset($m);
    foreach ($buses as &$b) {
        $b['bus_id'] = (int) $b['bus_id'];
        $b['model_year'] = (int) $b['model_year'];
        $b['trip_count'] = (int) $b['trip_count'];
    }
    unset($b);
    return $mf + ['models' => $models, 'buses' => $buses];
});

// --- Add (edit) ---------------------------------------------------------------

// Body: {manufacturer (key: letters, digits, _ or -), display_name?, category}.
$router->post('/pt/manufacturers', function (Request $r) {
    Auth::requirePtModule($r, 'planning', 'add');
    $key = trim((string) $r->input('manufacturer', ''));
    $display = trim((string) $r->input('display_name', '')) ?: str_replace('_', ' ', $key);
    $category = (string) $r->input('category', '');
    if (!preg_match('/^[A-Za-z0-9_-]{1,100}$/', $key)) {
        throw new HttpException(422, 'The manufacturer key can only use letters, digits, _ and - (for example Wisdom_Motor)');
    }
    if (!in_array($category, PT_MANUFACTURER_CATEGORIES, true)) {
        throw new HttpException(422, 'Category must be one of: ' . implode(', ', PT_MANUFACTURER_CATEGORIES));
    }
    if (GbaDb::one('SELECT 1 FROM manufacturer_db WHERE manufacturer = ?', [$key])) {
        throw new HttpException(409, 'That manufacturer already exists');
    }
    GbaDb::run('INSERT INTO manufacturer_db (manufacturer, display_name, category) VALUES (?, ?, ?)', [$key, $display, $category]);
    return ['manufacturer' => $key];
});

// Body: {manufacturer, model, model_year, bus_type, energy_source, bus_length, bus_width?, bus_height?, curb_weight?, gvw?,
//        axle_count?, energy_capacity?, charging_port_count?, one_port_intake?, two_port_intake?}.
// model_id = MANUFACTURER_MODEL_YEAR (letters and digits only), as in the original app.
$router->post('/pt/models', function (Request $r) {
    Auth::requirePtModule($r, 'planning', 'add');
    $maker = GbaDb::one('SELECT manufacturer FROM manufacturer_db WHERE manufacturer = ?', [trim((string) $r->input('manufacturer', ''))]);
    if ($maker === null) {
        throw new HttpException(422, 'Manufacturer not found');
    }
    $model = trim((string) $r->input('model', ''));
    $year = (int) $r->input('model_year', 0);
    $busType = trim((string) $r->input('bus_type', ''));
    $energy = (string) $r->input('energy_source', '');
    $length = (float) $r->input('bus_length', 0);
    if ($model === '' || $busType === '') {
        throw new HttpException(422, 'Model name and bus type are required');
    }
    if ($year < 1990 || $year > (int) date('Y') + 5) {
        throw new HttpException(422, 'Model year is not valid');
    }
    if (!in_array($energy, PT_ENERGY_SOURCES, true)) {
        throw new HttpException(422, 'Energy source must be one of: ' . implode(', ', PT_ENERGY_SOURCES));
    }
    if ($length <= 0 || $length > 30) {
        throw new HttpException(422, 'Bus length (m) is required');
    }
    $num = fn (string $k) => max(0, (float) $r->input($k, 0));
    $int = fn (string $k) => max(0, (int) $r->input($k, 0));
    $gvw = $r->input('gvw');
    $gvw = ($gvw === null || $gvw === '') ? null : max(0, (int) $gvw);

    $alnum = fn (string $s) => strtoupper(preg_replace('/[^A-Za-z0-9]/', '', $s));
    $modelId = $alnum($maker['manufacturer']) . '_' . $alnum($model) . '_' . $year;
    if (strlen($modelId) > 50) {
        throw new HttpException(422, 'Model name is too long');
    }
    if (GbaDb::one('SELECT 1 FROM model_db WHERE model_id = ?', [$modelId])) {
        throw new HttpException(409, "Model {$modelId} already exists");
    }
    GbaDb::run(
        'INSERT INTO model_db (model_id, manufacturer, model, model_year, energy_source, bus_type, bus_length, bus_width, bus_height,
                               curb_weight, gvw, axle_count, energy_capacity, charging_port_count, one_port_intake, two_port_intake)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [$modelId, $maker['manufacturer'], $model, $year, $energy, $busType, $length, $num('bus_width'), $num('bus_height'),
         $num('curb_weight'), $gvw, $int('axle_count'), $num('energy_capacity'), $int('charging_port_count'),
         $int('one_port_intake'), $int('two_port_intake')],
    );
    return ['model_id' => $modelId];
});

// Body: {model_id, bus_id?, plate?}. bus_id is the fleet number used in trip logs; left out, the next free number is used.
$router->post('/pt/buses', function (Request $r) {
    Auth::requirePtModule($r, 'planning', 'add');
    $modelId = (string) $r->input('model_id', '');
    if (!GbaDb::one('SELECT 1 FROM model_db WHERE model_id = ?', [$modelId])) {
        throw new HttpException(422, 'Model not found');
    }
    $plate = trim((string) $r->input('plate', ''));
    $busId = $r->input('bus_id');
    if ($busId === null || $busId === '') {
        GbaDb::run('INSERT INTO fleet_db (model_id, plate) VALUES (?, ?)', [$modelId, $plate]);
        return ['bus_id' => (int) GbaDb::pdo()->lastInsertId()];
    }
    $busId = (int) $busId;
    if ($busId < 1) {
        throw new HttpException(422, 'Bus number must be a positive whole number');
    }
    if (GbaDb::one('SELECT 1 FROM fleet_db WHERE bus_id = ?', [$busId])) {
        throw new HttpException(409, "Bus {$busId} is already in the fleet");
    }
    GbaDb::run('INSERT INTO fleet_db (bus_id, model_id, plate) VALUES (?, ?, ?)', [$busId, $modelId, $plate]);
    return ['bus_id' => $busId];
});

// Body: {plate}. All imported buses have an empty plate.
$router->post('/pt/buses/{id}', function (Request $r) {
    Auth::requirePtModule($r, 'planning', 'add');
    $stmt = GbaDb::run('UPDATE fleet_db SET plate = ? WHERE bus_id = ?', [trim((string) $r->input('plate', '')), (int) $r->params['id']]);
    if ($stmt->rowCount() === 0 && !GbaDb::one('SELECT 1 FROM fleet_db WHERE bus_id = ?', [(int) $r->params['id']])) {
        throw new HttpException(404, 'Bus not found');
    }
    return ['ok' => true];
});

// --- Remove (admin) -----------------------------------------------------------

$router->delete('/pt/buses/{id}', function (Request $r) {
    Auth::requirePtModule($r, 'planning', 'manage');
    $id = (int) $r->params['id'];
    if (!GbaDb::one('SELECT 1 FROM fleet_db WHERE bus_id = ?', [$id])) {
        throw new HttpException(404, 'Bus not found');
    }
    ptTransaction(function () use ($id) {
        GbaDb::run(PT_ARCHIVE_BUSES . ' WHERE f.bus_id = ?', [$id]);
        GbaDb::run('DELETE FROM fleet_db WHERE bus_id = ?', [$id]);
    });
    return ['ok' => true];
});

// Only a model with no buses (remove or move its buses first).
$router->delete('/pt/models/{id}', function (Request $r) {
    Auth::requirePtModule($r, 'planning', 'manage');
    $id = rawurldecode($r->params['id']);
    $row = GbaDb::one('SELECT (SELECT COUNT(*) FROM fleet_db WHERE model_id = m.model_id) AS buses FROM model_db m WHERE model_id = ?', [$id]);
    if ($row === null) {
        throw new HttpException(404, 'Model not found');
    }
    if ((int) $row['buses'] > 0) {
        throw new HttpException(409, "This model still has {$row['buses']} bus(es); remove them first");
    }
    ptTransaction(function () use ($id) {
        GbaDb::run('REPLACE INTO removed_model_db (' . PT_MODEL_COLUMNS . ') SELECT ' . PT_MODEL_COLUMNS . ' FROM model_db WHERE model_id = ?', [$id]);
        GbaDb::run('DELETE FROM model_db WHERE model_id = ?', [$id]);
    });
    return ['ok' => true];
});

// Removes the manufacturer with all its models and buses.
$router->delete('/pt/manufacturers/{id}', function (Request $r) {
    Auth::requirePtModule($r, 'planning', 'manage');
    $key = ptManufacturer($r)['manufacturer'];
    return ptTransaction(function () use ($key) {
        $counts = GbaDb::one('SELECT COUNT(DISTINCT m.model_id) AS models, COUNT(f.bus_id) AS buses
                                FROM model_db m LEFT JOIN fleet_db f ON f.model_id = m.model_id WHERE m.manufacturer = ?', [$key]);
        GbaDb::run(PT_ARCHIVE_BUSES . ' JOIN model_db m ON m.model_id = f.model_id WHERE m.manufacturer = ?', [$key]);
        GbaDb::run('DELETE f FROM fleet_db f JOIN model_db m ON m.model_id = f.model_id WHERE m.manufacturer = ?', [$key]);
        GbaDb::run('REPLACE INTO removed_model_db (' . PT_MODEL_COLUMNS . ') SELECT ' . PT_MODEL_COLUMNS . ' FROM model_db WHERE manufacturer = ?', [$key]);
        GbaDb::run('DELETE FROM model_db WHERE manufacturer = ?', [$key]);
        GbaDb::run('REPLACE INTO removed_manufacturer_db (manufacturer, display_name, category, created_at, updated_at)
                    SELECT manufacturer, display_name, category, created_at, updated_at FROM manufacturer_db WHERE manufacturer = ?', [$key]);
        GbaDb::run('DELETE FROM manufacturer_db WHERE manufacturer = ?', [$key]);
        return ['ok' => true, 'models' => (int) $counts['models'], 'buses' => (int) $counts['buses']];
    });
});
