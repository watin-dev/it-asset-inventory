-- Adds admin/viewer roles to an inventory that already exists.
--
-- Run this once, in the Supabase SQL editor, on a project that already has
-- the original schema. A fresh project does not need it: schema.sql now
-- contains the same definitions.
--
-- BEFORE YOU RUN IT: change the email on the "promote the first admin" line
-- near the bottom to your own. Without an admin, nobody can write to the
-- inventory. The guard at the end refuses to finish if you forget, and the
-- SQL editor rolls the whole script back, so a mistake here costs nothing
-- but a second run.

-- Who may write. One row per account, created automatically from now on.
create table if not exists public.profiles (
  id   uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'viewer' check (role in ('admin', 'viewer'))
);

-- New accounts start read-only. An account that could write the moment it
-- was created would make "add a person" and "trust a person" the same act.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- Accounts that existed before this migration get a profile too, read-only.
insert into public.profiles (id)
select id from auth.users
on conflict (id) do nothing;

-- security definer so the assets policies below can ask this question
-- without needing their own read access to profiles, which would otherwise
-- recurse through profiles' own policy.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- A viewer may read their own row, so the app can show them their role.
-- There is deliberately no insert, update or delete policy: with RLS on, a
-- missing policy is a denial, so roles can only be changed from the Supabase
-- dashboard, where the service role bypasses RLS. That is what makes
-- "admins are appointed out of band" a rule rather than a convention.
alter table public.profiles enable row level security;

-- Defense in depth. The policies already deny these, but Supabase grants
-- them to authenticated on every new public table by default.
revoke insert, update, delete on public.profiles from anon, authenticated;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (id = auth.uid() or public.is_admin());

-- Reading stays open to everyone signed in: this is one shared inventory.
-- Writing narrows to admins.
drop policy if exists assets_select on public.assets;
create policy assets_select on public.assets
  for select using (auth.uid() is not null);

drop policy if exists assets_insert on public.assets;
create policy assets_insert on public.assets
  for insert with check (public.is_admin());

drop policy if exists assets_update on public.assets;
create policy assets_update on public.assets
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists assets_delete on public.assets;
create policy assets_delete on public.assets
  for delete using (public.is_admin());

-- Promote the first admin. CHANGE THIS EMAIL.
update public.profiles
set role = 'admin'
where id = (select id from auth.users where email = 'you@example.com');

-- Fail loudly rather than leaving an inventory no one can edit.
do $$
begin
  if not exists (select 1 from public.profiles where role = 'admin') then
    raise exception
      'No admin was created. Edit the email on the promote statement above and run this script again.';
  end if;
end;
$$;
