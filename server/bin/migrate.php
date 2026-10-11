<?php

declare(strict_types=1);

// Applies database/migrations/*.sql in order, once each.  Usage: php bin/migrate.php

use ChrisManager\Db;

require dirname(__DIR__) . '/src/bootstrap.php';

$pdo = Db::pdo();
$pdo->exec('CREATE TABLE IF NOT EXISTS schema_migrations (
    version    VARCHAR(100) PRIMARY KEY,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');

$applied = array_column(Db::all('SELECT version FROM schema_migrations'), 'version');
$files   = glob(dirname(__DIR__) . '/database/migrations/*.sql');
sort($files);

$count = 0;
foreach ($files as $file) {
    $version = basename($file, '.sql');
    if (in_array($version, $applied, true)) {
        continue;
    }
    echo "Applying {$version}... ";
    // MySQL DDL auto-commits, so a failed migration can leave partial changes: fix and re-run by hand.
    foreach (preg_split('/;\s*(?:\r?\n|$)/', file_get_contents($file)) as $statement) {
        $sql = trim(preg_replace('/^\s*--.*$/m', '', $statement));
        if ($sql !== '') {
            $pdo->exec($sql);
        }
    }
    Db::insert('schema_migrations', ['version' => $version]);
    echo "done\n";
    $count++;
}

echo $count === 0 ? "Database is up to date.\n" : "Applied {$count} migration(s).\n";
