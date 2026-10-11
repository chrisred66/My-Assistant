<?php

declare(strict_types=1);

namespace ChrisManager\Ai;

final class ChatResult
{
    public function __construct(
        public readonly string $text,
        public readonly string $model,
        public readonly int $inputTokens,
        public readonly int $outputTokens,
        public readonly int $cacheReadTokens = 0,
        public readonly int $cacheWriteTokens = 0,
        public readonly ?string $requestId = null,
    ) {
    }
}
