-- Google sign-in, the monthly quota, and the language / speaker-count upload options were removed.
ALTER TABLE users DROP COLUMN google_sub, DROP COLUMN quota_minutes;
ALTER TABLE jobs DROP COLUMN lang, DROP COLUMN speaker_hint;
