<?php

declare(strict_types=1);

namespace ChrisManager\Ai;

use ChrisManager\Env;
use ChrisManager\HttpException;

/** OpenAI and DeepSeek share the Chat Completions request/response shape. */
final class OpenAiCompatProvider implements ChatProvider
{
    private const ENDPOINTS = [
        'openai'   => ['https://api.openai.com/v1/chat/completions', 'OPENAI_API_KEY', 'OPENAI_CHAT_MODEL'],
        'deepseek' => ['https://api.deepseek.com/chat/completions', 'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL'],
    ];

    public function __construct(private readonly string $provider)
    {
        if (!isset(self::ENDPOINTS[$provider])) {
            throw new \InvalidArgumentException("Unknown provider {$provider}");
        }
    }

    public function name(): string
    {
        return $this->provider;
    }

    public function defaultModel(): string
    {
        $model = Env::get(self::ENDPOINTS[$this->provider][2]);
        if ($model === null) {
            error_log('Set ' . self::ENDPOINTS[$this->provider][2] . ' in server/.env');
            throw new HttpException(500, 'An AI model isn\'t configured on the server (see server/.env)');
        }
        return $model;
    }

    /** $json: ask for a JSON object reply (response_format json_object; the prompt must mention JSON). */
    public function complete(string $system, string $user, string $model, ?string $effort = null, bool $json = false, ?int $maxTokens = null): ChatResult
    {
        [$url, $keyVar] = self::ENDPOINTS[$this->provider];
        $body = [
            'model'    => $model,
            'messages' => [
                ['role' => 'system', 'content' => $system],
                ['role' => 'user', 'content' => $user],
            ],
        ];
        if ($json) {
            $body['response_format'] = ['type' => 'json_object'];
        }
        if ($maxTokens !== null) {
            $body['max_tokens'] = $maxTokens;
        }
        $data = HttpClient::postJson($url, Env::require($keyVar), $body, 180);

        $usage = $data['usage'] ?? [];
        // OpenAI reports cached input under prompt_tokens_details; DeepSeek uses prompt_cache_hit_tokens.
        // Both count cached tokens inside prompt_tokens, so subtract them to avoid double-counting.
        $cached = (int) ($usage['prompt_tokens_details']['cached_tokens'] ?? $usage['prompt_cache_hit_tokens'] ?? 0);

        return new ChatResult(
            text: trim((string) ($data['choices'][0]['message']['content'] ?? '')),
            model: (string) ($data['model'] ?? $model),
            inputTokens: max(0, (int) ($usage['prompt_tokens'] ?? 0) - $cached),
            outputTokens: (int) ($usage['completion_tokens'] ?? 0),
            cacheReadTokens: $cached,
            requestId: $data['id'] ?? null,
        );
    }
}
