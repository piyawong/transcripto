-- Preserve ElevenLabs timing pieces so transcript highlighting follows the audio instead of estimating by text length.
ALTER TABLE segments ADD COLUMN tokens jsonb;
