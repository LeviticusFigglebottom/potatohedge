-- Persist the full Claude prompt for each briefing so we can audit
-- exactly what the model saw vs what it returned.
ALTER TABLE briefings ADD COLUMN IF NOT EXISTS prompt TEXT;
