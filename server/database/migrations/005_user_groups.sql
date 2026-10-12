-- 005_user_groups: user groups replace owner/member + pt_access.
--   role:         super_admin = everything (the existing owner)
--                 admin       = everything except Usage/AI costs; manages users below Admin
--                 user        = what general_plan and pt_role give
--   general_plan: General Tool (Recordings, Translate, Transcripts): none | free (10 translations a day) | paid
--   pt_role:      PT Management: none | big_man (all modules) | manager (own module, full) | staff ("low man": own
--                 module, view and add only)
--   pt_module:    for manager/staff: operations | maintenance | planning (Fleet, Trials, Charging)

ALTER TABLE users
    MODIFY role ENUM('owner','member','super_admin','admin','user') NOT NULL DEFAULT 'member',
    ADD COLUMN general_plan ENUM('none','free','paid') NOT NULL DEFAULT 'none' AFTER role,
    ADD COLUMN pt_role ENUM('none','big_man','manager','staff') NOT NULL DEFAULT 'none' AFTER general_plan,
    ADD COLUMN pt_module ENUM('operations','maintenance','planning') NULL AFTER pt_role;

-- Old PT levels: admin/edit had all of PT (edit without deleting); view could only look. Without a module to put
-- them in, members with any PT access become Big Man; review them in Settings → Users.
UPDATE users SET pt_role = 'big_man' WHERE role = 'member' AND pt_access IN ('admin', 'edit', 'view');
UPDATE users SET role = 'super_admin', general_plan = 'paid', pt_role = 'big_man' WHERE role = 'owner';
UPDATE users SET role = 'user' WHERE role = 'member';

ALTER TABLE users
    MODIFY role ENUM('super_admin','admin','user') NOT NULL DEFAULT 'user',
    DROP COLUMN pt_access;

-- Free plan: each translated item (a Translate-page request, or a recording, however many chunks it has) once.
CREATE TABLE translation_quota (
    user_id    INT UNSIGNED NOT NULL,
    ref        VARCHAR(100) NOT NULL,   -- "translate:{transcript id}" or "recording:{recording id}"
    day        DATE NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, ref),
    KEY idx_quota_day (user_id, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
