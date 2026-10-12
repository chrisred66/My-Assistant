<?php

declare(strict_types=1);

namespace ChrisManager\Pt;

use ChrisManager\HttpException;

/**
 * Imports work orders from Access exports (.xlsx / .csv). The layout isn't fixed, so:
 *   - columns are mapped to fields (guessed from common names, then remembered per header layout);
 *   - free-text values for type / category / status / priority / workshop are mapped to the app's values
 *     (guessed from keywords, then remembered);
 *   - each row is keyed by its work-order number (or, without one, by bus + reported date + work), so importing a
 *     later export updates the same work orders, e.g. adding the closing date and costs.
 */
final class MaintImport
{
    public const SOURCE = 'access';

    /** Field => [label, required, header synonyms (normalised: lowercase letters and digits only)]. */
    public const FIELDS = [
        'external_ref'   => ['Work order number', false, ['wo', 'wono', 'wonumber', 'workorder', 'workorderno', 'workorderid', 'workordernumber', 'jobno', 'jobnumber', 'jobcard', 'jobcardno', 'id', 'ref', 'refno', 'reference', 'ticket', 'ticketno']],
        'bus_id'         => ['Bus', true, ['bus', 'busid', 'busno', 'busnumber', 'fleetno', 'fleetnumber', 'vehicle', 'vehicleno', 'vehicleid', 'unit', 'unitno', 'plate', 'plateno', 'platenumber', 'registration']],
        'reported_date'  => ['Reported date', true, ['date', 'reported', 'reporteddate', 'datereported', 'opendate', 'opened', 'dateopened', 'startdate', 'datein', 'createddate', 'wodate', 'issuedate', 'faultdate']],
        'completed_date' => ['Closing date', false, ['closed', 'closeddate', 'dateclosed', 'closingdate', 'completed', 'completeddate', 'datecompleted', 'enddate', 'dateout', 'finishdate', 'releasedate', 'datereleased']],
        'title'          => ['Work (short description)', true, ['title', 'work', 'job', 'task', 'fault', 'defect', 'complaint', 'subject', 'workdescription', 'jobdescription', 'faultdescription', 'description', 'issue']],
        'description'    => ['Details', false, ['details', 'remarks', 'notes', 'comments', 'workdone', 'actiontaken', 'action', 'rectification', 'narrative']],
        'closing_note'   => ['Closing note', false, ['closingnote', 'closingremarks', 'resolution', 'closurenote', 'rootcause']],
        'type'           => ['Type', false, ['type', 'wotype', 'jobtype', 'worktype', 'maintenancetype', 'repairtype']],
        'category'       => ['Category', false, ['category', 'system', 'component', 'subsystem', 'group', 'section', 'faultcategory', 'area']],
        'status'         => ['Status', false, ['status', 'wostatus', 'jobstatus', 'state']],
        'priority'       => ['Priority', false, ['priority', 'urgency', 'severity']],
        'workshop'       => ['Workshop', false, ['workshop', 'vendor', 'supplier', 'contractor', 'garage', 'serviceprovider', 'manufacturer', 'oem', 'dealer']],
        'odometer_km'    => ['Odometer (km)', false, ['odometer', 'odometerkm', 'km', 'kms', 'mileage', 'odo', 'kmreading']],
        'downtime_hours' => ['Downtime (h)', false, ['downtime', 'downtimehours', 'downtimehrs', 'vor', 'vorhours', 'hoursdown', 'offroadhours']],
        'labour_hours'   => ['Labour (h)', false, ['labourhours', 'laborhours', 'manhours', 'labourhrs', 'laborhrs', 'hours']],
        'parts_cost'     => ['Parts cost', false, ['partscost', 'parts', 'partcost', 'materialcost', 'materials', 'sparecost', 'spares']],
        'labour_cost'    => ['Labour cost', false, ['labourcost', 'laborcost', 'labour', 'labor', 'servicecost']],
    ];

