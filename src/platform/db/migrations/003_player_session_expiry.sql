ALTER TABLE player_sessions ADD COLUMN expires_at bigint NOT NULL DEFAULT 0;
CREATE INDEX player_sessions_game_player ON player_sessions(game_id, player_id);
