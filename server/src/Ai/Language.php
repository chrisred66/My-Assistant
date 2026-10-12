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
}
