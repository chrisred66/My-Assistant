<?php

declare(strict_types=1);

namespace ChrisManager;

/**
 * Daily allowances, which keep AI costs predictable (they reset at midnight, server time):
 *
 *   Translation  Free 300 words, Paid 3,000 words: every translation (Translate page, recordings, live text, meetings)
 *                counts the words of the original text. Chinese and Japanese have no spaces, so two characters count
 *                as one word. English text is never translated, so it never counts.
 *   Transcription  Paid 60 minutes of audio: live recording, transcribing a recording and meetings together. Free
 *                accounts can't transcribe at all (Auth::requireTranscription).
 *
 * The Super Admin isn't limited (unless acting in another role, which is then limited like that role). Allowances
 * apply to the signed-in person making the request (Auth::current); server jobs (e.g. the Daily Feed) aren't limited.
 */
final class Allowance
{
    public const WORDS = ['free' => 300, 'paid' => 3000];
    public const TRANSCRIBE_SECONDS = ['paid' => 3600];
    private const TRANSCRIBE_FEATURES = ['transcribe', 'live_transcribe', 'meeting_transcribe'];

    /** Words for the allowance: space-separated words, plus one per two Chinese / Japanese characters. */
    public static function words(string $text): int
    {
        $cjk = preg_match_all('/[\p{Han}\p{Hiragana}\p{Katakana}]/u', $text);
        $rest = preg_replace('/[\p{Han}\p{Hiragana}\p{Katakana}]/u', ' ', $text) ?? $text;
        return preg_match_all('/[\p{L}\p{N}]+/u', $rest) + (int) ceil($cjk / 2);
    }

    /** The person whose allowance a call counts against: the signed-in user, when it's them. */
    private static function limited(int $userId): ?array
    {
        $user = Auth::current();
        if ($user === null || (int) $user['id'] !== $userId || $user['role'] === 'super_admin') {
            return null;
        }
        return $user;
    }

    /** Today's word limit for the user (null: unlimited). */
    public static function wordLimit(array $user): ?int
    {
        return $user['role'] === 'super_admin' ? null : (self::WORDS[Auth::generalPlan($user)] ?? 0);
    }

    public static function wordsUsed(int $userId): int
    {
        return (int) (Db::one('SELECT words FROM translation_words WHERE user_id = ? AND day = CURDATE()', [$userId])['words'] ?? 0);
    }

    /** Throws 429 when translating $words more would go over today's limit. */
    public static function checkWords(int $userId, int $words): void
    {
        $user = self::limited($userId);
        if ($user === null || $words === 0) {
            return;
        }
        $limit = self::wordLimit($user);
        $left = max(0, $limit - self::wordsUsed($userId));
        if ($words > $left) {
            throw new HttpException(429, $left === 0
                ? "Today's translation allowance ({$limit} words) is used up. It resets at midnight."
                : "This needs about {$words} words of translation, but {$left} of today's {$limit} are left. Try a shorter text, or tomorrow.");
        }
    }

    public static function addWords(int $userId, int $words): void
    {
        if (self::limited($userId) === null || $words === 0) {
            return;
        }
        Db::run('INSERT INTO translation_words (user_id, day, words) VALUES (?, CURDATE(), ?) ON DUPLICATE KEY UPDATE words = words + VALUES(words)',
            [$userId, $words]);
    }

    /** Today's transcription limit in seconds (null: unlimited; 0: none). */
    public static function transcribeLimit(array $user): ?int
    {
        return $user['role'] === 'super_admin' ? null : (self::TRANSCRIBE_SECONDS[Auth::generalPlan($user)] ?? 0);
    }

    /** Audio transcribed today, from the usage log (every transcription logs its length). */
    public static function secondsUsed(int $userId): float
    {
        $in = implode(',', array_fill(0, count(self::TRANSCRIBE_FEATURES), '?'));
        return (float) (Db::one(
            "SELECT SUM(audio_seconds) AS s FROM token_usage
              WHERE user_id = ? AND source = 'relay' AND feature IN ({$in}) AND occurred_at >= CURDATE()",
            [$userId, ...self::TRANSCRIBE_FEATURES],
        )['s'] ?? 0);
    }

    /** Throws 429 when today's transcription time is used up (or $seconds more wouldn't fit, when known). */
    public static function checkTranscribe(int $userId, ?float $seconds = null): void
    {
        $user = self::limited($userId);
        if ($user === null) {
            return;
        }
        $limit = self::transcribeLimit($user);
        $left = max(0.0, $limit - self::secondsUsed($userId));
        if ($left <= 0 || ($seconds !== null && $seconds > $left)) {
            $minutes = intdiv($limit, 60);
            throw new HttpException(429, $left <= 0
                ? "Today's transcription time ({$minutes} minutes) is used up. It resets at midnight; recording still works."
                : sprintf('This recording is %d minutes, but %d of today\'s %d minutes of transcription are left.', (int) ceil($seconds / 60), (int) floor($left / 60), $minutes));
        }
    }

    /** For the app: today's allowances and use (null limits: unlimited). */
    public static function summary(array $user): array
    {
        $id = (int) $user['id'];
        $words = self::wordLimit($user);
        $seconds = self::transcribeLimit($user);
        return [
            'words'              => ['limit' => $words, 'used' => self::wordsUsed($id)],
            'transcribe_minutes' => ['limit' => $seconds === null ? null : intdiv($seconds, 60), 'used' => (int) floor(self::secondsUsed($id) / 60)],
        ];
    }
}
