-- 0006 — Top-level ownership wrapper for conlangs.
-- Adds language_id FK to existing 0001-0003 tables.

create table if not exists languages (
  id          text primary key,
  owner_id    uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  is_public   boolean not null default false,
  snapshot    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_languages_owner on languages (owner_id);
create index if not exists idx_languages_public on languages (is_public) where is_public;

-- Touch trigger for updated_at.
create or replace function touch_updated_at() returns trigger
  language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists languages_touch on languages;
create trigger languages_touch before update on languages
  for each row execute function touch_updated_at();

alter table languages enable row level security;

create policy "languages_owner_or_public_select" on languages
  for select using (owner_id = auth.uid() or is_public);
create policy "languages_owner_insert" on languages
  for insert with check (owner_id = auth.uid());
create policy "languages_owner_update" on languages
  for update using (owner_id = auth.uid());
create policy "languages_owner_delete" on languages
  for delete using (owner_id = auth.uid());

-- Add language_id FK to existing linguistics tables.
alter table language_lexicon
  add column if not exists language_fk text references languages(id) on delete cascade;
alter table language_lexicon_stage
  add column if not exists language_fk text references languages(id) on delete cascade;
alter table language_wordlink
  add column if not exists language_fk_a text references languages(id) on delete cascade,
  add column if not exists language_fk_b text references languages(id) on delete cascade;

-- RLS for the existing tables, joined through languages.owner_id.
alter table language_lexicon enable row level security;
create policy "lexicon_owner_or_public" on language_lexicon
  for select using (
    exists(select 1 from languages l
           where l.id = language_lexicon.language_fk
             and (l.owner_id = auth.uid() or l.is_public))
  );
create policy "lexicon_owner_write" on language_lexicon
  for all using (
    exists(select 1 from languages l
           where l.id = language_lexicon.language_fk and l.owner_id = auth.uid())
  );

alter table language_wordlink enable row level security;
create policy "wordlink_either_side_visible" on language_wordlink
  for select using (
    exists(select 1 from languages l
           where l.id in (language_wordlink.language_fk_a, language_wordlink.language_fk_b)
             and (l.owner_id = auth.uid() or l.is_public))
  );
create policy "wordlink_owner_write" on language_wordlink
  for all using (
    exists(select 1 from languages l
           where l.id in (language_wordlink.language_fk_a, language_wordlink.language_fk_b)
             and l.owner_id = auth.uid())
  );
