<?php

declare(strict_types=1);

/**
 * PT Management: Drivers. Who drove which bus and model, who drives several models, who works which shift, and each
 * driver's energy consumption on each bus compared with everyone driving that model. Read-only, from the fleet trip log.
 *
 * Shifts aren't recorded, so each bus's day is split in two (trips in start-time order): Shift A (morning) and Shift B
 * (evening). A change of driver is taken as the handover (the change nearest the middle of the day's trips, if there
 * are several); with no change of driver the day's trips are split in half; a bus with a single trip that day falls
 * back to its start time (03:00-09:59 = A). Consumption is also split by season: hot (June-September, Abu Dhabi
 * summer, heavy air-conditioning load) and mild (October-May), so drivers are compared like with like. Consumption is kWh/100 km for battery buses and kg/100 km for hydrogen
 * buses (never mixed); trips with an impossible distance or no energy reading are left out of it, as in Operations.
 */

/** @var ChrisManager\Router $router */

use ChrisManager\Auth;
use ChrisManager\Pt\GbaDb;
use ChrisManager\Request;

/**
 * Shift per trip for one bus-day (trips already in start-time order): ['A'|'B', ...] and how it was decided.
 *
 * @param list<array{driver_id: mixed, start_time: mixed}> $trips
 * @return array{0: list<string>, 1: string}
 */
function ptSplitShifts(array $trips): array
{
    $n = count($trips);
    if ($n === 1) {
        $hour = (int) substr((string) $trips[0]['start_time'], 0, 2);
        return [[$hour >= 3 && $hour < 10 ? 'A' : 'B'], 'single'];
    }
    // Candidate handovers: index i where trip i has a different driver from trip i-1 (trips before i are Shift A).
    $split = null;
    for ($i = 1; $i < $n; $i++) {
        if ((string) $trips[$i]['driver_id'] !== (string) $trips[$i - 1]['driver_id']
            && ($split === null || abs($i - $n / 2) < abs($split - $n / 2))) {
            $split = $i;
        }
    }
    $basis = $split === null ? 'halves' : 'driver_change';
    $split ??= (int) ceil($n / 2);
    $out = [];
    for ($i = 0; $i < $n; $i++) {
        $out[] = $i < $split ? 'A' : 'B';
    }
    return [$out, $basis];
}

