<?php

declare(strict_types=1);

namespace ChrisManager;

final class Request
{
    private ?array $json = null;
    public array $params = [];     // route parameters like {id}
    public ?array $user = null;    // set by Auth::requireUser()

    public function __construct(public readonly string $method, public readonly string $path)
    {
    }

    public static function fromGlobals(): self
    {
        $uri  = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
        $base = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '')), '/');
        if ($base !== '' && str_starts_with($uri, $base)) {
            $uri = substr($uri, strlen($base));
        }
        return new self(strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET'), '/' . trim($uri, '/'));
    }

    /** Field from a JSON body, falling back to form fields (multipart uploads). */
    public function input(string $key, mixed $default = null): mixed
    {
        if ($this->json === null) {
            $raw = file_get_contents('php://input');
            $this->json = ($raw !== '' && $raw !== false) ? (json_decode($raw, true) ?? []) : [];
        }
        return $this->json[$key] ?? $_POST[$key] ?? $default;
    }

    public function query(string $key, mixed $default = null): mixed
    {
        return $_GET[$key] ?? $default;
    }

    public function bearerToken(): ?string
    {
        $header = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
        return preg_match('/^Bearer\s+(\S+)$/i', $header, $m) ? $m[1] : null;
    }

    public function userId(): int
    {
        return (int) $this->user['id'];
    }
}
