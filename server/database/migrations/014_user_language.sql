-- Each person's app language (English or Simplified Chinese), so it follows them to every device.
ALTER TABLE users ADD COLUMN language ENUM('en', 'zh') NOT NULL DEFAULT 'en' AFTER display_name;
