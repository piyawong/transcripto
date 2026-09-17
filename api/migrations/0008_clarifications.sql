-- Human verification between transcript correction and meeting-minutes generation.
ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
    CHECK (status IN ('uploading', 'processing', 'awaiting_clarification', 'done', 'failed'));

ALTER TABLE jobs
    ADD COLUMN clarifications jsonb,
    ADD COLUMN clarification_answers jsonb,
    ADD COLUMN clarification_unresolved jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN transcript_revision integer NOT NULL DEFAULT 0,
    ADD COLUMN summary_revision integer,
    ADD COLUMN clarification_completed_at timestamptz;
