<?php

declare(strict_types=1);

namespace ChrisManager\Ai;

use ChrisManager\Env;
use ChrisManager\HttpException;

/**
 * Which provider does which job. Fixed on the server (clients don't choose):
 *   translation    -> TRANSLATE_PROVIDER (default anthropic / Claude)
 *   transcription  -> OpenAI (the only speech-to-text integration; see Transcriber)
 *   light tasks    -> LIGHT_PROVIDER (default deepseek): small, cheap calls such as language detection
 */
final class Routing
{
    public static function translator(): ChatProvider
    {
        return self::chat(Env::get('TRANSLATE_PROVIDER', 'anthropic'), 'TRANSLATE_PROVIDER');
    }

    public static function light(): ChatProvider
    {
        return self::chat(Env::get('LIGHT_PROVIDER', 'deepseek'), 'LIGHT_PROVIDER');
    }

    /** For display: provider and default model per job. */
    public static function describe(): array
    {
        $model = static function (ChatProvider $p): ?string {
            try {
                return $p->defaultModel();
            } catch (HttpException) {
                return null; // model not configured
            }
        };
        $translate = self::translator();
        $light     = self::light();
        return [
            'translate'  => ['provider' => $translate->name(), 'model' => $model($translate)],
            'transcribe' => ['provider' => 'openai', 'model' => Env::get('OPENAI_TRANSCRIBE_MODEL', 'whisper-1')],
            'light'      => ['provider' => $light->name(), 'model' => $model($light)],
        ];
    }

    private static function chat(string $name, string $setting): ChatProvider
    {
        return match ($name) {
            'anthropic'          => new AnthropicProvider(),
            'openai', 'deepseek' => new OpenAiCompatProvider($name),
            default              => throw new HttpException(500, "{$setting} must be anthropic, openai or deepseek"),
        };
    }
}
