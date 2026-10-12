-- Fixes to the imported ptManagement schema so trials work (all three trial tables were empty on import).

-- model_db.model_id is text ('YTU12_2024'); this was an INT, so a trial bus could never be linked to its model.
ALTER TABLE trial_fleet_db MODIFY model_id VARCHAR(50) NULL;

-- Same de-duplication key as triplog_db.
ALTER TABLE trial_triplog_db ADD UNIQUE KEY uniqueTrialTripEntry (entry_key);
