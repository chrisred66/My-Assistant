<?php

declare(strict_types=1);

namespace ChrisManager;

use ChrisManager\Ai\HttpClient;

/**
 * Pulls usage and billed cost from the providers' own reporting APIs into token_usage (source 'sync').
 *
 *   Anthropic: Usage & Cost Admin API (needs ANTHROPIC_ADMIN_KEY, an sk-ant-admin... key)
 *   OpenAI:    Usage + Costs API (needs OPENAI_ADMIN_KEY, an organization admin key)
 *   DeepSeek:  no usage-history API, only the account balance
 *
 * Rows are one per provider, UTC day and model. Re-syncing a range replaces that range.
 */
final class ProviderUsage
{
    private const MAX_PAGES = 50; // safety stop for pagination

    // Base URLs; the *_ADMIN_BASE_URL overrides exist for testing against a mock server.
    private static function anthropicUrl(string $path): string
    {
        return rtrim(Env::get('ANTHROPIC_ADMIN_BASE_URL', 'https://api.anthropic.com'), '/') . '/v1/organizations' . $path;
    }

    private static function openAiUrl(string $path): string
    {
        return rtrim(Env::get('OPENAI_ADMIN_BASE_URL', 'https://api.openai.com'), '/') . '/v1/organization' . $path;
    }

    /** @return array<string, array{ok: bool, rows?: int, error?: string, skipped?: string}> */
    public static function syncAll(string $from, string $to): array
    {
        $out = [];
        foreach (['anthropic' => 'ANTHROPIC_ADMIN_KEY', 'openai' => 'OPENAI_ADMIN_KEY'] as $provider => $keyVar) {
            if (Env::get($keyVar) === null) {
                $out[$provider] = ['ok' => false, 'skipped' => "Set {$keyVar} in server/.env to sync"];
                continue;
            }
            try {
                $rows = $provider === 'anthropic' ? self::fetchAnthropic($from, $to) : self::fetchOpenAi($from, $to);
                $out[$provider] = ['ok' => true, 'rows' => self::store($provider, $from, $to, $rows)];
            } catch (\Throwable $e) {
                $message = $e->getMessage();
                if (str_contains($message, '(403)') || str_contains($message, '(401)')) {
                    $message .= $provider === 'anthropic'
                        ? ' This needs an Admin API key (sk-ant-admin...) from Console → Settings → Admin keys; personal (sk-ant-usr...) and workspace keys can\'t read usage reports.'
                        : ' This needs an organization Admin key with usage read access.';
                }
                $message = mb_substr($message, 0, 500);
                Db::run(
                    'INSERT INTO usage_sync (provider, last_error, attempted_at) VALUES (?, ?, NOW())
                     ON DUPLICATE KEY UPDATE last_error = VALUES(last_error), attempted_at = VALUES(attempted_at)',
                    [$provider, $message],
                );
                $out[$provider] = ['ok' => false, 'error' => $message];
            }
        }
        return $out;
    }

    /** Sync status per provider, plus DeepSeek's balance. */
    public static function status(): array
    {
        $rows = [];
        foreach (Db::all('SELECT * FROM usage_sync') as $r) {
            $rows[$r['provider']] = $r;
        }
        $status = [];
        foreach (['anthropic' => 'ANTHROPIC_ADMIN_KEY', 'openai' => 'OPENAI_ADMIN_KEY'] as $provider => $keyVar) {
            $r = $rows[$provider] ?? [];
            $status[$provider] = [
                'can_sync'      => Env::get($keyVar) !== null,
                'key_setting'   => $keyVar,
                'synced_at'     => $r['synced_at'] ?? null,
                'range_from'    => $r['range_from'] ?? null,
                'range_to'      => $r['range_to'] ?? null,
                'rows_imported' => (int) ($r['rows_imported'] ?? 0),
                'last_error'    => $r['last_error'] ?? null,
            ];
        }
        $status['deepseek'] = ['can_sync' => false, 'note' => 'DeepSeek has no usage-history API; usage shown is from this app.']
            + self::deepSeekBalance();
        return $status;
    }

    /** @return array{balance?: list<array{currency: string, total: string, granted: string, topped_up: string}>, available?: bool, balance_error?: string} */
    public static function deepSeekBalance(): array
    {
        $key = Env::get('DEEPSEEK_API_KEY');
        if ($key === null) {
            return ['balance_error' => 'Set DEEPSEEK_API_KEY in server/.env'];
        }
        try {
            $data = HttpClient::getJson('https://api.deepseek.com/user/balance', ["Authorization: Bearer {$key}", 'Accept: application/json'], '', 15);
        } catch (HttpException $e) {
            return ['balance_error' => $e->getMessage()];
        }
        return [
            'available' => (bool) ($data['is_available'] ?? false),
            'balance'   => array_map(fn ($b) => [
                'currency'  => (string) ($b['currency'] ?? ''),
                'total'     => (string) ($b['total_balance'] ?? '0'),
                'granted'   => (string) ($b['granted_balance'] ?? '0'),
                'topped_up' => (string) ($b['topped_up_balance'] ?? '0'),
            ], $data['balance_infos'] ?? []),
        ];
    }

