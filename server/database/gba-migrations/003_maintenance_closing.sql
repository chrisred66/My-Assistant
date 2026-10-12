-- Work orders are now created first and closed later (when the workshop reports back): a note added on closing.
ALTER TABLE maintenance_db ADD COLUMN closing_note TEXT DEFAULT NULL AFTER description;
