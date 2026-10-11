<?php

declare(strict_types=1);

namespace ChrisManager;

/** Thrown anywhere in a request to return a JSON error with the given status. */
final class HttpException extends \RuntimeException
{
    public function __construct(public readonly int $status, string $message)
    {
        parent::__construct($message);
    }
}