    /** Fields whose file values are translated to the app's values. */
    public const VALUE_FIELDS = ['type', 'category', 'status', 'priority', 'workshop'];

    /** Keyword hints for guessing value mappings (app value => words that suggest it). */
    private const HINTS = [
        'type' => [
            'preventive' => ['pm', 'prevent', 'service', 'schedul', 'routine', 'periodic', 'pdi'], 'breakdown' => ['breakdown', 'break down', 'roadcall', 'road call', 'tow', 'recovery'],
            'inspection' => ['inspect', 'check', 'rta', 'audit', 'survey'], 'accident' => ['accident', 'collision', 'damage', 'crash', 'vandal'],
            'warranty' => ['warrant', 'recall', 'campaign'], 'corrective' => ['repair', 'correct', 'fault', 'defect', 'fix', 'unschedul', 'cm'],
        ],
        'category' => [
            'battery' => ['batter', 'hv', 'high volt', 'bms', 'cell'], 'drivetrain' => ['motor', 'drive', 'axle', 'gear', 'transmission', 'inverter', 'differential'],
            'fuel_cell' => ['fuel cell', 'hydrogen', 'h2', 'stack', 'tank'], 'charging' => ['charg', 'obc', 'socket', 'plug'],
            'brakes' => ['brake', 'pad', 'disc', 'abs', 'ebs'], 'tyres' => ['tyre', 'tire', 'wheel', 'puncture'], 'suspension' => ['suspens', 'steer', 'air bag', 'airbag', 'shock', 'bellow'],
            'hvac' => ['ac', 'a/c', 'air con', 'aircon', 'hvac', 'cooling', 'compressor', 'refrigerant', 'climate'],
            'electrical' => ['electric', 'light', 'lamp', '24v', 'wiring', 'fuse', 'lv', 'low volt', 'alternator', 'dc-dc', 'dcdc'],
            'body' => ['body', 'glass', 'window', 'windscreen', 'mirror', 'seat', 'interior', 'panel', 'paint', 'bumper', 'floor'],
            'doors' => ['door', 'ramp', 'kneel'], 'its' => ['its', 'camera', 'cctv', 'ticket', 'avl', 'gps', 'display', 'sign', 'validator', 'radio', 'mdt'],
        ],
        'status' => [
            'completed' => ['complete', 'closed', 'close', 'done', 'finish', 'resolved', 'released', 'ok'], 'cancelled' => ['cancel', 'void', 'reject', 'duplicate'],
            'waiting_parts' => ['part', 'await', 'waiting', 'backorder', 'on order'], 'in_progress' => ['progress', 'working', 'wip', 'ongoing', 'started', 'in workshop', 'assigned'],
            'open' => ['open', 'new', 'pending', 'reported', 'raised'],
        ],
        'priority' => [
            'critical' => ['critical', 'emergency', 'vor', 'urgent', 'p1', 'immediate'], 'high' => ['high', 'p2', 'major'], 'low' => ['low', 'p4', 'minor'],
            'normal' => ['normal', 'medium', 'p3', 'routine', 'standard'],
        ],
    ];

    /** Grid → [headers (as in the file), rows (list of lists)]. */
    public static function read(string $path, string $fileName): array
    {
        $ext = strtolower(pathinfo($fileName, PATHINFO_EXTENSION));
        $grid = match ($ext) {
            'csv', 'txt' => TripLog::readCsv($path),
            'xlsx' => Xlsx::firstSheet($path),
            'xls' => throw new HttpException(422, 'Old .xls files aren\'t supported: in Access export to Excel (.xlsx) or text (.csv) instead'),
            'accdb', 'mdb' => throw new HttpException(422, 'Upload an export, not the database itself: in Access use External Data → Export → Excel or Text File'),
            default => throw new HttpException(422, 'Upload a .xlsx or .csv export'),
        };
        while ($grid && TripLog::blank($grid[0])) {
            array_shift($grid);
        }
        if (!$grid) {
            throw new HttpException(422, 'The file is empty');
        }
        $headers = array_map(fn ($h) => trim(preg_replace('/^\xEF\xBB\xBF/', '', (string) $h)), array_shift($grid));
        $rows = array_values(array_filter($grid, fn ($r) => !TripLog::blank($r)));
        return [$headers, $rows];
    }

