-- Importing work orders from Access exports.

-- Where an imported work order came from and its number there, so re-importing a later export updates it
-- (e.g. adds the closing date) instead of creating a duplicate. NULL for work orders entered in the app.
ALTER TABLE maintenance_db
  ADD COLUMN source VARCHAR(50) DEFAULT NULL AFTER created_by,
  ADD COLUMN external_ref VARCHAR(100) DEFAULT NULL AFTER source,
  ADD UNIQUE KEY uniqueMaintExternal (source, external_ref);

-- Remembered column and value mappings, per file layout (signature = the file's normalised header row).
CREATE TABLE maintenance_import_map_db (
  signature  CHAR(64) NOT NULL,
  headers    TEXT NOT NULL,
  columns    TEXT NOT NULL,   -- JSON: field → column header
  `values`   TEXT NOT NULL,   -- JSON: field → {file value → app value}
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (signature)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
