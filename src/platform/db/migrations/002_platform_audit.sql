CREATE TABLE platform_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES organizers(id),
  target_id uuid NOT NULL REFERENCES organizers(id),
  kind text NOT NULL,
  details_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at bigint NOT NULL
);
