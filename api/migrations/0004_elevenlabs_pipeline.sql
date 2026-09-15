-- ElevenLabs + Gemini correction pipeline: the audited change list and its plain-text log.
ALTER TABLE jobs ADD COLUMN corrections jsonb, ADD COLUMN changes_text text;
