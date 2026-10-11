<?php

declare(strict_types=1);

namespace ChrisManager;

/**
 * Resolves APP_TIMEZONE. "system" (or empty) follows the operating system's timezone, so the
 * server's clock matches the desktop's; anything else must be an IANA name like "Asia/Dubai".
 */
final class Timezone
{
    private const CACHE_TTL = 3600; // re-check the OS setting hourly

    public static function resolve(?string $setting, string $cacheFile): string
    {
        $setting = trim((string) $setting);
        if ($setting !== '' && strcasecmp($setting, 'system') !== 0) {
            return self::valid($setting) ? $setting : 'UTC';
        }

        if (is_file($cacheFile) && time() - filemtime($cacheFile) < self::CACHE_TTL) {
            $cached = trim((string) file_get_contents($cacheFile));
            if (self::valid($cached)) {
                return $cached;
            }
        }

        $detected = self::detect();
        if ($detected !== null) {
            @file_put_contents($cacheFile, $detected);
            return $detected;
        }
        $ini = (string) ini_get('date.timezone');
        return self::valid($ini) ? $ini : 'UTC';
    }

    private static function detect(): ?string
    {
        if (PHP_OS_FAMILY === 'Windows') {
            // tzutil gives the Windows name ("Arabian Standard Time"); intl maps it to IANA ("Asia/Dubai").
            $windowsName = trim((string) @shell_exec('tzutil /g'));
            if ($windowsName === '' || !class_exists(\IntlTimeZone::class)) {
                return null;
            }
            $id = \IntlTimeZone::getIDForWindowsID($windowsName);
            return is_string($id) && self::valid($id) ? $id : null;
        }

        if (is_file('/etc/timezone')) {
            $id = trim((string) file_get_contents('/etc/timezone'));
            if (self::valid($id)) {
                return $id;
            }
        }
        $link = @readlink('/etc/localtime');
        if (is_string($link) && preg_match('#zoneinfo/(.+)$#', $link, $m) && self::valid($m[1])) {
            return $m[1];
        }
        return null;
    }

    private static function valid(string $id): bool
    {
        return $id !== '' && in_array($id, \DateTimeZone::listIdentifiers(\DateTimeZone::ALL_WITH_BC), true);
    }
}
