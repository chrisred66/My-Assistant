<?php

declare(strict_types=1);

namespace ChrisManager;

/**
 * The server's messages (errors, limits) in the app's language: the app sends Accept-Language with every request
 * (zh-CN or en), and messages are translated from src/i18n/zh.php, keyed by their English text. A key may contain
 * {placeholders}, which match any text in the message and are put back into the translation, so messages with
 * numbers or names in them are found too. Anything without a translation stays English.
 */
final class I18n
{
    /** @var array<string, string>|null */
    private static ?array $zh = null;
    /** @var list<array{0: string, 1: string, 2: list<string>, 3: int}>|null regex, translation, placeholder names, fixed length */
    private static ?array $patterns = null;

    public static function lang(): string
    {
        return preg_match('/^\s*zh/i', (string) ($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? '')) ? 'zh' : 'en';
    }

    public static function t(string $message): string
    {
        if (self::lang() !== 'zh' || $message === '') {
            return $message;
        }
        self::$zh ??= require __DIR__ . '/i18n/zh.php';
        if (isset(self::$zh[$message])) {
            return self::$zh[$message];
        }
        if (self::$patterns === null) {
            self::$patterns = [];
            foreach (self::$zh as $en => $zh) {
                if (!str_contains($en, '{')) {
                    continue;
                }
                preg_match_all('/\{(\w+)\}/', $en, $names);
                $regex = '/^' . preg_replace_callback('/\\\{(\w+)\\\}/', fn () => '(.+?)', preg_quote($en, '/')) . '$/us';
                self::$patterns[] = [$regex, $zh, $names[1], mb_strlen(preg_replace('/\{\w+\}/', '', $en))];
            }
            // The most specific first: "Category must be one of: {list}" before "{key} must be one of: {allowed}".
            usort(self::$patterns, fn ($a, $b) => $b[3] <=> $a[3]);
        }
        foreach (self::$patterns as [$regex, $zh, $names]) {
            if (preg_match($regex, $message, $m)) {
                $values = [];
                foreach ($names as $i => $name) {
                    // A filled-in part may be a message itself ("Trip 3: {reason}").
                    $values['{' . $name . '}'] = self::t($m[$i + 1]);
                }
                return strtr($zh, $values);
            }
        }
        return $message;
    }
}
