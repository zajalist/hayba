-- 0008_forum.sql
-- Minimal community forum: topics only (no replies yet).
-- Public read, authenticated insert, author-only edit/delete.

create table if not exists forum_topics (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete cascade,
  author_email text not null,
  title text not null check (length(title) >= 3 and length(title) <= 200),
  body text not null check (length(body) >= 1 and length(body) <= 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists forum_topics_created_idx on forum_topics (created_at desc);

alter table forum_topics enable row level security;

create policy "forum_topics_read_all" on forum_topics
  for select using (true);

create policy "forum_topics_insert_own" on forum_topics
  for insert with check (author_id = auth.uid());

create policy "forum_topics_update_own" on forum_topics
  for update using (author_id = auth.uid());

create policy "forum_topics_delete_own" on forum_topics
  for delete using (author_id = auth.uid());
