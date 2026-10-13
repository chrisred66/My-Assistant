<?php

declare(strict_types=1);

namespace ChrisManager;

/**
 * Mainland China's public holidays (the State Council's yearly schedule), for DeepSeek's off-peak pricing.
 *
 * The dates come from the open holiday-cn dataset (github.com/NateScarlet/holiday-cn, built from the gov.cn notices),
 * one file per year, cached in storage/cn-holidays/ and re-read monthly (daily while a year's schedule hasn't been
 * published yet, as it's announced late in the year before). If a year can't be fetched, the cached copy is used, or
 * else no holidays are assumed for it (DeepSeek calls then cost the peak rate on those days, the safe side).
 */
final class ChinaHolidays
{
    private const URL = 'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/%d.json';
    private const DIR = '/storage/cn-holidays';

    /** @var array<int, array<string, string>> year => [date => holiday name] (days off only) */
    private static array $years = [];

    /** Whether the date (Y-m-d) is a day off for a public holiday in mainland China. */
    public static function isHoliday(string $date): bool
    {
        return self::name($date) !== null;
    }

    /** The holiday's name (e.g. 国庆节) when the date is a day off for it, else null. */
    public static function name(string $date): ?string
    {
        $year = (int) substr($date, 0, 4);
        self::$years[$year] ??= self::load($year);
        return self::$years[$year][$date] ?? null;
    }

    /** @return array<string, string> */
    private static function load(int $year): array
    {
        $file = dirname(__DIR__) . self::DIR . "/{$year}.json";
        $cached = is_file($file) ? json_decode((string) file_get_contents($file), true) : null;
        $age = is_file($file) ? time() - filemtime($file) : PHP_INT_MAX;
        $published = is_array($cached) && !empty($cached['days']);
        // Past years don't change; this year and next are re-checked (monthly, or daily until they're published).
        $stale = $year >= (int) date('Y') && $age > ($published ? 30 * 86400 : 86400);
        if (!is_array($cached) || $stale) {
            $fresh = self::fetch($year);
            if ($fresh !== null) {
                @mkdir(dirname($file), 0775, true);
                file_put_contents($file, json_encode($fresh, JSON_UNESCAPED_UNICODE));
                $cached = $fresh;
            } elseif (is_file($file)) {
                touch($file); // keep the old copy; try again later rather than on every call
            }
        }
        $out = [];
        foreach ((array) ($cached['days'] ?? []) as $d) {
            if (!empty($d['isOffDay']) && is_string($d['date'] ?? null)) {
                $out[$d['date']] = (string) ($d['name'] ?? '');
            }
        }
        return $out;
    }

    private static function fetch(int $year): ?array
    {
        $c = curl_init(sprintf(self::URL, $year));
        curl_setopt_array($c, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10, CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_USERAGENT => 'My-Assistant (DeepSeek off-peak pricing)']);
        $body = curl_exec($c);
        $status = curl_getinfo($c, CURLINFO_HTTP_CODE);
        curl_close($c);
        $data = $status === 200 && is_string($body) ? json_decode($body, true) : null;
        if (!is_array($data) || ($data['year'] ?? null) !== $year || !is_array($data['days'] ?? null)) {
            error_log("China holidays {$year}: couldn't fetch the schedule (HTTP {$status})");
            return null;
        }
        return ['year' => $year, 'papers' => $data['papers'] ?? [], 'days' => $data['days']];
    }
}