    public static function signature(array $headers): string
    {
        return hash('sha256', implode('|', array_map(fn ($h) => TripLog::normHeader((string) $h), $headers)));
    }

    /** Saved mapping for this layout, or guesses from the header names. Returns field => header. */
    public static function columnMap(array $headers, ?array $saved): array
    {
        if ($saved !== null) {
            return array_filter($saved, fn ($h) => in_array($h, $headers, true));
        }
        $map = [];
        $taken = [];
        // Exact synonym matches first, then "contains" matches, so "WO No" beats "Notes" for the number.
        foreach ([true, false] as $exact) {
            foreach (self::FIELDS as $field => [, , $syn]) {
                if (isset($map[$field])) {
                    continue;
                }
                foreach ($headers as $h) {
                    $n = TripLog::normHeader((string) $h);
                    if ($n === '' || isset($taken[$h])) {
                        continue;
                    }
                    $hit = $exact ? in_array($n, $syn, true) : array_filter($syn, fn ($s) => strlen($s) >= 4 && str_contains($n, $s));
                    if ($hit) {
                        $map[$field] = $h;
                        $taken[$h] = true;
                        break;
                    }
                }
            }
        }
        return $map;
    }

    /** Distinct file values for each value-mapped field, with the saved or guessed app value for each. */
    public static function valueMaps(array $headers, array $rows, array $columns, array $saved, array $workshops): array
    {
        $out = [];
        foreach (self::VALUE_FIELDS as $field) {
            if (!isset($columns[$field])) {
                continue;
            }
            $i = array_search($columns[$field], $headers, true);
            $distinct = [];
            foreach ($rows as $r) {
                $v = trim((string) ($r[$i] ?? ''));
                if ($v !== '') {
                    $distinct[$v] = ($distinct[$v] ?? 0) + 1;
                }
            }
            arsort($distinct);
            $out[$field] = [];
            foreach (array_slice($distinct, 0, 200, true) as $v => $n) {
                $v = (string) $v;
                $out[$field][] = ['value' => $v, 'rows' => $n, 'maps_to' => $saved[$field][$v] ?? self::guessValue($field, $v, $workshops)];
            }
        }
        return $out;
    }

    private static function guessValue(string $field, string $v, array $workshops): ?string
    {
        $l = strtolower($v);
        if ($field === 'workshop') {
            foreach ($workshops as $w) {
                $wl = strtolower($w);
                if ($l === $wl || str_contains($l, $wl) || str_contains($wl, $l) || str_contains(str_replace(' ', '', $l), str_replace(' ', '', $wl))) {
                    return $w;
                }
            }
            return null;
        }
        $allowed = match ($field) {
            'type' => \PT_MAINT_TYPES, 'status' => \PT_MAINT_STATUSES, 'priority' => \PT_MAINT_PRIORITIES, 'category' => array_keys(\PT_MAINT_CATEGORIES),
        };
        if (in_array($l, $allowed, true)) {
            return $l;
        }
        if ($field === 'category') {
            foreach (\PT_MAINT_CATEGORIES as $code => $label) {
                if (strtolower($label) === $l) {
                    return $code;
                }
            }
        }
        foreach (self::HINTS[$field] as $app => $words) {
            foreach ($words as $w) {
                // Short codes ("ac", "pm", "hv") must be whole words; longer hints may be part of a word.
                $hit = strlen($w) <= 3 ? preg_match('/(^|[^a-z0-9])' . preg_quote($w, '/') . '($|[^a-z0-9])/', $l) : str_contains($l, $w);
                if ($hit) {
                    return $app;
                }
            }
        }
        return null;
    }

