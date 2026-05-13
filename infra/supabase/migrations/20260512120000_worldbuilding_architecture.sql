-- A1 — Postgres + pgvector schema (architecture / worldbuilding hub)
-- Compatible with Supabase (PostgreSQL + pgvector extension).

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

-- Core style records with semantic search over prose descriptions
CREATE TABLE IF NOT EXISTS architectural_style (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  label text NOT NULL,
  description text,
  era text,
  culture text,
  embedding vector(1536),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS architectural_style_embedding_idx
  ON architectural_style USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE TABLE IF NOT EXISTS style_parameters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  style_id uuid NOT NULL REFERENCES architectural_style (id) ON DELETE CASCADE,
  key text NOT NULL,
  value jsonb NOT NULL,
  UNIQUE (style_id, key)
);

CREATE TABLE IF NOT EXISTS building_typology (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  label text NOT NULL,
  gn_template_path text,
  pcg_template_path text,
  parameter_schema jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS generation_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  style_id uuid REFERENCES architectural_style (id) ON DELETE SET NULL,
  typology_id uuid REFERENCES building_typology (id) ON DELETE SET NULL,
  params jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending',
  result_asset_uri text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A2 — Pattern Language (Christopher Alexander) — queryable catalog
CREATE TABLE IF NOT EXISTS alexander_pattern (
  id smallint PRIMARY KEY,
  number smallint NOT NULL UNIQUE,
  title text NOT NULL,
  body text NOT NULL,
  embedding vector(1536),
  section text
);

CREATE INDEX IF NOT EXISTS alexander_pattern_embedding_idx
  ON alexander_pattern USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- A3 — Getty AAT bridge (subset) + mapping into style_parameters vocabulary
CREATE TABLE IF NOT EXISTS getty_aat_concept (
  subject_id text PRIMARY KEY,
  term text NOT NULL,
  parent_subject_id text,
  scope_note text,
  raw jsonb
);

CREATE TABLE IF NOT EXISTS aat_style_parameter_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id text NOT NULL REFERENCES getty_aat_concept (subject_id) ON DELETE CASCADE,
  parameter_key text NOT NULL,
  transform jsonb,
  UNIQUE (subject_id, parameter_key)
);

COMMIT;
