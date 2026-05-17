-- 0007_rls_extras.sql
-- Enable RLS on the two remaining linguistics tables that 0006 missed:
-- language_phonology and language_lexicon_stage. Both join through languages.owner_id.

alter table language_phonology enable row level security;
create policy "phonology_owner_or_public" on language_phonology
  for select using (
    exists(select 1 from languages l
           where l.id = language_phonology.language_id
             and (l.owner_id = auth.uid() or l.is_public))
  );
create policy "phonology_owner_write" on language_phonology
  for all using (
    exists(select 1 from languages l
           where l.id = language_phonology.language_id and l.owner_id = auth.uid())
  );

alter table language_lexicon_stage enable row level security;
create policy "lexicon_stage_owner_or_public" on language_lexicon_stage
  for select using (
    exists(select 1 from languages l
           where l.id = language_lexicon_stage.language_fk
             and (l.owner_id = auth.uid() or l.is_public))
  );
create policy "lexicon_stage_owner_write" on language_lexicon_stage
  for all using (
    exists(select 1 from languages l
           where l.id = language_lexicon_stage.language_fk and l.owner_id = auth.uid())
  );
