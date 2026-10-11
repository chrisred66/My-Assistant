<?php

declare(strict_types=1);

namespace ChrisManager\Ai;

use ChrisManager\HttpException;

/** Small cURL wrapper for the OpenAI-compatible APIs (OpenAI, DeepSeek). */
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

    private static function send(string $url, string $apiKey, string|array $payload, array $headers, int $timeout): array
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $payload,
            CURLOPT_HTTPHEADER     => array_merge(["Authorization: Bearer {$apiKey}"], $headers),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 15,
            CURLOPT_TIMEOUT        => $timeout,
        ]);
        $raw    = curl_exec($ch);
        $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error  = curl_error($ch);
        curl_close($ch);

        if ($raw === false) {
            throw new HttpException(502, "Upstream request failed: {$error}");
        }
        $data = json_decode($raw, true);
        if ($status >= 400 || !is_array($data)) {
            $message = is_array($data) ? ($data['error']['message'] ?? $raw) : $raw;
            throw new HttpException(502, "Upstream error ({$status}): " . mb_substr((string) $message, 0, 500));
        }
        return $data;
    }
}
