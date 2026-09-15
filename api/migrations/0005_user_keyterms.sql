-- Per-user settings. keyterms: ElevenLabs keyterms and the glossary of the correction step.
-- A user without a row uses the defaults in api/keyterms.txt.
CREATE TABLE user_settings (
    user_id    uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    keyterms   text[] NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- The terms a job is transcribed with, copied from its owner's settings when the job is created
-- (NULL for jobs created before this migration: they use the owner's current terms).
ALTER TABLE jobs ADD COLUMN keyterms text[];
