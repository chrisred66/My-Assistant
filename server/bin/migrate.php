<?php

declare(strict_types=1);

// Applies database/migrations/*.sql to the app database, then database/gba-migrations/*.sql to the
// PT Management database (gba_database) if it's reachable, in order, once each.  Usage: php bin/migrate.php

use ChrisManager\Db;
use ChrisManager\HttpException;
use ChrisManager\Pt\GbaDb;

require dirname(__DIR__) . '/src/bootstrap.php';

/** Applies the .sql files in $dir not yet recorded in that database's schema_migrations table. */
function migrate(PDO $pdo, string $dir, string $label): void
{
    $pdo->exec('CREATE TABLE IF NOT EXISTS schema_migrations (
        version    VARCHAR(100) PRIMARY KEY,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');

    $applied = $pdo->query('SELECT version FROM schema_migrations')->fetchAll(PDO::FETCH_COLUMN);
    $files   = glob($dir . '/*.sql');
    sort($files);

    $count = 0;
    foreach ($files as $file) {
        $version = basename($file, '.sql');
        if (in_array($version, $applied, true)) {
            continue;
        }
        echo "[{$label}] Applying {$version}... ";
        // MySQL DDL auto-commits, so a failed migration can leave partial changes: fix and re-run by hand.
        foreach (preg_split('/;\s*(?:\r?\n|$)/', file_get_contents($file)) as $statement) {
            $sql = trim(preg_replace('/^\s*--.*$/m', '', $statement));
            if ($sql !== '') {
                $pdo->exec($sql);
            }
        }
        $pdo->prepare('INSERT INTO schema_migrations (version) VALUES (?)')->execute([$version]);
        echo "done\n";
        $count++;
    }
    echo $count === 0 ? "[{$label}] Database is up to date.\n" : "[{$label}] Applied {$count} migration(s).\n";
}

migrate(Db::pdo(), dirname(__DIR__) . '/database/migrations', 'app');

try {
    $gba = GbaDb::pdo();
} catch (HttpException $e) {
    echo "[gba] Skipped: {$e->getMessage()}\n";
    exit(0);
}
migrate($gba, dirname(__DIR__) . '/database/gba-migrations', 'gba');
