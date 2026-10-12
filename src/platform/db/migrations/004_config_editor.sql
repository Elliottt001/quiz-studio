ALTER TABLE games ADD COLUMN current_version integer NOT NULL DEFAULT 1;
ALTER TABLE games ADD COLUMN published_version integer;
UPDATE games SET published_version=1 WHERE status='published';

ALTER TABLE players ADD COLUMN profile_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE questions DROP CONSTRAINT questions_kind_check;
ALTER TABLE questions DROP CONSTRAINT questions_options_json_check;
ALTER TABLE questions ALTER COLUMN options_json DROP NOT NULL;
ALTER TABLE questions ALTER COLUMN correct_option DROP NOT NULL;
ALTER TABLE questions ADD COLUMN answer_rule_json jsonb;
UPDATE questions SET answer_rule_json=jsonb_build_object('correctOption',correct_option);
ALTER TABLE questions ALTER COLUMN answer_rule_json SET NOT NULL;
ALTER TABLE questions ADD CONSTRAINT questions_kind_check
  CHECK (kind IN ('choice','multiple','exact','length'));

CREATE TABLE drafts (
  game_id uuid NOT NULL,
  player_id uuid NOT NULL,
  round_id uuid NOT NULL,
  answers_json jsonb NOT NULL CHECK (jsonb_typeof(answers_json)='object'),
  saved_at bigint NOT NULL,
  PRIMARY KEY(game_id,player_id,round_id),
  FOREIGN KEY(game_id,player_id) REFERENCES players(game_id,id),
  FOREIGN KEY(game_id,round_id) REFERENCES rounds(game_id,id)
);

CREATE TABLE recovery_codes (
  code_hash text PRIMARY KEY,
  game_id uuid NOT NULL,
  player_id uuid NOT NULL,
  expires_at bigint NOT NULL,
  used_at bigint,
  FOREIGN KEY(game_id,player_id) REFERENCES players(game_id,id)
);
CREATE INDEX recovery_codes_game_player ON recovery_codes(game_id,player_id);

CREATE TABLE voided_questions (
  game_id uuid NOT NULL,
  question_id uuid NOT NULL,
  reason text NOT NULL,
  actor_id uuid NOT NULL REFERENCES organizers(id),
  created_at bigint NOT NULL,
  PRIMARY KEY(game_id,question_id),
  FOREIGN KEY(game_id,question_id) REFERENCES questions(game_id,id)
);
