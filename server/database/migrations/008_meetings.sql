-- 008_meetings: meeting mode (paid plan). A meeting is a recording whose live chunks are transcribed with speaker
-- labels; each chunk can hold several speaker turns, so segments are numbered (seq, part). meeting_speakers keeps each
-- speaker's label, the name given to them, and a short voice sample sent with later chunks so labels stay consistent.
ALTER TABLE recordings ADD COLUMN kind ENUM('recording', 'meeting') NOT NULL DEFAULT 'recording' AFTER user_id;

ALTER TABLE transcript_segments
    ADD COLUMN part SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER seq,
    ADD COLUMN speaker VARCHAR(20) NULL AFTER part;          -- "Speaker 1"... (see meeting_speakers)
-- The new unique key first: the old one also serves the foreign key on transcript_id.
ALTER TABLE transcript_segments ADD UNIQUE KEY uq_transcript_segments_part (transcript_id, seq, part);
ALTER TABLE transcript_segments DROP INDEX uq_transcript_segments_seq;

CREATE TABLE meeting_speakers (
    id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    recording_id  INT UNSIGNED NOT NULL,
    label         VARCHAR(20) NOT NULL,      -- "Speaker 1", "Speaker 2"...
    name          VARCHAR(100) NULL,         -- what the user calls them; NULL shows the label
    ref_path      VARCHAR(255) NULL,         -- voice sample (WAV, 2-10 s), relative to STORAGE_PATH
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_meeting_speakers (recording_id, label),
    CONSTRAINT fk_meeting_speakers_recording FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
