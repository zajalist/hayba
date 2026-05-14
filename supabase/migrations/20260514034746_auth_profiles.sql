-- 0004 — Hayba per-user profile state.
-- Mirrors auth.users 1:1, holds admin flag and display name.

create table if not exists profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  is_admin     boolean not null default false,
  created_at   timestamptz not null default now()
);

alter table profiles enable row level security;

create policy "profiles_self_select" on profiles
  for select using (auth.uid() = user_id);
create policy "profiles_admin_select_all" on profiles
  for select using (
    exists(select 1 from profiles p where p.user_id = auth.uid() and p.is_admin)
  );
create policy "profiles_self_update" on profiles
  for update using (auth.uid() = user_id);

-- Auto-create profile row on user signup.
create or replace function handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (user_id, display_name)
    values (new.id, coalesce(new.raw_user_meta_data->>'display_name', new.email));
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
