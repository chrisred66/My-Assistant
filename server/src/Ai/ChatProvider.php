<?php

declare(strict_types=1);

namespace ChrisManager\Ai;

interface ChatProvider
{
    public function name(): string;

    public function defaultModel(): string;

    /**
     * One system + user turn, returning the reply text and token usage.
     * $effort overrides the provider's configured reasoning effort where it has one (e.g. "low" for live chunks).
     */
    public function complete(string $system, string $user, string $model, ?string $effort = null): ChatResult;
}
