-- Human clarification no longer blocks transcription. Requeue any job that was waiting so
-- Gemini Pro can run the correction pass again and continue directly to the summary.
UPDATE jobs
SET status = 'processing',
    stage = 1,
    stage_pct = 0,
    eta_sec = NULL,
    error = NULL,
    summary_status = 'waiting',
    summary = NULL,
    summary_text = NULL,
    summary_meta = NULL,
    summary_error = NULL,
    summary_revision = NULL,
    clarifications = NULL,
    clarification_answers = NULL,
    clarification_unresolved = '[]'::jsonb,
    clarification_completed_at = NULL,
    locked_by = NULL,
    locked_at = NULL,
    attempts = 0,
    finished_at = NULL,
    updated_at = now()
WHERE status = 'awaiting_clarification';

ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
    CHECK (status IN ('uploading', 'processing', 'done', 'failed'));
