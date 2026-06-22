-- L3 — Lexicon storage. Mirrors `PostgresLexicon` in src/lexicon.ts.
-- Target: Supabase Postgres (free tier compatible).

CREATE TABLE IF NOT EXISTS language_lexicon (
  id          BIGSERIAL PRIMARY KEY,
  language_id TEXT NOT NULL,
  concept     TEXT NOT NULL,
  lemma       TEXT NOT NULL,
  ipa         TEXT NOT NULL,
  register    TEXT CHECK (register IN ('neutral', 'formal', 'slang', 'poetic')),
  etymology   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (language_id, concept)
);

CREATE INDEX IF NOT EXISTS idx_language_lexicon_lang ON language_lexicon (language_id);

-- Diachronic-stage snapshot (L5). Each row is one stage of a lexeme as
-- it passes through a sound-change rule stack.
CREATE TABLE IF NOT EXISTS language_lexicon_stage (
  id          BIGSERIAL PRIMARY KEY,
  language_id TEXT NOT NULL,
  concept     TEXT NOT NULL,
  stage_index INT NOT NULL,
  rule_source TEXT,
  lemma       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (language_id, concept, stage_index)
);

-- Cached phonology / phonotactic spec per language so MCP tools can re-hydrate
-- without the client passing the full JSON each call.
CREATE TABLE IF NOT EXISTS language_phonology (
  language_id      TEXT PRIMARY KEY,
  phonology_json   JSONB NOT NULL,
  phonotactic_json JSONB,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
