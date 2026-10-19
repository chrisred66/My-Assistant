-- Translations can be into any of the offered languages, not only English: the language of translated_text (and of
-- the segments' english_text, which now holds the translation in this language). NULL = English (older rows).
ALTER TABLE transcripts ADD COLUMN target_lang VARCHAR(10) NULL AFTER translated_text;
