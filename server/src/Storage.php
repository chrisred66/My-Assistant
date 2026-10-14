<?php

declare(strict_types=1);

namespace ChrisManager;

/**
 * Audio storage allowance: 125 MB per person, recordings and meetings together. When a new recording takes someone
 * over it, the audio of their oldest recordings is removed until they're back under (the recording and its
 * transcript stay; it shows as "audio removed"). People can save a recording's audio to their own computer first
 * (GET /recordings/{id}/audio), and the app shows how much of the allowance is used.
 */
final class Storage
{
    public const LIMIT_BYTES = 125 * 1024 * 1024;

    /** Bytes of audio the user has stored. */
    public static function used(int $userId): int
    {
        return (int) (Db::one("SELECT SUM(size_bytes) AS b FROM recordings WHERE user_id = ? AND file_path <> ''", [$userId])['b'] ?? 0);
    }

    public static function summary(int $userId): array
    {
        return ['used_bytes' => self::used($userId), 'limit_bytes' => self::LIMIT_BYTES];
    }

    /**
     * Removes the oldest audio until the user is within the allowance, never touching $keepId (the recording just
     * saved). Returns the recordings whose audio was removed.
     *
     * @param callable(array): string $path absolute path of a recording's file
     * @return list<array{id: int, title: string, created_at: string}>
     */
    public static function enforce(int $userId, ?int $keepId, callable $path): array
    {
        $over = self::used($userId) - self::LIMIT_BYTES;
        if ($over <= 0) {
            return [];
        }
        $removed = [];
        $oldest = Db::all(
            "SELECT id, title, original_name, file_path, size_bytes, created_at FROM recordings
              WHERE user_id = ? AND file_path <> '' AND id <> ? ORDER BY created_at, id",
            [$userId, $keepId ?? 0],
        );
        foreach ($oldest as $rec) {
            if ($over <= 0) {
                break;
            }
            @unlink($path($rec));
            Db::run("UPDATE recordings SET file_path = '', size_bytes = 0, audio_removed_at = NOW() WHERE id = ?", [$rec['id']]);
            Meeting::deleteSamples((int) $rec['id']);
            $over -= (int) $rec['size_bytes'];
            $removed[] = ['id' => (int) $rec['id'], 'title' => $rec['title'] !== '' ? $rec['title'] : (string) $rec['original_name'], 'created_at' => $rec['created_at']];
        }
        return $removed;
    }
}
