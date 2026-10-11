<?php

declare(strict_types=1);

namespace ChrisManager\Ai;

use Anthropic\Client;
use Anthropic\Core\Exceptions\APIConnectionException;
use Anthropic\Core\Exceptions\APIStatusException;
use Anthropic\Core\Exceptions\AuthenticationException;
use Anthropic\Core\Exceptions\RateLimitException;
use ChrisManager\Env;
use ChrisManager\HttpException;

/** Claude via the official Anthropic PHP SDK. */
final class AnthropicProvider implements ChatProvider
{
    public function name(): string
    {
        return 'anthropic';
    }

    public function defaultModel(): string
    {
        return Env::get('ANTHROPIC_MODEL', 'claude-opus-5-5');
    }

    public function complete(string $system, string $user, string $model, ?string $effort = null): ChatResult
    {
        // Keys not scoped to a workspace must name one on every request.
        $workspace = Env::get('ANTHROPIC_WORKSPACE_ID', '');
        $client    = new Client(
            apiKey: Env::require('ANTHROPIC_API_KEY'),
            requestOptions: $workspace !== '' ? ['extraHeaders' => ['anthropic-workspace-id' => $workspace]] : null,
        );

        try {
            // Beta endpoint for server-side fallbacks: if a safety classifier declines the request,
            // the API retries it on a suitable fallback model instead of just stopping.
            $message = $client->beta->messages->create(
                model: $model,
                maxTokens: 16000,
                system: $system,
                messages: [['role' => 'user', 'content' => $user]],
                outputConfig: ['effort' => $effort ?? Env::get('ANTHROPIC_EFFORT', 'medium')],
                fallbacks: 'default',
                betas: ['server-side-fallback-2026-07-01'],
            );
        } catch (RateLimitException) {
            throw new HttpException(429, 'Anthropic rate limit reached, try again shortly');
        } catch (AuthenticationException) {
            throw new HttpException(502, 'Anthropic rejected the API key (check ANTHROPIC_API_KEY)');
        } catch (APIStatusException $e) {
            throw new HttpException(502, "Anthropic error ({$e->status}): " . mb_substr($e->getMessage(), 0, 500));
        } catch (APIConnectionException $e) {
            throw new HttpException(502, 'Cannot reach Anthropic: ' . $e->getMessage());
        }

        if ($message->stopReason === 'refusal') {
            $category = $message->stopDetails?->category ?? 'unspecified';
            throw new HttpException(422, "Claude declined this request (category: {$category})");
        }

        $text = '';
        foreach ($message->content as $block) {
            if ($block->type === 'text') {
                $text .= $block->text;
            }
        }

        return new ChatResult(
            text: trim($text),
            model: $message->model, // reports the fallback model if one answered
            inputTokens: $message->usage->inputTokens,
            outputTokens: $message->usage->outputTokens,
            cacheReadTokens: $message->usage->cacheReadInputTokens ?? 0,
            cacheWriteTokens: $message->usage->cacheCreationInputTokens ?? 0,
            requestId: $message->id,
        );
    }
}
