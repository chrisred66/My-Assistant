-- 004_user_roles: more than one person can sign in.
--   role:      owner  = everything (AI tools, recordings, usage, user management)
--              member = only what pt_access allows (PT Management)
--   pt_access: none < view < edit < admin, for the PT Management tab
-- GBA users sign in with a username and may have no email.

ALTER TABLE users
    MODIFY email VARCHAR(190) NULL,
    ADD COLUMN username     VARCHAR(100) NULL AFTER email,
    ADD COLUMN display_name VARCHAR(100) NOT NULL DEFAULT '' AFTER username,
    ADD COLUMN role         ENUM('owner','member') NOT NULL DEFAULT 'member' AFTER display_name,
    ADD COLUMN pt_access    ENUM('none','view','edit','admin') NOT NULL DEFAULT 'none' AFTER role,
    ADD COLUMN disabled_at  DATETIME NULL AFTER password_hash,
    ADD UNIQUE KEY uq_users_username (username);

-- The account that already exists is the owner.
UPDATE users SET role = 'owner', pt_access = 'admin' ORDER BY id LIMIT 1;
