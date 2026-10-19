<?php

declare(strict_types=1);

namespace ChrisManager\Ai;

/** Language names/codes from the speech and chat models, normalised to ISO 639-1 where known. */
final class Language
{
    // whisper-1 reports full English names; map the common ones to codes.
    private const NAMES = [
        'english' => 'en', 'arabic' => 'ar', 'chinese' => 'zh', 'french' => 'fr', 'german' => 'de',
        'spanish' => 'es', 'italian' => 'it', 'portuguese' => 'pt', 'russian' => 'ru', 'turkish' => 'tr',
        'persian' => 'fa', 'urdu' => 'ur', 'hindi' => 'hi', 'japanese' => 'ja', 'korean' => 'ko',
        'dutch' => 'nl', 'indonesian' => 'id', 'malay' => 'ms', 'tagalog' => 'tl', 'filipino' => 'tl',
        'bengali' => 'bn', 'hebrew' => 'he', 'greek' => 'el', 'polish' => 'pl', 'ukrainian' => 'uk',
        'swahili' => 'sw', 'thai' => 'th', 'vietnamese' => 'vi', 'somali' => 'so', 'amharic' => 'am',
    ];

    public static function normalize(string $value): ?string
    {
        $v = strtolower(trim($value));
        if ($v === '') {
            return null;
        }
        return self::NAMES[$v] ?? mb_substr($v, 0, 20);
    }

    /**
     * One sentence per line, so a transcript and its translation can be shown line by line. Text that already has
     * line breaks is left as it is.
     */
    public static function sentenceLines(string $text): string
    {
        $text = trim($text);
        if ($text === '' || str_contains($text, "\n")) {
            return $text;
        }
        $parts = preg_split('/(?<=[.!?…])\s+|(?<=[。！？؟])\s*/u', $text, -1, PREG_SPLIT_NO_EMPTY) ?: [$text];
        return implode("\n", array_map('trim', $parts));
    }

    public static function isEnglish(?string $code): bool
    {
        return $code === 'en';
    }

    /** The languages text can be translated into: code => name for the AI prompt. */
    public const TARGETS = [
        'en' => 'English', 'zh' => 'Simplified Chinese', 'ar' => 'Arabic', 'fr' => 'French', 'de' => 'German',
        'es' => 'Spanish', 'ru' => 'Russian', 'ja' => 'Japanese', 'ko' => 'Korean', 'hi' => 'Hindi', 'ur' => 'Urdu',
    ];

    /**
     * The language to translate into: the one asked for if it's offered, else the account's language (en or zh), else
     * English.
     */
    public static function target(mixed $asked, ?array $user): string
    {
        $asked = strtolower(trim((string) $asked));
        if (isset(self::TARGETS[$asked])) {
            return $asked;
        }
        $own = (string) ($user['language'] ?? 'en');
        return isset(self::TARGETS[$own]) ? $own : 'en';
    }

    /** The target's name for prompts ("Simplified Chinese"). */
    public static function targetName(string $target): string
    {
        return self::TARGETS[$target] ?? 'English';
    }

    /** Is text in $language already in $target ("zh-cn" counts as zh)? Unknown languages never are. */
    public static function isTarget(?string $language, string $target): bool
    {
        return $language !== null && explode('-', strtolower($language))[0] === $target;
    }
}