$router->get('/pt/drivers', function (Request $r) {
    Auth::requirePtModule($r, 'operations', 'view');
    $range = GbaDb::one('SELECT MIN(date) AS min_date, MAX(date) AS max_date FROM triplog_db');
    $from = (string) $r->query('from', (string) $range['min_date']);
    $to = (string) $r->query('to', (string) $range['max_date']);
    $energy = PT_ENERGY;

    $trips = GbaDb::all(
        "SELECT t.date, t.bus_id, t.driver_id, t.start_time, t.distance, t.energy_used, f.model_id,
                COALESCE(CONCAT(m.manufacturer, ' ', m.model, ' (', m.model_year, ')'), 'Unknown model') AS model,
                {$energy} AS energy
           FROM triplog_db t LEFT JOIN fleet_db f ON f.bus_id = t.bus_id LEFT JOIN model_db m ON m.model_id = f.model_id
          WHERE t.date BETWEEN ? AND ?
          ORDER BY t.bus_id, t.date, t.start_time, t.trip_id",
        [$from, $to],
    );

    // Split each bus-day into shifts.
    $basis = ['driver_change' => 0, 'halves' => 0, 'single' => 0];
    $groups = [];
    foreach ($trips as $i => $t) {
        $groups[$t['bus_id'] . '|' . $t['date']][] = $i;
    }
    foreach ($groups as $idx) {
        [$shifts, $how] = ptSplitShifts(array_map(fn ($i) => $trips[$i], $idx));
        $basis[$how]++;
        foreach ($idx as $k => $i) {
            $trips[$i]['shift'] = $shifts[$k];
        }
    }

    // Driver × bus, and per driver (a day counts once per shift).
    $rows = [];
    $drivers = [];
    foreach ($trips as $t) {
        if ($t['driver_id'] === null) {
            continue;
        }
        $d = (string) $t['driver_id'];
        $key = $d . '|' . $t['bus_id'];
        $a = $t['shift'] === 'A';
        $valid = $t['distance'] > 0 && $t['distance'] <= PT_MAX_TRIP_KM && $t['energy_used'] > 0;
        $row = &$rows[$key];
        $row ??= [
            'driver_id' => $d, 'bus_id' => (string) $t['bus_id'], 'model_id' => $t['model_id'], 'model' => $t['model'],
            'energy' => $t['energy'], 'unit' => $t['energy'] === 'Hydrogen' ? 'kg' : 'kWh',
            'trips' => 0, 'days' => [], 'a_trips' => 0, 'b_trips' => 0, 'km' => null, 'energy_used' => null, 'valid_trips' => 0,
            'hot' => ['km' => 0.0, 'energy_used' => 0.0, 'valid_trips' => 0], 'mild' => ['km' => 0.0, 'energy_used' => 0.0, 'valid_trips' => 0],
            'first_date' => $t['date'], 'last_date' => $t['date'],
        ];
        $row['trips']++;
        $row['days'][$t['date']] = true;
        $row[$a ? 'a_trips' : 'b_trips']++;
        if ($valid) {
            $row['km'] = ($row['km'] ?? 0) + (float) $t['distance'];
            $row['energy_used'] = ($row['energy_used'] ?? 0) + (float) $t['energy_used'];
            $row['valid_trips']++;
            $season = in_array((int) substr((string) $t['date'], 5, 2), PT_HOT_MONTHS, true) ? 'hot' : 'mild';
            $row[$season]['km'] += (float) $t['distance'];
            $row[$season]['energy_used'] += (float) $t['energy_used'];
            $row[$season]['valid_trips']++;
        }
        $row['first_date'] = min($row['first_date'], $t['date']);
        $row['last_date'] = max($row['last_date'], $t['date']);
        unset($row);

        $dr = &$drivers[$d];
        $dr ??= ['driver_id' => $d, 'trips' => 0, 'days' => [], 'a_trips' => 0, 'b_trips' => 0, 'a_days' => [], 'b_days' => [],
            'first_date' => $t['date'], 'last_date' => $t['date']];
        $dr['trips']++;
        $dr['days'][$t['date']] = true;
        $dr[$a ? 'a_trips' : 'b_trips']++;
        $dr[$a ? 'a_days' : 'b_days'][$t['date']] = true;
        $dr['first_date'] = min($dr['first_date'], $t['date']);
        $dr['last_date'] = max($dr['last_date'], $t['date']);
        unset($dr);
    }

    $rows = array_values(array_map(fn ($x) => [
        ...$x,
        'days' => count($x['days']),
        'km' => $x['km'] === null ? null : round($x['km'], 1),
        'energy_used' => $x['energy_used'] === null ? null : round($x['energy_used'], 2),
        'hot' => ['km' => round($x['hot']['km'], 1), 'energy_used' => round($x['hot']['energy_used'], 2), 'valid_trips' => $x['hot']['valid_trips']],
        'mild' => ['km' => round($x['mild']['km'], 1), 'energy_used' => round($x['mild']['energy_used'], 2), 'valid_trips' => $x['mild']['valid_trips']],
    ], $rows));
    usort($rows, fn ($x, $y) => [(int) $x['driver_id'], -$x['trips']] <=> [(int) $y['driver_id'], -$y['trips']]);

    return [
        'from' => $from,
        'to' => $to,
        'min_date' => $range['min_date'],
        'max_date' => $range['max_date'],
        'shift_basis' => $basis,
        'hot_months' => PT_HOT_MONTHS,
        'rows' => $rows,
        'drivers' => array_values(array_map(fn ($x) => [
            ...$x, 'days' => count($x['days']), 'a_days' => count($x['a_days']), 'b_days' => count($x['b_days']),
        ], $drivers)),
    ];
});
