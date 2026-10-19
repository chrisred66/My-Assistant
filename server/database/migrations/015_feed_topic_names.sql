-- Each feed topic's name in English and in Simplified Chinese, so the Daily Feed shows topics in the reader's language.
-- Filled by the light AI model when a topic is added (and for older topics the first time they're listed).
ALTER TABLE feed_topics
    ADD COLUMN topic_en VARCHAR(160) NULL AFTER topic,
    ADD COLUMN topic_zh VARCHAR(160) NULL AFTER topic_en;
