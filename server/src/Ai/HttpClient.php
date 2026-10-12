<?php

declare(strict_types=1);

namespace ChrisManager\Ai;

use ChrisManager\HttpException;

/** Small cURL wrapper for provider HTTP APIs (OpenAI, DeepSeek, and Anthropic's Admin API). */
final class HttpClient
{
    public static function postJson(string $url, string $apiKey, array $body, int $timeout = 120): array
    {
        return self::send($url, $apiKey, json_encode($body, JSON_UNESCAPED_UNICODE), ['Content-Type: application/json'], $timeout);
    }

    /** $fields may contain \CURLFile values. */
    public static function postMultipart(string $url, string $apiKey, array $fields, int $timeout = 300): array
    {
        return self::send($url, $apiKey, $fields, [], $timeout);
    }

    /**
     * Multipart with repeatable field names (e.g. "known_speaker_names[]"), which an array of fields can't express.
     * $parts: list of [name, value] or [name, content, filename, mime] for a file.
     */
    public static function postMultipartParts(string $url, string $apiKey, array $parts, int $timeout = 300): array
    {
        $boundary = 'cm' . bin2hex(random_bytes(12));
        $body = '';
        foreach ($parts as $p) {
            $body .= "--{$boundary}\r\nContent-Disposition: form-data; name=\"{$p[0]}\"";
            $body .= isset($p[2]) ? "; filename=\"{$p[2]}\"\r\nContent-Type: {$p[3]}\r\n\r\n" : "\r\n\r\n";
            $body .= $p[1] . "\r\n";
        }
        $body .= "--{$boundary}--\r\n";
        return self::send($url, $apiKey, $body, ["Content-Type: multipart/form-data; boundary={$boundary}"], $timeout);
    }

    /** GET with explicit headers (e.g. Anthropic's "x-api-key"); $query values may be lists, sent as repeated keys. */
    public static function getJson(string $url, array $headers, string $query = '', int $timeout = 60): array
    {
        return self::request($url . ($query !== '' ? "?{$query}" : ''), null, $headers, $timeout);
    }

    private static function send(string $url, string $apiKey, string|array $payload, array $headers, int $timeout): array
    {
        return self::request($url, $payload, array_merge(["Authorization: Bearer {$apiKey}"], $headers), $timeout);
    }

    private static function request(string $url, string|array|null $payload, array $headers, int $timeout): array
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 15,
            CURLOPT_TIMEOUT        => $timeout,
        ]);
        if ($payload !== null) {
            curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $payload]);
        }
        $raw    = curl_exec($ch);
        $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error  = curl_error($ch);
        curl_close($ch);

        // The app shows these messages, so they don't name the provider; the full detail goes to the error log.
        if ($raw === false) {
            error_log("Upstream request to {$url} failed: {$error}");
            throw new HttpException(502, 'Can\'t reach the AI service; check the server\'s internet connection');
        }
        $data = json_decode($raw, true);
        if ($status >= 400 || !is_array($data)) {
            $message = is_array($data) ? ($data['error']['message'] ?? $raw) : $raw;
            error_log("Upstream error from {$url} ({$status}): " . mb_substr((string) $message, 0, 1000));
            throw new HttpException(502, match (true) {
                $status === 401, $status === 403 => 'The AI service rejected the server\'s API key; check the keys in server/.env',
                $status === 402 => 'The AI service account is out of credit',
                $status === 429 => 'The AI service is busy (rate limit); try again shortly',
                default => "The AI service returned an error ({$status}); try again",
            });
        }
        return $data;
    }
}
