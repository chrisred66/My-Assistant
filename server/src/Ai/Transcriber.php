<?php

declare(strict_types=1);

namespace ChrisManager\Ai;

use ChrisManager\Env;
use ChrisManager\Usage;

/** Speech-to-text via OpenAI's transcription endpoint. */
final class Transcriber
{
    private const URL = 'https://api.openai.com/v1/audio/transcriptions';

    /** @return array{text: string, model: string, duration: ?float} */
    public static function transcribe(int $userId, string $filePath, string $mimeType, string $language = 'ar'): array
    {
        $model = Env::get('OPENAI_TRANSCRIBE_MODEL', 'whisper-1');

        $data = HttpClient::postMultipart(self::URL, Env::require('OPENAI_API_KEY'), [
            'file'            => new \CURLFile($filePath, $mimeType, basename($filePath)),
            'model'           => $model,
            'language'        => $language,
            // whisper-1 returns the audio duration in verbose_json; newer models return token usage in json.
            'response_format' => $model === 'whisper-1' ? 'verbose_json' : 'json',
        ]);

        $usage    = $data['usage'] ?? [];
        $duration = isset($data['duration']) ? (float) $data['duration']
                  : (isset($usage['seconds']) ? (float) $usage['seconds'] : null);

        Usage::log([
            'user_id'       => $userId,
            'provider'      => 'openai',
            'model'         => $model,
            'feature'       => 'transcribe',
            'input_tokens'  => (int) ($usage['input_tokens'] ?? 0),
            'output_tokens' => (int) ($usage['output_tokens'] ?? 0),
            'audio_seconds' => $duration,
        ]);

        return ['text' => trim((string) ($data['text'] ?? '')), 'model' => $model, 'duration' => $duration];
    }
}
