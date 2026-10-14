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

    /**
     * The translator for one call: the configured one, or, for a model the Super Admin chose, that model's own
     * provider (so a Claude model goes to Anthropic even while translation is routed to DeepSeek).
     */
    public static function translatorFor(?string $model): ChatProvider
    {
        if ($model === null || $model === '') {
            return self::translator();
        }
        return match (true) {
            str_starts_with($model, 'claude-')                                              => new AnthropicProvider(),
            str_starts_with($model, 'gpt-') || preg_match('/^o\d/', $model) === 1          => new OpenAiCompatProvider('openai'),
            str_starts_with($model, 'deepseek-')                                            => new OpenAiCompatProvider('deepseek'),
            default => throw new HttpException(422, 'Unknown model: choose a claude-, gpt- or deepseek- model'),
        };
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
            // PT charging AI schedule (Pt\ChargingAi) always uses DeepSeek: it needs JSON-mode replies.
            'charging'   => ['provider' => 'deepseek', 'model' => $model(new OpenAiCompatProvider('deepseek'))],
            // Learning from transcript edits and applying them (Habits): Chinese through DeepSeek, others through OpenAI.
            'habits_zh'    => Habits::describe()['zh'],
            'habits_other' => Habits::describe()['other'],
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
