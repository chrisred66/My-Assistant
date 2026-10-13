-- 009_daily_feed: Daily Feed. Each user picks topics of interest; every morning the server builds that day's feeds of
-- the top 10 verified stories from the past 24 hours (free plan: one feed with all topics weighted equally; paid: one
-- feed per topic). A new topic starts with the next day's feed (effective_from).
CREATE TABLE feed_topics (
    id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id         INT UNSIGNED NOT NULL,
    topic           VARCHAR(120) NOT NULL,
    effective_from  DATE NOT NULL,             -- first feed date that includes it
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    removed_at      DATETIME NULL,
    CONSTRAINT fk_feed_topics_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_feed_topics_user (user_id, removed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE feeds (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id     INT UNSIGNED NOT NULL,
    feed_date   DATE NOT NULL,
    feed_key    VARCHAR(160) NOT NULL,         -- "combined" (free plan) or the topic (paid: one feed per topic)
    title       VARCHAR(255) NOT NULL,
    topics      JSON NOT NULL,                 -- the topics it covers
    status      ENUM('ready', 'failed') NOT NULL DEFAULT 'ready',
    error       VARCHAR(500) NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_feeds (user_id, feed_date, feed_key),
    CONSTRAINT fk_feeds_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE feed_items (
    id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    feed_id       INT UNSIGNED NOT NULL,
    `rank`        TINYINT UNSIGNED NOT NULL,
    topic         VARCHAR(120) NOT NULL,
    title         VARCHAR(500) NOT NULL,
    summary       VARCHAR(1000) NULL,          -- one line, from the headlines and snippets only
    url           VARCHAR(2000) NOT NULL,
    publisher     VARCHAR(200) NOT NULL,
    published_at  DATETIME NULL,
    sources       TINYINT UNSIGNED NOT NULL,   -- distinct publishers that reported it (verified: 2 or more)
    source_list   JSON NOT NULL,               -- their names
    CONSTRAINT fk_feed_items_feed FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE CASCADE,
    INDEX idx_feed_items_feed (feed_id, `rank`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
