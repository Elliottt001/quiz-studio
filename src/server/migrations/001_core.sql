CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  real_name TEXT NOT NULL,
  nickname TEXT NOT NULL,
  grade INTEGER NOT NULL CHECK (grade BETWEEN 2019 AND 2025),
  team TEXT NOT NULL CHECK (team IN ('software','hardware','operations','design')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 4),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared','open','settling','published','voided')),
  started_at INTEGER,
  deadline_at INTEGER,
  started_by TEXT,
  published_at INTEGER
);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('choice','reflection')),
  prompt TEXT NOT NULL,
  options_json TEXT,
  correct_option INTEGER,
  explanation TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  UNIQUE(round_id, position)
);
CREATE TABLE IF NOT EXISTS drafts (
  player_id TEXT NOT NULL REFERENCES players(id),
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  answers_json TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY(player_id, round_id)
);
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id),
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  request_key TEXT NOT NULL,
  answers_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL,
  UNIQUE(player_id, round_id, request_key),
  UNIQUE(player_id, round_id, revision)
);
CREATE TABLE IF NOT EXISTS round_scores (
  player_id TEXT NOT NULL REFERENCES players(id),
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  points INTEGER NOT NULL,
  answers_json TEXT NOT NULL,
  PRIMARY KEY(player_id, round_id)
);
CREATE TABLE IF NOT EXISTS bonus_events (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id),
  kind TEXT NOT NULL CHECK (kind IN ('speaking','work')),
  points INTEGER NOT NULL,
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  voided_at INTEGER
);
CREATE TABLE IF NOT EXISTS eligibility (
  player_id TEXT PRIMARY KEY REFERENCES players(id),
  checked_in INTEGER NOT NULL DEFAULT 0,
  eligible_override INTEGER NOT NULL DEFAULT 0,
  excluded INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS freeze_snapshots (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  entries_json TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prizes (
  id TEXT PRIMARY KEY,
  tier TEXT NOT NULL CHECK (tier IN ('third','second','grand')),
  title TEXT NOT NULL,
  position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS draws (
  id TEXT PRIMARY KEY,
  prize_id TEXT NOT NULL UNIQUE REFERENCES prizes(id),
  request_key TEXT NOT NULL UNIQUE,
  player_id TEXT NOT NULL UNIQUE REFERENCES players(id),
  freeze_id TEXT NOT NULL REFERENCES freeze_snapshots(id),
  total_balls_before INTEGER NOT NULL,
  selected_index INTEGER NOT NULL,
  selected_ball_id TEXT NOT NULL,
  drawn_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  refusal_reason TEXT
);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  occurred_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO rounds(id,title) VALUES
  (1,'回望来时路'),(2,'认识 X-Lab'),(3,'发现更多可能'),(4,'我们的共同记忆');
