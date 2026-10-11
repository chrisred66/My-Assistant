<?php

declare(strict_types=1);

namespace ChrisManager\Ai;

interface ChatProvider
{
    public function name(): string;

    public function defaultModel(): string;

    /** One system + user turn, returning the reply text and token usage. */
    public function complete(string $system, string $user, string $model): ChatResult;
}
