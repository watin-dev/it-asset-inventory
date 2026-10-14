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
  owner_id    uuid default auth.uid() references auth.users (id)
);

create index if not exists assets_updated_at_idx on public.assets (updated_at desc);

-- Keep updated_at honest on every edit.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists assets_set_updated_at on public.assets;
create trigger assets_set_updated_at
  before update on public.assets
  for each row
  execute function public.set_updated_at();

-- owner_id records who created a row. PostgREST lets the client send any
-- column value, and a column default does not stop it, so owner_id is forced
-- server-side on insert and frozen on update. Without this, any signed-in
-- user could attribute a record to a colleague.
create or replace function public.force_owner_id()
returns trigger
language plpgsql
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

-- Row Level Security: the only thing protecting this data.
--
-- These policies give every signed-in user full read and write access to the
-- whole inventory, which is the intent: it is one shared team record, not a
-- set of private ones. That makes "who can hold an account" the real access
-- boundary. Supabase allows public email sign-up by default, so you MUST turn
-- it off, or any stranger can create an account and gain full access:
--   Authentication > Sign In / Providers > Email > "Allow new users to sign up" = off
-- Create accounts from Authentication > Users instead. See README.md.
alter table public.assets enable row level security;

drop policy if exists assets_select on public.assets;
create policy assets_select on public.assets
  for select using (auth.uid() is not null);

drop policy if exists assets_insert on public.assets;
create policy assets_insert on public.assets
  for insert with check (auth.uid() is not null);

drop policy if exists assets_update on public.assets;
create policy assets_update on public.assets
  for update using (auth.uid() is not null) with check (auth.uid() is not null);

drop policy if exists assets_delete on public.assets;
create policy assets_delete on public.assets
  for delete using (auth.uid() is not null);
