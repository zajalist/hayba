-- L9 — Parts of speech + morphosyntactic categories on the lexicon.
-- Idempotent: safe to apply to a database that already ran 0001_lexicon.sql.

ALTER TABLE language_lexicon
  ADD COLUMN IF NOT EXISTS pos   TEXT,
  ADD COLUMN IF NOT EXISTS morph JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Soft validation: the closed canonical set + an open escape hatch for
-- conlangers who invent new POS categories. We keep this as a CHECK rather
-- than an enum so callers can extend without an ALTER TYPE later.
ALTER TABLE language_lexicon
  DROP CONSTRAINT IF EXISTS language_lexicon_pos_known;
ALTER TABLE language_lexicon
  ADD CONSTRAINT language_lexicon_pos_known
  CHECK (pos IS NULL OR length(pos) BETWEEN 1 AND 32);

CREATE INDEX IF NOT EXISTS idx_language_lexicon_pos ON language_lexicon (language_id, pos);
CREATE INDEX IF NOT EXISTS idx_language_lexicon_morph_gin ON language_lexicon USING GIN (morph);
