-- 0005 — Public waitlist queue, admin-approved invites.

create table if not exists waitlist_entries (
  id            bigserial primary key,
  email         text not null unique,
  questionnaire jsonb not null default '{}'::jsonb,
  status        text not null check (status in ('pending', 'approved', 'rejected'))
                  default 'pending',
  approved_by   uuid references auth.users(id),
  approved_at   timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists idx_waitlist_status on waitlist_entries (status);

alter table waitlist_entries enable row level security;

-- Anyone (anon role) can submit a waitlist entry.
create policy "waitlist_anon_insert" on waitlist_entries
  for insert with check (true);

-- Only admins can read or update.
create policy "waitlist_admin_select" on waitlist_entries
  for select using (
    exists(select 1 from profiles p where p.user_id = auth.uid() and p.is_admin)
  );
create policy "waitlist_admin_update" on waitlist_entries
  for update using (
    exists(select 1 from profiles p where p.user_id = auth.uid() and p.is_admin)
  );
