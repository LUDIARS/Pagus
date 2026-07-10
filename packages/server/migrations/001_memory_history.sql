CREATE TABLE IF NOT EXISTS action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  game_date TEXT NOT NULL,
  term INTEGER,
  actor_id TEXT NOT NULL,
  payload BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_log_kind_id ON action_log(kind, id);
CREATE INDEX IF NOT EXISTS idx_action_log_actor_id ON action_log(actor_id);

CREATE TABLE IF NOT EXISTS session_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_type TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  payload BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_log_recorded_at ON session_log(recorded_at);

CREATE TABLE IF NOT EXISTS season_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS archived_relationships (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  payload BLOB NOT NULL,
  archived_at INTEGER NOT NULL,
  PRIMARY KEY(from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_archived_relationships_to_id ON archived_relationships(to_id);

CREATE TABLE IF NOT EXISTS archived_user_faith (
  villager_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  payload BLOB NOT NULL,
  archived_at INTEGER NOT NULL,
  PRIMARY KEY(villager_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_archived_user_faith_user_id ON archived_user_faith(user_id);
