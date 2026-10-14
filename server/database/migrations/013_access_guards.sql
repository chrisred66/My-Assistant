-- Guards before other people use the app: sign-in lockout, daily translation words, an activity log, and audio
-- removed to keep within each person's storage allowance.

-- Failed sign-ins, per login name and per IP address (Auth::login). Old rows are pruned as new ones arrive.
CREATE TABLE login_attempts (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    identifier VARCHAR(190) NOT NULL,   -- the login typed (lowercased)
    ip         VARCHAR(45)  NOT NULL,
    created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_login_attempts_identifier (identifier, created_at),
    INDEX idx_login_attempts_ip (ip, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Translation words used per person per day (Allowance; Free 300, Paid 3,000). Replaces translation_quota, which
-- counted requests and is no longer used.
CREATE TABLE translation_words (
    user_id INT UNSIGNED NOT NULL,
    day     DATE NOT NULL,
    words   INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What people do (Activity): every change, every sign-in attempt, and everything the Super Admin sees while viewing
-- as someone else. Kept for a year.
CREATE TABLE activity_log (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id    INT UNSIGNED NULL,       -- who acted (the account being viewed, when viewed_by is set)
    viewed_by  INT UNSIGNED NULL,       -- the Super Admin, when viewing as user_id
    role       VARCHAR(40)  NULL,       -- the role acted in
    action     VARCHAR(60)  NOT NULL,   -- e.g. "POST /recordings", "sign-in", "sign-in failed"
    target     VARCHAR(190) NULL,       -- what it was about (a login name, an id)
    status     SMALLINT UNSIGNED NULL,  -- HTTP status of the request
    ip         VARCHAR(45)  NULL,
    device     VARCHAR(100) NULL,
    created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_activity_user (user_id, created_at),
    INDEX idx_activity_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Audio removed to stay within the 125 MB per person (the transcript is kept).
ALTER TABLE recordings ADD COLUMN audio_removed_at DATETIME NULL AFTER size_bytes;
