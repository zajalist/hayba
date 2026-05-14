-- L13 — Cross-language wordlinks (cognate, borrowing, calque, translation).
-- Idempotent: safe to apply alongside 0001_lexicon.sql + 0002_lexicon_pos.sql.

CREATE TABLE IF NOT EXISTS language_wordlink (
  id         BIGSERIAL PRIMARY KEY,
  lang_a     TEXT NOT NULL,
  concept_a  TEXT NOT NULL,
  lang_b     TEXT NOT NULL,
  concept_b  TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('cognate', 'borrowing', 'calque', 'translation')),
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lang_a, concept_a, lang_b, concept_b),
  -- Disallow self-links.
  CHECK (NOT (lang_a = lang_b AND concept_a = concept_b))
);

CREATE INDEX IF NOT EXISTS idx_language_wordlink_a ON language_wordlink (lang_a, concept_a);
CREATE INDEX IF NOT EXISTS idx_language_wordlink_b ON language_wordlink (lang_b, concept_b);
CREATE INDEX IF NOT EXISTS idx_language_wordlink_kind ON language_wordlink (kind);
