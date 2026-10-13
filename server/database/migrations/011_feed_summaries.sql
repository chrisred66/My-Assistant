-- 011_feed_summaries: fuller Daily Feed stories. Each story's article is fetched and summarised (OpenAI) into a short
-- paragraph and key points, in the article's own language (Chinese reports stay Chinese, in their own section).
ALTER TABLE feed_items
    MODIFY summary TEXT NULL,
    ADD COLUMN key_points JSON NULL AFTER summary;
