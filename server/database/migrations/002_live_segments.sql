-- 002_live_segments: live (chunked) transcription.
-- Each chunk of a live recording is transcribed separately and stored as a numbered segment;
-- the parent transcript's source_text / translated_text are rebuilt from its segments in order.

CREATE TABLE transcript_segments (
    id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    transcript_id INT UNSIGNED NOT NULL,
    seq           INT UNSIGNED NOT NULL,             -- order within the recording, from 0
    start_ms      INT UNSIGNED NULL,                 -- offset of the chunk from the start of recording
    language      VARCHAR(20) NULL,                  -- detected language of this chunk
    source_text   MEDIUMTEXT NOT NULL,
    english_text  MEDIUMTEXT NULL,                   -- NULL when the chunk was already English
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_transcript_segments_seq (transcript_id, seq),
    CONSTRAINT fk_transcript_segments_transcript FOREIGN KEY (transcript_id) REFERENCES transcripts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Languages are now detected rather than assumed Arabic; leave room for names like "arabic".
ALTER TABLE transcripts MODIFY source_lang VARCHAR(20) NOT NULL DEFAULT 'ar';
