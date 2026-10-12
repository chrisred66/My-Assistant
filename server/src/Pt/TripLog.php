<?php

declare(strict_types=1);

namespace ChrisManager\Pt;

use ChrisManager\HttpException;

/**
 * Trip-log rows: reading upload files, normalising rows and saving them with de-duplication.
 *
 * A trip is identified by entry_key = "date|bus|start_km|end_km". Saving a trip whose key exists:
 *   - same row_hash  → identical, ignored;
 *   - different hash → conflict, kept in triplog_duplicates for someone to resolve.
 * entry_key and row_hash are computed exactly as the original ptManagement upload did, so re-uploading
 * an old file finds its trips as identical.
 *
 * Energy: energy_used = capacity × SOC drop, so it's kWh for battery buses and kg of hydrogen for
 * fuel-cell buses (model_db.energy_capacity is in the bus's own unit). energy_consumption is per 100 km.
 */
final class TripLog
{
    public const REQUIRED = ['date', 'driverid', 'busid', 'route', 'starttime', 'endtime', 'startkm', 'endkm', 'startsoc', 'endsoc'];

    /** @var array<int, ?float> bus_id → energy capacity (null: bus not in the fleet) */
    private array $capacity = [];

    /**
     * @param ?array{trial_id: int, trial_bus_id: int, label: string} $trial For trial trips: every row belongs to the trial's
     *        bus (the file's bus column is optional, and rows naming another bus are skipped) and is saved to trial_triplog_db.
     */
    public function __construct(private readonly ?array $trial = null)
    {
    }

    /**
     * Reads a CSV or XLSX file into rows keyed by normalised header ("Bus ID" → "busid").
     * @return array{rows: list<array<string, mixed>>, headers: list<string>}
     */
    public static function readFile(string $path, string $fileName, bool $needBusColumn = true): array
    {
        $ext = strtolower(pathinfo($fileName, PATHINFO_EXTENSION));
        $table = match ($ext) {
            'csv'   => self::readCsv($path),
            'xlsx'  => Xlsx::firstSheet($path),
            'xls'   => throw new HttpException(422, 'Old .xls files aren\'t supported: open it in Excel and save as .xlsx or .csv'),
            default => throw new HttpException(422, 'Upload a .csv or .xlsx file'),
        };
        // Skip leading blank rows, then the first row is the header.
        while ($table && self::blank($table[0])) {
            array_shift($table);
        }
        if (!$table) {
            throw new HttpException(422, 'The file is empty');
        }
        $headers = array_map(fn ($h) => self::normHeader((string) $h), array_shift($table));
        $required = $needBusColumn ? self::REQUIRED : array_values(array_diff(self::REQUIRED, ['busid']));
        $missing = array_values(array_diff($required, $headers));
        if ($missing) {
            throw new HttpException(422, 'Missing column(s): ' . implode(', ', $missing)
                . '. Needed: Date, Driver ID, ' . ($needBusColumn ? 'Bus ID, ' : '') . 'Route, Start Time, End Time, Start KM, End KM, Start SOC, End SOC');
        }
        $rows = [];
        foreach ($table as $line) {
            if (self::blank($line)) {
                continue;
            }
            $row = [];
            foreach ($headers as $i => $h) {
                if ($h !== '' && !array_key_exists($h, $row)) {
                    $row[$h] = $line[$i] ?? null;
                }
            }
            $rows[] = $row;
        }
        return ['rows' => $rows, 'headers' => $headers];
    }

    /**
     * Which way round slash dates are (03/04/2025): 'dmy' or 'mdy'. Decided from any date in the file whose
     * day is over 12; with no evidence, 'mdy' like the original app (PHP's strtotime).
     */
    public static function detectDateOrder(array $rows): string
    {
        foreach ($rows as $r) {
            if (is_string($r['date'] ?? null) && preg_match('#^\s*(\d{1,2})[/.](\d{1,2})[/.]\d{2,4}#', $r['date'], $m)) {
                if ((int) $m[1] > 12) {
                    return 'dmy';
                }
                if ((int) $m[2] > 12) {
                    return 'mdy';
                }
            }
        }
        return 'mdy';
    }

