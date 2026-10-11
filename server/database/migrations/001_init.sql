-- 001_init: users, device tokens, recordings, transcripts, token usage, prices, datasets.
-- Applied by bin/migrate.php. Never edit a migration that has already run anywhere;
-- add a new numbered file instead.

CREATE TABLE users (
    id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    email         VARCHAR(190) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per logged-in device. Only the SHA-256 of the token is stored.
CREATE TABLE api_tokens (
    id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id      INT UNSIGNED NOT NULL,
    token_hash   CHAR(64) NOT NULL UNIQUE,
    device_name  VARCHAR(100) NOT NULL DEFAULT '',
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME NULL,
    expires_at   DATETIME NOT NULL,
    CONSTRAINT fk_api_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE recordings (
    id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id       INT UNSIGNED NOT NULL,
    file_path     VARCHAR(255) NOT NULL,           -- relative to STORAGE_PATH
    original_name VARCHAR(255) NOT NULL DEFAULT '',
    mime_type     VARCHAR(100) NOT NULL DEFAULT '',
    size_bytes    INT UNSIGNED NOT NULL DEFAULT 0,
    duration_sec  DECIMAL(10,2) NULL,
    title         VARCHAR(255) NOT NULL DEFAULT '',
    recorded_at   DATETIME NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_recordings_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_recordings_user_created (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE transcripts (
    id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id             INT UNSIGNED NOT NULL,
    recording_id        INT UNSIGNED NULL,          -- NULL for pasted text
    source_lang         VARCHAR(10) NOT NULL DEFAULT 'ar',
    source_text         MEDIUMTEXT NOT NULL,
    translated_text     MEDIUMTEXT NULL,
    transcribe_model    VARCHAR(100) NULL,
    translate_provider  VARCHAR(20) NULL,
    translate_model     VARCHAR(100) NULL,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_transcripts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_transcripts_recording FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE SET NULL,
    INDEX idx_transcripts_user_created (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every AI call: logged by the relay, pulled from provider usage APIs, or entered by hand.
CREATE TABLE token_usage (
    id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id            INT UNSIGNED NULL,
    provider           ENUM('anthropic','openai','deepseek') NOT NULL,
    model              VARCHAR(100) NOT NULL,
    feature            VARCHAR(50) NOT NULL DEFAULT '',   -- translate, transcribe, chat, ...
    input_tokens       INT UNSIGNED NOT NULL DEFAULT 0,
    output_tokens      INT UNSIGNED NOT NULL DEFAULT 0,
    cache_read_tokens  INT UNSIGNED NOT NULL DEFAULT 0,
    cache_write_tokens INT UNSIGNED NOT NULL DEFAULT 0,
    audio_seconds      DECIMAL(10,2) NULL,
    request_id         VARCHAR(100) NULL,
    source             ENUM('relay','sync','manual') NOT NULL DEFAULT 'relay',
    note               VARCHAR(255) NOT NULL DEFAULT '',
    occurred_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_token_usage_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_token_usage_occurred (occurred_at),
    INDEX idx_token_usage_provider_model (provider, model, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- USD per million tokens. Add a new row with a later effective_from when prices change,
-- so historical costs stay correct.
CREATE TABLE model_prices (
    provider             ENUM('anthropic','openai','deepseek') NOT NULL,
    model                VARCHAR(100) NOT NULL,
    effective_from       DATE NOT NULL,
    input_per_mtok       DECIMAL(10,4) NOT NULL DEFAULT 0,
    output_per_mtok      DECIMAL(10,4) NOT NULL DEFAULT 0,
    cache_read_per_mtok  DECIMAL(10,4) NULL,
    cache_write_per_mtok DECIMAL(10,4) NULL,
    per_audio_minute     DECIMAL(10,4) NULL,
    PRIMARY KEY (provider, model, effective_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Anthropic first-party list prices as of 2026-09. Add OpenAI / DeepSeek rows for the
-- models you actually use (check each provider's pricing page).
INSERT INTO model_prices (provider, model, effective_from, input_per_mtok, output_per_mtok, cache_read_per_mtok) VALUES
    ('anthropic', 'claude-opus-5-5',   '2026-01-01', 4.00, 20.00, 0.20),
    ('anthropic', 'claude-sonnet-5-5', '2026-01-01', 2.00, 10.00, 0.20),
    ('anthropic', 'claude-haiku-4-5',  '2026-01-01', 1.00,  5.00, NULL);

-- Imported files / saved queries for the data-analysis module.
CREATE TABLE datasets (
    id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id      INT UNSIGNED NOT NULL,
    name         VARCHAR(190) NOT NULL,
    source_type  ENUM('csv','xlsx','mysql') NOT NULL,
    table_name   VARCHAR(64) NULL,                 -- data_* table holding imported rows
    row_count    INT UNSIGNED NOT NULL DEFAULT 0,
    columns_json LONGTEXT NULL,                    -- [{name, type}, ...]
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_datasets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
