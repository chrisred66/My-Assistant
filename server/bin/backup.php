<?php

declare(strict_types=1);

// Nightly backup (Task Scheduler "My Assistant Backup"): both databases (the app's and the PT database) as compressed
// SQL dumps, plus a mirror of the recordings folder. Old dumps are pruned after BACKUP_KEEP_DAYS (default 14).
//   php bin/backup.php
// Settings in server/.env: BACKUP_DIR (default D:\backups\my-assistant), BACKUP_KEEP_DAYS.
// The database password is read from .env and handed to mysqldump in a temporary options file (deleted right after),
// so it never appears in a command line or a log.

use ChrisManager\Env;

require __DIR__ . '/../src/bootstrap.php';

$dir = rtrim(Env::get('BACKUP_DIR', 'D:\\backups\\my-assistant'), '\\/');
$keep = max(1, (int) Env::get('BACKUP_KEEP_DAYS', '14'));
$mysqldump = Env::get('MYSQLDUMP_PATH', 'C:\\xampp\\mysql\\bin\\mysqldump.exe');
$stamp = date('Y-m-d_His');
$log = [];
$failed = false;

if (!is_dir($dir) && !mkdir($dir, 0770, true)) {
    fwrite(STDERR, "Can't create {$dir}\n");
    exit(1);
}

// Credentials for mysqldump, in a file only this run reads.
$cnf = tempnam(sys_get_temp_dir(), 'myc');
file_put_contents($cnf, sprintf("[client]\nuser=%s\npassword=\"%s\"\nhost=%s\nport=%s\n",
    Env::get('DB_USER', 'root'), addcslashes((string) Env::get('DB_PASS', ''), '"\\'), Env::get('DB_HOST', '127.0.0.1'), Env::get('DB_PORT', '3306')));

try {
    foreach (array_unique([Env::get('DB_NAME', 'chrismanager'), Env::get('GBA_DB_NAME', 'gba_database')]) as $db) {
        $out = "{$dir}\\{$db}_{$stamp}.sql.gz";
        $cmd = sprintf('"%s" --defaults-extra-file=%s --single-transaction --quick --routines --triggers --no-tablespaces --default-character-set=utf8mb4 %s',
            $mysqldump, escapeshellarg($cnf), escapeshellarg($db));
        $proc = proc_open($cmd, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        if (!is_resource($proc)) {
            $log[] = "FAIL {$db}: couldn't start mysqldump";
            $failed = true;
            continue;
        }
        $gz = gzopen($out, 'wb6');
        while (!feof($pipes[1])) {
            gzwrite($gz, (string) fread($pipes[1], 1 << 20));
        }
        gzclose($gz);
        $err = trim((string) stream_get_contents($pipes[2]));
        $code = proc_close($proc);
        if ($code !== 0) {
            @unlink($out);
            $log[] = "FAIL {$db}: mysqldump exited {$code}: " . mb_substr($err, 0, 300);
            $failed = true;
        } else {
            $log[] = sprintf('OK   %s: %s (%.1f MB)', $db, basename($out), filesize($out) / 1048576);
        }
    }
} finally {
    @unlink($cnf);
}

// Recordings: a mirror (files deleted in the app go from the mirror too; the dumps keep the database history).
$recordings = dirname(__DIR__) . '/' . trim(Env::get('STORAGE_PATH', 'storage/recordings'), '/');
if (is_dir($recordings)) {
    $target = "{$dir}\\recordings";
    exec(sprintf('robocopy %s %s /MIR /R:1 /W:1 /NFL /NDL /NJH /NP', escapeshellarg(str_replace('/', '\\', $recordings)), escapeshellarg($target)), $o, $code);
    // robocopy: 0-7 are success (copied / extra / mismatched), 8+ are failures.
    $log[] = $code < 8 ? 'OK   recordings mirrored to ' . $target : "FAIL recordings: robocopy exited {$code}";
    $failed = $failed || $code >= 8;
}

// Prune old dumps.
$pruned = 0;
foreach (glob("{$dir}\\*.sql.gz") ?: [] as $f) {
    if (filemtime($f) < time() - $keep * 86400) {
        $pruned += (int) @unlink($f);
    }
}
$log[] = "pruned {$pruned} dump(s) older than {$keep} days";

$line = sprintf("[%s] %s\n  %s\n", date('Y-m-d H:i:s'), $failed ? 'BACKUP FAILED' : 'backup ok', implode("\n  ", $log));
file_put_contents($dir . '\\backup.log', $line, FILE_APPEND);
echo $line;
exit($failed ? 1 : 0);
