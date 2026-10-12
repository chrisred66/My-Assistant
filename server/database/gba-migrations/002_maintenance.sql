-- Repair & maintenance (new; the original ptManagement app had none).

-- Preventive maintenance plans: a service every interval_km and/or interval_days, for all buses or one model.
CREATE TABLE maintenance_plan_db (
  plan_id       INT NOT NULL AUTO_INCREMENT,
  name          VARCHAR(255) NOT NULL,
  model_id      VARCHAR(50) DEFAULT NULL,   -- NULL: every bus
  category      VARCHAR(50) NOT NULL DEFAULT 'general',
  interval_km   INT DEFAULT NULL,
  interval_days INT DEFAULT NULL,
  notes         TEXT DEFAULT NULL,
  active        TINYINT(1) NOT NULL DEFAULT 1,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (plan_id),
  KEY idx_plan_model (model_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Work orders: one repair, inspection or service on one bus. bus_id is the fleet number (not a foreign key, so
-- records survive a bus being removed to the archive, like trip logs do).
CREATE TABLE maintenance_db (
  record_id      INT NOT NULL AUTO_INCREMENT,
  bus_id         INT NOT NULL,
  plan_id        INT DEFAULT NULL,            -- set when this work order carries out a preventive plan
  type           ENUM('preventive','corrective','breakdown','inspection','accident','warranty') NOT NULL,
  category       VARCHAR(50) NOT NULL DEFAULT 'general',
  title          VARCHAR(255) NOT NULL,
  description    TEXT DEFAULT NULL,
  priority       ENUM('low','normal','high','critical') NOT NULL DEFAULT 'normal',
  status         ENUM('open','in_progress','waiting_parts','completed','cancelled') NOT NULL DEFAULT 'open',
  reported_date  DATE NOT NULL,
  completed_date DATE DEFAULT NULL,
  odometer_km    DECIMAL(10,1) DEFAULT NULL,
  downtime_hours DECIMAL(8,1) DEFAULT NULL,   -- time the bus was out of service
  labour_hours   DECIMAL(8,1) DEFAULT NULL,
  parts_cost     DECIMAL(12,2) DEFAULT NULL,
  labour_cost    DECIMAL(12,2) DEFAULT NULL,
  workshop       VARCHAR(255) DEFAULT NULL,
  created_by     INT DEFAULT NULL,             -- chrisManager user id
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (record_id),
  KEY idx_maint_bus (bus_id, reported_date),
  KEY idx_maint_date (reported_date),
  KEY idx_maint_plan (plan_id, bus_id, completed_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
