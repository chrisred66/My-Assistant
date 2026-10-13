<?php

declare(strict_types=1);

namespace ChrisManager\Pt;

use ChrisManager\Env;
use ChrisManager\HttpException;
use PDO;

/**
 * Connection to the GBA (Green Bus) database, kept separate from My Assistant's own database so
 * the original data can be imported and exported as-is.
 *   GBA_DB_NAME (default gba_database); GBA_DB_USER / GBA_DB_PASS default to DB_USER / DB_PASS.
 */
final class GbaDb
{
    private static ?PDO $pdo = null;

    public static function pdo(): PDO
    {
        if (self::$pdo === null) {
            $dsn = sprintf(
                'mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4',
                Env::get('DB_HOST', '127.0.0.1'),
                Env::get('DB_PORT', '3306'),
                self::name(),
            );
            try {
                self::$pdo = new PDO($dsn, Env::get('GBA_DB_USER') ?? Env::require('DB_USER'), Env::get('GBA_DB_PASS') ?? Env::get('DB_PASS', ''), [
                    PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                    PDO::ATTR_EMULATE_PREPARES   => false,
                ]);
            } catch (\PDOException $e) {
                throw new HttpException(503, 'The PT Management database is not available: ' . self::reason($e));
            }
            self::$pdo->exec("SET time_zone = '" . date('P') . "'");
        }
        return self::$pdo;
    }

    public static function name(): string
    {
        return Env::get('GBA_DB_NAME', 'gba_database');
    }

    public static function all(string $sql, array $params = []): array
    {
        $stmt = self::pdo()->prepare($sql);
        $stmt->execute($params);
        return $stmt->fetchAll();
    }

    public static function one(string $sql, array $params = []): ?array
    {
        $stmt = self::pdo()->prepare($sql);
        $stmt->execute($params);
        return $stmt->fetch() ?: null;
    }

    public static function run(string $sql, array $params = []): \PDOStatement
    {
        $stmt = self::pdo()->prepare($sql);
        $stmt->execute($params);
        return $stmt;
    }

    /** Connection state and row counts, for the PT tab's setup screen. */
    public static function status(): array
    {
        try {
            $pdo = self::pdo();
        } catch (HttpException $e) {
            return ['connected' => false, 'database' => self::name(), 'error' => $e->getMessage()];
        }
        $tables = [];
        foreach ($pdo->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN) as $t) {
            $tables[$t] = (int) $pdo->query('SELECT COUNT(*) FROM `' . str_replace('`', '``', $t) . '`')->fetchColumn();
        }
        return ['connected' => true, 'database' => self::name(), 'tables' => $tables];
    }

    private static function reason(\PDOException $e): string
    {
        return match ((int) ($e->errorInfo[1] ?? 0)) {
            1049    => 'database "' . self::name() . '" does not exist yet (import it first)',
            // MySQL reports a database that doesn't exist as "access denied" to users without global rights.
            1044    => 'database "' . self::name() . '" does not exist yet, or the app\'s database user has no access to it',
            1045    => 'the database user or password is wrong',
            default => $e->getMessage(),
        };
    }
}