    /**
     * Turns file rows into work-order rows. Returns [rows, skipped (line, reason)].
     * @param array $columns field => header; $values field => [file value => app value]
     */
    public static function normalize(array $headers, array $rows, array $columns, array $values, string $dateOrder): array
    {
        $idx = [];
        foreach ($columns as $field => $h) {
            $i = array_search($h, $headers, true);
            if ($i !== false && isset(self::FIELDS[$field])) {
                $idx[$field] = $i;
            }
        }
        foreach (['bus_id', 'reported_date', 'title'] as $req) {
            if (!isset($idx[$req])) {
                throw new HttpException(422, 'Choose the column for ' . self::FIELDS[$req][0]);
            }
        }
        // Buses by fleet number, and by plate as a fallback.
        $byId = [];
        $byPlate = [];
        foreach (GbaDb::all('SELECT bus_id, plate FROM fleet_db') as $b) {
            $byId[(int) $b['bus_id']] = true;
            if (trim((string) $b['plate']) !== '') {
                $byPlate[strtolower(preg_replace('/\s+/', '', $b['plate']))] = (int) $b['bus_id'];
            }
        }
        $out = [];
        $skipped = [];
        foreach ($rows as $n => $r) {
            $get = fn (string $f) => isset($idx[$f]) ? $r[$idx[$f]] ?? null : null;
            $line = $n + 2;
            $busRaw = trim((string) $get('bus_id'));
            $bus = ctype_digit(preg_replace('/\.0+$/', '', $busRaw)) ? (int) $busRaw : null;
            if ($bus === null || !isset($byId[$bus])) {
                $bus = $byPlate[strtolower(preg_replace('/\s+/', '', $busRaw))] ?? (preg_match('/(\d{3,})/', $busRaw, $m) && isset($byId[(int) $m[1]]) ? (int) $m[1] : null);
            }
            if ($bus === null) {
                $skipped[] = ['line' => $line, 'reason' => $busRaw === '' ? 'no bus' : "bus \"{$busRaw}\" is not in the fleet"];
                continue;
            }
            $reported = TripLog::normDate($get('reported_date'), $dateOrder);
            if ($reported === null) {
                $skipped[] = ['line' => $line, 'reason' => 'reported date missing or not readable'];
                continue;
            }
            $title = trim((string) $get('title'));
            if ($title === '') {
                $skipped[] = ['line' => $line, 'reason' => 'no work description'];
                continue;
            }
            $closed = $get('completed_date') === null || trim((string) $get('completed_date')) === '' ? null : TripLog::normDate($get('completed_date'), $dateOrder);
            $mapped = function (string $f, ?string $default) use ($get, $values): ?string {
                $raw = trim((string) $get($f));
                return $raw === '' ? $default : ($values[$f][$raw] ?? $default);
            };
            $status = $mapped('status', null) ?? ($closed !== null ? 'completed' : 'open');
            // A closing date means it's closed; a closed status without one is closed on the reported date.
            if ($closed !== null && !in_array($status, ['completed', 'cancelled'], true)) {
                $status = 'completed';
            }
            if (in_array($status, ['completed', 'cancelled'], true) && $closed === null) {
                $closed = $reported;
            }
            if ($closed !== null && $closed < $reported) {
                $skipped[] = ['line' => $line, 'reason' => "closing date {$closed} is before the reported date {$reported}"];
                continue;
            }
            $num = function (string $f) use ($get): ?float {
                $v = TripLog::normNum($get($f));
                return $v === null || $v < 0 ? null : $v;
            };
            $ref = trim((string) $get('external_ref'));
            $row = [
                'external_ref' => $ref !== '' ? mb_substr(preg_replace('/\.0+$/', '', $ref), 0, 100) : 'auto:' . substr(hash('sha256', "$bus|$reported|" . mb_strtolower($title)), 0, 32),
                'bus_id' => $bus,
                'type' => $mapped('type', 'corrective'),
                'category' => $mapped('category', 'general'),
                'priority' => $mapped('priority', 'normal'),
                'status' => $status,
                'title' => mb_substr($title, 0, 255),
                'description' => trim((string) $get('description')) ?: null,
                'closing_note' => trim((string) $get('closing_note')) ?: null,
                'reported_date' => $reported,
                'completed_date' => $closed,
                'workshop' => $mapped('workshop', null),
                'odometer_km' => $num('odometer_km'),
                'downtime_hours' => $num('downtime_hours'),
                'labour_hours' => $num('labour_hours'),
                'parts_cost' => $num('parts_cost'),
                'labour_cost' => $num('labour_cost'),
            ];
            $out[] = $row;
        }
        return [$out, $skipped];
    }

