<?php

declare(strict_types=1);

namespace ChrisManager\Ai;

use ChrisManager\Allowance;
use ChrisManager\Env;
use ChrisManager\Usage;

/** Speech-to-text via OpenAI's transcription endpoint. */
final class Transcriber
{
    private const URL = 'https://api.openai.com/v1/audio/transcriptions';

    private const EXTENSIONS = [
        'audio/mpeg' => 'mp3', 'audio/mp4' => 'm4a', 'audio/x-m4a' => 'm4a', 'audio/wav' => 'wav', 'audio/x-wav' => 'wav',
        'audio/webm' => 'webm', 'video/webm' => 'webm', 'audio/ogg' => 'ogg', 'video/mp4' => 'mp4', 'audio/flac' => 'flac',
    ];

    /**
     * @param ?string $language ISO 639-1 hint; null lets the model detect it
     * @param ?string $prompt   preceding text, so a chunk continues the sentence it belongs to
     * @return array{text: string, model: string, duration: ?float, language: ?string}
     */
    public static function transcribe(
        int $userId,
        string $filePath,
        string $mimeType,
        ?string $language = null,
        ?string $prompt = null,
        string $feature = 'transcribe',
    ): array {
        Allowance::checkTranscribe($userId); // today's transcription time (Paid: 60 minutes)
        $model = Env::get('OPENAI_TRANSCRIBE_MODEL', 'whisper-1');

        // OpenAI infers the format from the file name, and PHP's upload temp files have none ("php1A2B.tmp").
        $name = basename($filePath);
        if (!preg_match('/\.(flac|m4a|mp3|mp4|mpeg|mpga|oga|ogg|wav|webm)$/i', $name)) {
            $name .= '.' . (self::EXTENSIONS[$mimeType] ?? 'webm');
        }

        $fields = [
            'file'            => new \CURLFile($filePath, $mimeType, $name),
            'model'           => $model,
            // whisper-1 returns the duration and detected language in verbose_json; newer models return token usage in json.
            'response_format' => $model === 'whisper-1' ? 'verbose_json' : 'json',
        ];
        if ($language !== null) {
            $fields['language'] = $language;
        }
        if ($prompt !== null && trim($prompt) !== '') {
            $fields['prompt'] = mb_substr(trim($prompt), -800); // only the tail is useful context
        }
        $data = HttpClient::postMultipart(self::URL, Env::require('OPENAI_API_KEY'), $fields);

        $usage    = $data['usage'] ?? [];
        $duration = isset($data['duration']) ? (float) $data['duration']
                  : (isset($usage['seconds']) ? (float) $usage['seconds'] : null);

        Usage::log([
            'user_id'       => $userId,
            'provider'      => 'openai',
            'model'         => $model,
            'feature'       => $feature,
            'input_tokens'  => (int) ($usage['input_tokens'] ?? 0),
            'output_tokens' => (int) ($usage['output_tokens'] ?? 0),
            'audio_seconds' => $duration,
        ]);

        // On near-silence Whisper can invent text ("Thank you for watching"). verbose_json scores each
        // segment, so drop the ones that are probably not speech.
        $text = (string) ($data['text'] ?? '');
        if (isset($data['segments']) && is_array($data['segments'])) {
            // Measured: 1 s of silence came back as "you" with no_speech_prob 0.94, avg_logprob -0.51.
            $speech = array_filter($data['segments'], function ($s) {
                $noSpeech = (float) ($s['no_speech_prob'] ?? 0);
                return !($noSpeech >= 0.8 || ($noSpeech > 0.6 && (float) ($s['avg_logprob'] ?? 0) < -1.0));
            });
            $text = implode(' ', array_map(fn ($s) => trim((string) ($s['text'] ?? '')), $speech));
        }

        return [
            'text'     => trim($text),
            'model'    => $model,
            'duration' => $duration,
            'language' => isset($data['language']) ? Language::normalize((string) $data['language']) : $language,
        ];
    }
}
