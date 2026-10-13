-- 010_feed_chinese: Chinese-language news for chosen Daily Feed topics. DeepSeek writes Chinese searches for the topic,
-- Chinese stories are verified the same way (two or more outlets), and the feed shows them with an English headline
-- and summary plus the original headline.
ALTER TABLE feed_topics ADD COLUMN include_zh TINYINT(1) NOT NULL DEFAULT 0 AFTER topic;

ALTER TABLE feed_items
    ADD COLUMN lang VARCHAR(8) NOT NULL DEFAULT 'en' AFTER topic,
    ADD COLUMN title_original VARCHAR(500) NULL AFTER title;   -- the headline as published, when not English
