-- IT Asset Inventory schema. Run in the Supabase SQL editor.

create table if not exists public.assets (
  id          uuid primary key default gen_random_uuid(),
  asset_tag   text not null unique,
  name        text not null,
  category    text,
  status      text,
  assigned_to text,
  location    text,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- on delete set null: without it, deleting a departed employee's account
  -- fails with a foreign-key violation for every asset they ever created.
  owner_id    uuid default auth.uid() references auth.users (id) on delete set null
);

create index if not exists assets_updated_at_idx on public.assets (updated_at desc);

-- Keep the timestamps honest. A column default does not stop a client from
-- sending its own value through PostgREST, so both columns are set here
-- instead: created_at is fixed at insert and never moves, and updated_at is
-- stamped on every write. Otherwise any signed-in user could post
-- updated_at = '2099-01-01' and pin a row to the top of the list for good.
create or replace function public.set_timestamps()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at = now();
  else
    new.created_at = old.created_at;
  end if;
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists assets_set_updated_at on public.assets;
drop trigger if exists assets_set_timestamps on public.assets;
create trigger assets_set_timestamps
  before insert or update on public.assets
  for each row
  execute function public.set_timestamps();

-- owner_id records who created a row. PostgREST lets the client send any
-- column value, and a column default does not stop it, so owner_id is forced
-- server-side on insert and frozen on update. Without this, any signed-in
-- user could attribute a record to a colleague.
create or replace function public.force_owner_id()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.owner_id = auth.uid();
  else
    new.owner_id = old.owner_id;
  end if;
  return new;
end;
$$;

drop trigger if exists assets_force_owner_id on public.assets;
create trigger assets_force_owner_id
  before insert or update on public.assets
  for each row
  execute function public.force_owner_id();

-- Roles. One shared inventory: everyone signed in reads all of it, admins
-- write it. A new account starts read-only, so adding a person and trusting
-- a person stay separate acts.
create table if not exists public.profiles (
  id   uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'viewer' check (role in ('admin', 'viewer'))
);

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

-- security definer so the assets policies can ask this question without
-- needing read access to profiles, which would recurse through profiles'
-- own policy.
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

-- The trigger covers accounts created from now on. This covers any that
-- already exist — including yours, if you added yourself before running
-- this file.
insert into public.profiles (id)
select id from auth.users
on conflict (id) do nothing;

-- Read your own row, so the app can show you your role. No insert, update or
-- delete policy: with RLS on, a missing policy denies, so roles change only
-- from the Supabase dashboard, where the service role bypasses RLS.
alter table public.profiles enable row level security;

-- Defense in depth. The policies above already deny these, but Supabase
-- grants them to authenticated on every new public table by default, so
-- without this the table is one accidental `disable row level security`
-- away from letting anyone sign themselves up as an admin.
revoke insert, update, delete on public.profiles from anon, authenticated;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (id = auth.uid() or public.is_admin());

-- Row Level Security: the only thing protecting this data.
--
-- Holding an account gets you the whole inventory, read-only. That makes
-- "who can hold an account" the first access boundary, and Supabase allows
-- public email sign-up by default, so you MUST turn it off:
--   Authentication > Sign In / Providers > Email > "Allow new users to sign up" = off
-- Create accounts from Authentication > Users instead. See README.md.
alter table public.assets enable row level security;

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

-- A fresh project has no admin yet. After running this, promote yourself:
--   update public.profiles set role = 'admin'
--   where id = (select id from auth.users where email = 'you@example.com');