    /**
     * Normalises one raw row. Returns [row, null] or [null, reason it was skipped].
     * @param array<string, mixed> $raw keys: normalised headers
     */
    public function normalize(array $raw, string $dateOrder = 'mdy'): array
    {
        $date = self::normDate($raw['date'] ?? null, $dateOrder);
        $busId = (int) self::normNum($raw['busid'] ?? null);
        if ($this->trial !== null) {
            $given = self::normStr($raw['busid'] ?? $raw['trialbusid'] ?? null);
            if ($given !== null && strcasecmp($given, $this->trial['label']) !== 0 && $given !== (string) $this->trial['trial_bus_id']) {
                return [null, "bus {$given} is not this trial's bus ({$this->trial['label']})"];
            }
            $busId = $this->trial['trial_bus_id'];
        }
        $startKm = self::normNum($raw['startkm'] ?? null);
        $endKm = self::normNum($raw['endkm'] ?? null);
        $startSoc = self::normNum($raw['startsoc'] ?? null);
        $endSoc = self::normNum($raw['endsoc'] ?? null);
        $reason = match (true) {
            $date === null                     => 'date missing or not readable',
            $busId <= 0                        => 'bus ID missing',
            $startKm === null || $endKm === null => 'start or end km missing',
            $startSoc === null || $endSoc === null => 'start or end SOC missing',
            $startSoc < 0 || $startSoc > 100 || $endSoc < 0 || $endSoc > 100 => 'SOC outside 0–100',
            default                            => null,
        };
        if ($reason !== null) {
            return [null, $reason];
        }
        $driverId = (int) self::normNum($raw['driverid'] ?? null);
        $route = self::normStr($raw['route'] ?? null);
        $startTime = self::normTime($raw['starttime'] ?? null);
        $endTime = self::normTime($raw['endtime'] ?? null);

        $distance = $endKm - $startKm;
        $socDrop = $startSoc - $endSoc;
        $capacity = $this->capacity($busId);
        $energyUsed = null;
        $consumption = null;
        if ($capacity !== null && $capacity > 0 && $distance > 0 && $socDrop > 0) {
            $energyUsed = $capacity * ($socDrop / 100);
            $consumption = $energyUsed / $distance * 100;
        }

        // Same fields, names and order of operations as ptManagement's uploadTripData.php.
        $rowHash = hash('sha256', self::canonicalJson([
            'date' => $date, 'driverID' => $driverId, 'busID' => $busId, 'route' => $route,
            'startTime' => $startTime, 'endTime' => $endTime, 'startKm' => $startKm, 'endKm' => $endKm,
            'startSoc' => $startSoc, 'endSoc' => $endSoc, 'distance' => $distance, 'socDrop' => $socDrop,
            'energyUsed' => $energyUsed, 'energyConsumption' => $consumption,
        ]));
        $extra = array_diff_key($raw, array_flip([...self::REQUIRED, 'trialbusid']));
        $extra = array_filter($extra, fn ($v, $k) => $k !== '' && $v !== null && $v !== '', ARRAY_FILTER_USE_BOTH);

        return [[
            'date' => $date, 'driver_id' => $driverId ?: null, 'bus_id' => $busId, 'route' => $route,
            'start_time' => $startTime, 'end_time' => $endTime, 'start_km' => $startKm, 'end_km' => $endKm,
            'start_soc' => $startSoc, 'end_soc' => $endSoc, 'distance' => $distance, 'soc_drop' => $socDrop,
            'energy_used' => $energyUsed, 'energy_consumption' => $consumption,
            'entry_key' => $date . '|' . $busId . '|' . $startKm . '|' . $endKm,
            'row_hash' => $rowHash,
            'extra_data' => $extra ? json_encode($extra, JSON_UNESCAPED_UNICODE) : null,
            'in_fleet' => $capacity !== null,
        ], null];
    }

