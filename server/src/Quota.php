<?php

declare(strict_types=1);

namespace ChrisManager;

/**
 * Free plan's daily translation allowance (Auth::FREE_TRANSLATIONS_PER_DAY): each Translate-page request counts once
 * ("translate:{transcript id}"). Free accounts can't transcribe, so recordings never reach translation; the
 * "recording:{id}" refs only matter if an account's plan changes. Other accounts are never limited.
 */
final class Quota
{
    public static function usedToday(int $userId): int
    {
        return (int) Db::one('SELECT COUNT(*) AS n FROM translation_quota WHERE user_id = ? AND day = CURDATE()', [$userId])['n'];
    }

    /** Whether the user may translate $ref now: not limited, already counted, or still under today's limit. */
    public static function allows(array $user, string $ref): bool
    {
        if (!Auth::isFree($user)) {
            return true;
        }
        if (Db::one('SELECT 1 FROM translation_quota WHERE user_id = ? AND ref = ?', [$user['id'], $ref]) !== null) {
            return true;
        }
        return self::usedToday((int) $user['id']) < Auth::FREE_TRANSLATIONS_PER_DAY;
    }

    /** Throws the plan's message when $ref can't be translated now. */
    public static function check(array $user, string $ref): void
    {
        if (!self::allows($user, $ref)) {
            throw new HttpException(429, self::message());
        }
    }

    /** Counts $ref against today's allowance (once; later calls for the same ref do nothing). */
    public static function consume(array $user, string $ref): void
    {
        if (Auth::isFree($user)) {
            Db::run('INSERT IGNORE INTO translation_quota (user_id, ref, day) VALUES (?, ?, CURDATE())', [$user['id'], $ref]);
        }
    }

    public static function message(): string
    {
        return 'The free plan includes ' . Auth::FREE_TRANSLATIONS_PER_DAY . ' translations a day, and today\'s are used up. '
            . 'Translation is available again tomorrow; recording still works.';
    }
}
