<?php

declare(strict_types=1);

namespace ChrisManager;

/** Token-usage logging and reporting. */
final class Usage
{
    public static function log(array $row): void
    {
        Db::insert('token_usage', $row + ['occurred_at' => date('Y-m-d H:i:s')]);
    }

    /**
     * Totals grouped by day, month or model, with cost from the latest model_prices row
     * effective on each usage date. Cost is NULL where no price is configured.
     */
    public static function summary(int $userId, string $from, string $to, string $groupBy): array
    {
        $groupExpr = match ($groupBy) {
            'day'   => 'DATE(u.occurred_at)',
            'month' => "DATE_FORMAT(u.occurred_at, '%Y-%m')",
            'model' => "CONCAT(u.provider, '/', u.model)",
            default => throw new HttpException(422, 'group must be day, month or model'),
        };

        $sql = "
            SELECT {$groupExpr} AS bucket,
                   u.provider,
                   COUNT(*)                 AS requests,
                   SUM(u.input_tokens)      AS input_tokens,
                   SUM(u.output_tokens)     AS output_tokens,
                   SUM(u.cache_read_tokens) AS cache_read_tokens,
                   SUM(u.audio_seconds)     AS audio_seconds,
                   SUM(
                       (u.input_tokens * p.input_per_mtok
                        + u.output_tokens * p.output_per_mtok
                        + u.cache_read_tokens * COALESCE(p.cache_read_per_mtok, p.input_per_mtok)
                        + u.cache_write_tokens * COALESCE(p.cache_write_per_mtok, p.input_per_mtok)) / 1000000
                       + COALESCE(u.audio_seconds / 60 * p.per_audio_minute, 0)
                   ) AS cost_usd
              FROM token_usage u
              LEFT JOIN model_prices p
                     ON p.provider = u.provider AND p.model = u.model
                    AND p.effective_from = (
                        SELECT MAX(p2.effective_from) FROM model_prices p2
                         WHERE p2.provider = u.provider AND p2.model = u.model
                           AND p2.effective_from <= DATE(u.occurred_at))
             WHERE (u.user_id = :uid OR u.user_id IS NULL)
               AND u.occurred_at >= :from AND u.occurred_at < DATE_ADD(:to, INTERVAL 1 DAY)
             GROUP BY bucket, u.provider
             ORDER BY bucket, u.provider";

        return Db::all($sql, ['uid' => $userId, 'from' => $from, 'to' => $to]);
    }
}