    /**
     * Classifies rows against the database without writing: new / identical / conflict.
     * Rows repeated within the same batch count once (the first wins, later different ones are conflicts).
     * @return array{new: int, identical: int, conflict: int, status: list<string>}
     */
    public function classify(array $rows): array
    {
        $table = $this->trial !== null ? 'trial_triplog_db' : 'triplog_db';
        $existing = [];
        foreach (array_chunk(array_unique(array_column($rows, 'entry_key')), 500) as $keys) {
            $in = implode(',', array_fill(0, count($keys), '?'));
            foreach (GbaDb::all("SELECT entry_key, row_hash FROM $table WHERE entry_key IN ($in)", $keys) as $e) {
                $existing[strtolower($e['entry_key'])] = $e['row_hash'];
            }
        }
        $counts = ['new' => 0, 'identical' => 0, 'conflict' => 0, 'status' => []];
        foreach ($rows as $r) {
            $k = strtolower($r['entry_key']);
            $s = !isset($existing[$k]) ? 'new' : ($existing[$k] === $r['row_hash'] ? 'identical' : 'conflict');
            $existing[$k] ??= $r['row_hash'];
            $counts[$s]++;
            $counts['status'][] = $s;
        }
        return $counts;
    }

    /**
     * Saves rows: inserts new trips, ignores identical ones, records conflicts in triplog_duplicates.
     * Trial trips go to trial_triplog_db; their conflicts are only counted (there's no duplicates table for trials).
     * @return array{inserted: int, identical: int, conflicts: int}
     */
    public function save(array $rows, ?string $sourceFile): array
    {
        $pdo = GbaDb::pdo();
        $trial = $this->trial;
        $check = $pdo->prepare('SELECT row_hash FROM ' . ($trial !== null ? 'trial_triplog_db' : 'triplog_db') . ' WHERE entry_key = ? LIMIT 1');
        $insert = $trial !== null
            ? $pdo->prepare(
                'INSERT INTO trial_triplog_db (trial_id, trial_bus_id, date, driver_id, route, start_time, end_time, start_km, end_km,
                                               start_soc, end_soc, distance, soc_drop, energy_used, energy_consumption, entry_key, row_hash)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )
            : $pdo->prepare(
                'INSERT INTO triplog_db (date, driver_id, bus_id, route, start_time, end_time, start_km, end_km, start_soc, end_soc,
                                         distance, soc_drop, energy_used, energy_consumption, extra_data, entry_key, row_hash)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            );
        $dup = $pdo->prepare(
            'INSERT INTO triplog_duplicates (entry_key, existing_row_hash, incoming_row_hash, incoming_data, source_file) VALUES (?, ?, ?, ?, ?)',
        );
        $out = ['inserted' => 0, 'identical' => 0, 'conflicts' => 0];
        $pdo->beginTransaction();
        try {
            foreach ($rows as $r) {
                $check->execute([$r['entry_key']]);
                $existing = $check->fetchColumn();
                if ($existing === false && $trial !== null) {
                    $insert->execute([$trial['trial_id'], $r['bus_id'], $r['date'], $r['driver_id'], $r['route'], $r['start_time'],
                        $r['end_time'], $r['start_km'], $r['end_km'], $r['start_soc'], $r['end_soc'], $r['distance'], $r['soc_drop'],
                        $r['energy_used'], $r['energy_consumption'], $r['entry_key'], $r['row_hash']]);
                    $out['inserted']++;
                } elseif ($existing === false) {
                    $insert->execute([$r['date'], $r['driver_id'], $r['bus_id'], $r['route'], $r['start_time'], $r['end_time'],
                        $r['start_km'], $r['end_km'], $r['start_soc'], $r['end_soc'], $r['distance'], $r['soc_drop'],
                        $r['energy_used'], $r['energy_consumption'], $r['extra_data'], $r['entry_key'], $r['row_hash']]);
                    $out['inserted']++;
                } elseif ($existing === $r['row_hash']) {
                    $out['identical']++;
                } elseif ($trial !== null) {
                    $out['conflicts']++;
                } else {
                    $data = $r;
                    unset($data['in_fleet']);
                    $dup->execute([$r['entry_key'], $existing, $r['row_hash'], json_encode($data, JSON_UNESCAPED_UNICODE),
                        $sourceFile === null ? null : mb_substr($sourceFile, 0, 255)]);
                    $out['conflicts']++;
                }
            }
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
        return $out;
    }

    private function capacity(int $busId): ?float
    {
        if (!array_key_exists($busId, $this->capacity)) {
            $row = $this->trial !== null
                ? GbaDb::one('SELECT m.energy_capacity FROM trial_fleet_db tf JOIN model_db m ON m.model_id = tf.model_id WHERE tf.trial_bus_id = ?', [$busId])
                : GbaDb::one('SELECT m.energy_capacity FROM fleet_db f JOIN model_db m ON m.model_id = f.model_id WHERE f.bus_id = ?', [$busId]);
            $this->capacity[$busId] = $row === null ? null : (float) $row['energy_capacity'];
        }
        return $this->capacity[$busId];
    }

    // --- Value normalisation (behaves like the original app's helpers) -------------

    public static function normHeader(string $h): string
    {
        $h = preg_replace('/^\xEF\xBB\xBF/', '', $h); // UTF-8 BOM on the first CSV header
        return strtolower(preg_replace('/[^A-Za-z0-9]/', '', $h));
    }

    public static function normNum(mixed $v): ?float
    {
        if (is_string($v)) {
            $v = str_replace(',', '', trim($v));
        }
        return ($v === null || $v === '' || $v === '-' || !is_numeric($v)) ? null : (float) $v;
    }

    public static function normStr(mixed $v): ?string
    {
        if ($v === null) {
            return null;
        }
        $v = trim((string) $v);
        return $v === '' ? null : $v;
    }

    /** YYYY-MM-DD from an ISO date, a slash date (order given), or an Excel serial number. */
    public static function normDate(mixed $v, string $order = 'mdy'): ?string
    {
        if (is_int($v) || is_float($v) || (is_string($v) && is_numeric(trim($v)))) {
            $serial = (float) $v;
            return $serial > 20000 && $serial < 80000 ? gmdate('Y-m-d', (int) round(($serial - 25569) * 86400)) : null;
        }
        $s = self::normStr($v);
        if ($s === null) {
            return null;
        }
        if (preg_match('#^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})#', $s, $m)) {
            [$d, $mo] = $order === 'dmy' ? [(int) $m[1], (int) $m[2]] : [(int) $m[2], (int) $m[1]];
            $y = (int) $m[3] < 100 ? 2000 + (int) $m[3] : (int) $m[3];
            return checkdate($mo, $d, $y) ? sprintf('%04d-%02d-%02d', $y, $mo, $d) : null;
        }
        $ts = strtotime($s);
        return $ts === false ? null : date('Y-m-d', $ts);
    }

    /** HH:MM:SS from "6:45", "06:45:00", "6:45 PM", or an Excel day fraction. */
    public static function normTime(mixed $v): ?string
    {
        if (is_int($v) || is_float($v) || (is_string($v) && is_numeric(trim($v)))) {
            $f = fmod((float) $v, 1.0); // a date-time serial keeps only its time of day
            $sec = (int) round($f * 86400) % 86400;
            return sprintf('%02d:%02d:%02d', intdiv($sec, 3600), intdiv($sec % 3600, 60), $sec % 60);
        }
        $s = self::normStr($v);
        if ($s === null) {
            return null;
        }
        if (preg_match('/^\d{1,2}:\d{2}$/', $s)) {
            return $s . ':00'; // unpadded ("6:45:00") like the original, so row hashes match; MySQL reads it fine
        }
        $ts = strtotime($s);
        return $ts === false ? null : date('H:i:s', $ts);
    }

    /** Same as ptManagement's canonical_json(): keys sorted, then json_encode. */
    private static function canonicalJson(array $a): string
    {
        ksort($a);
        return json_encode($a, JSON_UNESCAPED_UNICODE);
    }

    public static function readCsv(string $path): array
    {
        $fh = fopen($path, 'r');
        if ($fh === false) {
            throw new HttpException(500, 'Could not read the uploaded file');
        }
        $first = fgets($fh) ?: '';
        rewind($fh);
        // Excel in some locales saves CSV with semicolons.
        $sep = substr_count($first, ';') > substr_count($first, ',') ? ';' : ',';
        $rows = [];
        while (($r = fgetcsv($fh, null, $sep, '"', '')) !== false) {
            $rows[] = $r;
        }
        fclose($fh);
        return $rows;
    }

    public static function blank(array $row): bool
    {
        foreach ($row as $v) {
            if ($v !== null && trim((string) $v) !== '') {
                return false;
            }
        }
        return true;
    }
}
