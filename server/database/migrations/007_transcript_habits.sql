-- 007_transcript_habits: learning from the user's own transcript edits.
-- transcript_corrections: each saved edit of a transcript's original text (before/after), until it has been learned.
-- transcript_habits: the guide learned from those edits, one per user and language group (zh = Chinese, learned and
-- applied through DeepSeek; other = every other language, through OpenAI). Applied to the user's new transcripts.
CREATE TABLE transcript_corrections (
    id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id        INT UNSIGNED NOT NULL,
    transcript_id  INT UNSIGNED NOT NULL,
    lang_group     ENUM('zh', 'other') NOT NULL,
    before_text    MEDIUMTEXT NOT NULL,
    after_text     MEDIUMTEXT NOT NULL,
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    learned_at     DATETIME NULL,
    CONSTRAINT fk_corrections_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_corrections_transcript FOREIGN KEY (transcript_id) REFERENCES transcripts(id) ON DELETE CASCADE,
    INDEX idx_corrections_pending (user_id, learned_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE transcript_habits (
    user_id     INT UNSIGNED NOT NULL,
    lang_group  ENUM('zh', 'other') NOT NULL,
    rules       JSON NOT NULL,                -- array of short rules, e.g. "苹果公司 → Apple" or "Use Traditional characters"
    edits       INT UNSIGNED NOT NULL DEFAULT 0, -- edits learned from so far
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, lang_group),
    CONSTRAINT fk_habits_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