    // ---- Anthropic ----------------------------------------------------------------

    /** @return array<string, array> rows keyed "day|model" */
    private static function fetchAnthropic(string $from, string $to): array
    {
        $headers = ['x-api-key: ' . Env::require('ANTHROPIC_ADMIN_KEY'), 'anthropic-version: 2023-06-01', 'Accept: application/json',
                    'User-Agent: chrisManager/0.2 (personal usage sync)'];
        $range   = ['starting_at' => "{$from}T00:00:00Z", 'ending_at' => self::dayAfter($to) . 'T00:00:00Z', 'bucket_width' => '1d', 'limit' => '31'];
        $rows    = [];

        // Tokens per day and model.
        foreach (self::pages(fn ($page) => HttpClient::getJson(self::anthropicUrl('/usage_report/messages'), $headers,
            self::query($range + ['group_by[]' => ['model']] + ($page ? ['page' => $page] : [])))) as $bucket) {
            $day = substr((string) $bucket['starting_at'], 0, 10);
            foreach ($bucket['results'] ?? [] as $r) {
                $row = &self::row($rows, $day, (string) ($r['model'] ?? 'unknown'));
                $row['input_tokens']       += (int) ($r['uncached_input_tokens'] ?? 0);
                $row['cache_read_tokens']  += (int) ($r['cache_read_input_tokens'] ?? 0);
                $row['cache_write_tokens'] += (int) ($r['cache_creation']['ephemeral_5m_input_tokens'] ?? 0)
                                            + (int) ($r['cache_creation']['ephemeral_1h_input_tokens'] ?? 0);
                $row['output_tokens']      += (int) ($r['output_tokens'] ?? 0);
                unset($row);
            }
        }

        // Billed cost per day and model. Amounts are decimal strings in cents.
        foreach (self::pages(fn ($page) => HttpClient::getJson(self::anthropicUrl('/cost_report'), $headers,
            self::query(['starting_at' => $range['starting_at'], 'ending_at' => $range['ending_at'], 'limit' => '31', 'group_by[]' => ['description']]
                + ($page ? ['page' => $page] : [])))) as $bucket) {
            $day = substr((string) $bucket['starting_at'], 0, 10);
            foreach ($bucket['results'] ?? [] as $r) {
                // Non-token costs (web search, code execution) have no model; keep them as their own line.
                $model = $r['model'] ?? ($r['description'] ?? 'other');
                $row   = &self::row($rows, $day, (string) $model);
                $row['cost_usd'] = ($row['cost_usd'] ?? 0) + (float) ($r['amount'] ?? 0) / 100;
                unset($row);
            }
        }
        foreach ($rows as &$row) {
            $row['request_count'] = 0; // the Anthropic usage report doesn't count requests
        }
        unset($row);
        return $rows;
    }

    // ---- OpenAI -------------------------------------------------------------------

    private static function fetchOpenAi(string $from, string $to): array
    {
        $headers = ['Authorization: Bearer ' . Env::require('OPENAI_ADMIN_KEY'), 'Accept: application/json'];
        $range   = ['start_time' => (string) strtotime("{$from} 00:00:00 UTC"), 'end_time' => (string) strtotime(self::dayAfter($to) . ' 00:00:00 UTC'),
                    'bucket_width' => '1d', 'limit' => '31'];
        $rows    = [];
        $get     = fn (string $path, array $extra) => self::pages(fn ($page) => HttpClient::getJson(self::openAiUrl($path), $headers,
            self::query($range + $extra + ($page ? ['page' => $page] : []))));

        // Chat/completions tokens. input_tokens includes cached input; split it out.
        foreach ($get('/usage/completions', ['group_by' => ['model']]) as $bucket) {
            $day = gmdate('Y-m-d', (int) $bucket['start_time']);
            foreach ($bucket['results'] ?? [] as $r) {
                $cached = (int) ($r['input_cached_tokens'] ?? 0);
                $row    = &self::row($rows, $day, (string) ($r['model'] ?? 'unknown'));
                $row['input_tokens']      += max(0, (int) ($r['input_tokens'] ?? 0) - $cached);
                $row['cache_read_tokens'] += $cached;
                $row['output_tokens']     += (int) ($r['output_tokens'] ?? 0);
                $row['request_count']     += (int) ($r['num_model_requests'] ?? 0);
                unset($row);
            }
        }

        // Speech-to-text, measured in seconds.
        foreach ($get('/usage/audio_transcriptions', ['group_by' => ['model']]) as $bucket) {
            $day = gmdate('Y-m-d', (int) $bucket['start_time']);
            foreach ($bucket['results'] ?? [] as $r) {
                $row = &self::row($rows, $day, (string) ($r['model'] ?? 'unknown'));
                $row['audio_seconds'] = ($row['audio_seconds'] ?? 0) + (float) ($r['seconds'] ?? 0);
                $row['request_count'] += (int) ($r['num_model_requests'] ?? 0);
                unset($row);
            }
        }

        // Billed cost by line item ("gpt-…, input", "whisper-1", ...): attribute to the model before the comma.
        foreach ($get('/costs', ['group_by' => ['line_item']]) as $bucket) {
            $day = gmdate('Y-m-d', (int) $bucket['start_time']);
            foreach ($bucket['results'] ?? [] as $r) {
                $item  = trim((string) ($r['line_item'] ?? 'other'));
                $model = trim(explode(',', $item)[0]) ?: 'other';
                $row   = &self::row($rows, $day, $model);
                $row['cost_usd'] = ($row['cost_usd'] ?? 0) + (float) ($r['amount']['value'] ?? 0);
                unset($row);
            }
        }
        return $rows;
    }

