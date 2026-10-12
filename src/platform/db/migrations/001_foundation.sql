CREATE TABLE organizers (
  id uuid PRIMARY KEY,
  login text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  platform_admin boolean NOT NULL DEFAULT false
);

CREATE TABLE organizer_sessions (
  token_hash text PRIMARY KEY,
  organizer_id uuid NOT NULL REFERENCES organizers(id),
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL
);

CREATE TABLE games (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  owner_id uuid NOT NULL REFERENCES organizers(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at bigint NOT NULL DEFAULT 0
);

CREATE TABLE game_members (
  game_id uuid NOT NULL REFERENCES games(id),
  organizer_id uuid NOT NULL REFERENCES organizers(id),
  role text NOT NULL CHECK (role IN ('owner', 'operator')),
  PRIMARY KEY (game_id, organizer_id)
);

CREATE TABLE game_versions (
  game_id uuid NOT NULL REFERENCES games(id),
  version integer NOT NULL CHECK (version > 0),
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, version)
);

CREATE TABLE players (
  game_id uuid NOT NULL REFERENCES games(id),
  id uuid NOT NULL,
  display_name text NOT NULL,
  login_code text NOT NULL,
  password_hash text NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (game_id, id),
  UNIQUE (game_id, login_code)
);

CREATE TABLE player_sessions (
  token_hash text PRIMARY KEY,
  game_id uuid NOT NULL,
  player_id uuid NOT NULL,
  created_at bigint NOT NULL,
  revoked_at bigint,
  FOREIGN KEY (game_id, player_id) REFERENCES players(game_id, id)
);

CREATE TABLE rounds (
  game_id uuid NOT NULL REFERENCES games(id),
  id uuid NOT NULL,
  position integer NOT NULL CHECK (position > 0),
  title text NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms BETWEEN 30000 AND 3600000),
  status text NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared', 'open', 'settling', 'published', 'voided')),
  started_at bigint,
  deadline_at bigint,
  published_at bigint,
  config_version integer NOT NULL,
  PRIMARY KEY (game_id, id),
  UNIQUE (game_id, position),
  FOREIGN KEY (game_id, config_version) REFERENCES game_versions(game_id, version)
);
CREATE UNIQUE INDEX one_open_round_per_game ON rounds(game_id) WHERE status = 'open';
CREATE INDEX rounds_due ON rounds(game_id, status, deadline_at);

CREATE TABLE questions (
  game_id uuid NOT NULL,
  id uuid NOT NULL,
  round_id uuid NOT NULL,
  position integer NOT NULL CHECK (position > 0),
  kind text NOT NULL CHECK (kind = 'choice'),
  prompt text NOT NULL,
  options_json jsonb NOT NULL
    CHECK (jsonb_typeof(options_json) = 'array' AND jsonb_array_length(options_json) BETWEEN 2 AND 6),
  correct_option integer NOT NULL CHECK (correct_option BETWEEN 0 AND 5),
  points integer NOT NULL CHECK (points >= 0),
  PRIMARY KEY (game_id, id),
  UNIQUE (game_id, round_id, position),
  FOREIGN KEY (game_id, round_id) REFERENCES rounds(game_id, id)
);

CREATE TABLE submissions (
  game_id uuid NOT NULL,
  id uuid NOT NULL,
  player_id uuid NOT NULL,
  round_id uuid NOT NULL,
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 100),
  answers_json jsonb NOT NULL CHECK (jsonb_typeof(answers_json) = 'object'),
  revision integer NOT NULL CHECK (revision > 0),
  submitted_at bigint NOT NULL,
  PRIMARY KEY (game_id, id),
  UNIQUE (game_id, player_id, round_id, request_key),
  UNIQUE (game_id, player_id, round_id, revision),
  FOREIGN KEY (game_id, player_id) REFERENCES players(game_id, id),
  FOREIGN KEY (game_id, round_id) REFERENCES rounds(game_id, id)
);
CREATE INDEX submissions_last_revision
  ON submissions(game_id, round_id, player_id, revision DESC);

CREATE TABLE round_scores (
  game_id uuid NOT NULL,
  player_id uuid NOT NULL,
  round_id uuid NOT NULL,
  points integer NOT NULL CHECK (points >= 0),
  detail_json jsonb NOT NULL,
  PRIMARY KEY (game_id, player_id, round_id),
  FOREIGN KEY (game_id, player_id) REFERENCES players(game_id, id),
  FOREIGN KEY (game_id, round_id) REFERENCES rounds(game_id, id)
);

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES games(id),
  actor_id text NOT NULL,
  kind text NOT NULL,
  target_id text NOT NULL,
  details_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at bigint NOT NULL
);
CREATE INDEX audit_events_game_id ON audit_events(game_id, id DESC);