    /** The fields an import writes (so a re-import only touches what the file provides). */
    public static function writtenFields(array $columns): array
    {
        $always = ['bus_id', 'type', 'category', 'priority', 'status', 'title', 'reported_date', 'completed_date'];
        $optional = array_intersect(array_keys($columns), ['description', 'closing_note', 'workshop', 'odometer_km', 'downtime_hours', 'labour_hours', 'parts_cost', 'labour_cost']);
        // type / category / priority come from defaults when not mapped; don't overwrite edits made in the app then.
        $always = array_values(array_filter($always, fn ($f) => !in_array($f, ['type', 'category', 'priority'], true) || isset($columns[$f])));
        return [...$always, ...$optional];
    }

    /** new / update / unchanged for each row (by source + external_ref). */
    public static function classify(array $rows, array $fields): array
    {
        $existing = [];
        foreach (array_chunk(array_column($rows, 'external_ref'), 500) as $refs) {
            $in = implode(',', array_fill(0, count($refs), '?'));
            foreach (GbaDb::all("SELECT * FROM maintenance_db WHERE source = ? AND external_ref IN ($in)", [self::SOURCE, ...$refs]) as $e) {
                $existing[$e['external_ref']] = $e;
            }
        }
        $status = [];
        foreach ($rows as $r) {
            $e = $existing[$r['external_ref']] ?? null;
            if ($e === null) {
                $status[] = 'new';
                continue;
            }
            $changed = false;
            foreach ($fields as $f) {
                $a = $e[$f];
                $b = $r[$f];
                if (is_float($b) || is_int($b)) {
                    $changed = $a === null || abs((float) $a - $b) > 0.001;
                } else {
                    $changed = (string) $a !== (string) $b;
                }
                if ($changed) {
                    break;
                }
            }
            $status[] = $changed ? 'update' : 'unchanged';
        }
        return $status;
    }

    /** Inserts new work orders and updates changed ones. */
    public static function save(array $rows, array $fields, int $userId): array
    {
        $pdo = GbaDb::pdo();
        $status = self::classify($rows, $fields);
        $out = ['inserted' => 0, 'updated' => 0, 'unchanged' => 0];
        $pdo->beginTransaction();
        try {
            foreach ($rows as $i => $r) {
                if ($status[$i] === 'unchanged') {
                    $out['unchanged']++;
                } elseif ($status[$i] === 'new') {
                    $cols = [...$fields, 'source', 'external_ref', 'created_by'];
                    GbaDb::run('INSERT INTO maintenance_db (' . implode(', ', $cols) . ') VALUES (' . implode(', ', array_fill(0, count($cols), '?')) . ')',
                        [...array_map(fn ($f) => $r[$f], $fields), self::SOURCE, $r['external_ref'], $userId]);
                    $out['inserted']++;
                } else {
                    GbaDb::run('UPDATE maintenance_db SET ' . implode(', ', array_map(fn ($f) => "$f = ?", $fields)) . ' WHERE source = ? AND external_ref = ?',
                        [...array_map(fn ($f) => $r[$f], $fields), self::SOURCE, $r['external_ref']]);
                    $out['updated']++;
                }
            }
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
        return $out;
    }
}
