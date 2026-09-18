const createSchema = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS login_throttle_states (
      state_key TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL,
      lock_until INTEGER NOT NULL DEFAULT 0,
      fail_streak INTEGER NOT NULL DEFAULT 0,
      last_seen_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_login_throttle_states_last_seen
      ON login_throttle_states(last_seen_at);

    CREATE TABLE IF NOT EXISTS advanced_control_acknowledgements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_identity TEXT NOT NULL,
      session_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      warning_version TEXT NOT NULL,
      managed_config_revision TEXT NOT NULL,
      client_ip TEXT,
      acknowledged_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_advanced_control_acknowledgements_ts
      ON advanced_control_acknowledgements(acknowledged_at DESC);
  `);
};

module.exports = { createSchema };
