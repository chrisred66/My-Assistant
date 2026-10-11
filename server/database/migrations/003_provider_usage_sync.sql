-- 003_provider_usage_sync: usage pulled from the providers' own reporting APIs.
-- Synced rows go into token_usage with source = 'sync' (one row per provider, day and model).
-- They include this app's calls, so reports use either synced rows or the app's relay rows, never both.

-- Billed cost as reported by the provider (USD). When set it wins over the model_prices estimate.
-- request_count: a relay row is one request; a synced row is a day's total (0 when the provider doesn't report it).
ALTER TABLE token_usage
    ADD COLUMN cost_usd DECIMAL(14,6) NULL AFTER audio_seconds,
    ADD COLUMN request_count INT UNSIGNED NOT NULL DEFAULT 1 AFTER cost_usd,
    ADD INDEX idx_token_usage_source (source, provider, occurred_at);

-- Last sync per provider, so the app can show freshness and errors.
CREATE TABLE usage_sync (
    provider      ENUM('anthropic','openai','deepseek') NOT NULL PRIMARY KEY,
    synced_at     DATETIME NULL,              -- last successful sync
    range_from    DATE NULL,                  -- earliest day ever synced
    range_to      DATE NULL,                  -- latest day ever synced
    rows_imported INT UNSIGNED NOT NULL DEFAULT 0,
    last_error    VARCHAR(500) NULL,          -- from the last attempt; NULL when it succeeded
    attempted_at  DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
