<?php

declare(strict_types=1);

namespace ChrisManager;

/** Minimal .env loader: KEY=value lines, # comments, optional quotes. */
final class Env
{
    private static array $values = [];

    public static function load(string $path): void
    {
        if (!is_file($path)) {
            throw new \RuntimeException("Missing .env file at {$path} (copy .env.example)");
        }
        foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            $line = trim($line);
            if ($line === '' || $line[0] === '#' || !str_contains($line, '=')) {
                continue;
            }
            [$key, $value] = array_map('trim', explode('=', $line, 2));
            if ($value !== '' && ($value[0] === '"' || $value[0] === "'")) {
                $value = trim($value, $value[0]);
            } else {
                // A comment may follow whitespace, or be all there is once an empty value is trimmed.
                $value = trim(preg_replace('/(^|\s+)#.*$/', '', $value));
            }
            self::$values[$key] = $value;
        }
    }

    public static function get(string $key, ?string $default = null): ?string
    {
        $value = self::$values[$key] ?? getenv($key);
        return ($value === false || $value === '') ? $default : $value;
    }

    public static function require(string $key): string
    {
        $value = self::get($key);
        if ($value === null) {
            throw new HttpException(500, "Server is missing config value {$key}");
        }
        return $value;
    }

    public static function bool(string $key, bool $default = false): bool
    {
        $value = self::get($key);
        return $value === null ? $default : filter_var($value, FILTER_VALIDATE_BOOLEAN);
    }
}