    // ---- Shared --------------------------------------------------------------------

    /** Replaces the provider's synced rows for the range; returns the number of rows written. */
    private static function store(string $provider, string $from, string $to, array $rows): int
    {
        $pdo = Db::pdo();
        $pdo->beginTransaction();
        try {
            Db::run(
                "DELETE FROM token_usage WHERE source = 'sync' AND provider = ? AND occurred_at >= ? AND occurred_at < ?",
                [$provider, "{$from} 00:00:00", self::dayAfter($to) . ' 00:00:00'],
            );
            foreach ($rows as $row) {
                Db::insert('token_usage', [
                    'user_id'            => null,
                    'provider'           => $provider,
                    'model'              => mb_substr($row['model'], 0, 100),
                    'feature'            => 'sync',
                    'input_tokens'       => $row['input_tokens'],
                    'output_tokens'      => $row['output_tokens'],
                    'cache_read_tokens'  => $row['cache_read_tokens'],
                    'cache_write_tokens' => $row['cache_write_tokens'],
                    'audio_seconds'      => $row['audio_seconds'] ?? null,
                    'cost_usd'           => isset($row['cost_usd']) ? round($row['cost_usd'], 6) : null,
                    'request_count'      => $row['request_count'],
                    'source'             => 'sync',
                    'occurred_at'        => "{$row['day']} 00:00:00", // the provider's UTC day
                ]);
            }
            Db::run(
                'INSERT INTO usage_sync (provider, synced_at, range_from, range_to, rows_imported, last_error, attempted_at)
                      VALUES (?, NOW(), ?, ?, ?, NULL, NOW())
                 ON DUPLICATE KEY UPDATE synced_at = NOW(), attempted_at = NOW(), last_error = NULL,
                        rows_imported = VALUES(rows_imported),
                        range_from = LEAST(COALESCE(range_from, VALUES(range_from)), VALUES(range_from)),
                        range_to   = GREATEST(COALESCE(range_to, VALUES(range_to)), VALUES(range_to))',
                [$provider, $from, $to, count($rows)],
            );
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
        return count($rows);
    }

    /** Follows next_page cursors; yields every bucket. */
    private static function pages(callable $fetch): \Generator
    {
        $page = null;
        for ($i = 0; $i < self::MAX_PAGES; $i++) {
            $data = $fetch($page);
            yield from $data['data'] ?? [];
            $page = $data['next_page'] ?? null;
            if ($page === null || (isset($data['has_more']) && !$data['has_more'])) {
                return;
            }
        }
    }

    private static function &row(array &$rows, string $day, string $model): array
    {
        $key = "{$day}|{$model}";
        $rows[$key] ??= ['day' => $day, 'model' => $model, 'input_tokens' => 0, 'output_tokens' => 0,
                         'cache_read_tokens' => 0, 'cache_write_tokens' => 0, 'request_count' => 0];
        return $rows[$key];
    }

    /** Query string; list values become repeated keys ("group_by[]=model", "group_by=model"). */
    private static function query(array $params): string
    {
        $parts = [];
        foreach ($params as $key => $value) {
            foreach ((array) $value as $v) {
                $parts[] = str_replace('%5B%5D', '[]', rawurlencode((string) $key)) . '=' . rawurlencode((string) $v);
            }
        }
        return implode('&', $parts);
    }

    private static function dayAfter(string $day): string
    {
        return date('Y-m-d', strtotime("{$day} +1 day"));
    }
}
