-- 006_active_role: people with more than one role (e.g. a Paid User who is also a PT Manager, or the Super Admin, who
-- has every role) act in one at a time. The choice is kept per sign-in (token), so each device remembers its own.
-- Values: super_admin | admin | general:free | general:paid | pt:big_man | pt:manager:<module> | pt:staff:<module>.
-- NULL until chosen (accounts with a single role get it set at sign-in).
ALTER TABLE api_tokens ADD COLUMN active_role VARCHAR(50) NULL AFTER device_name;
