-- Fix: sign-up failed with 500 "Database error saving new user".
--
-- The cause is in 0001. `handle_new_user` is a SECURITY DEFINER trigger that
-- fires on auth.users, and it did not pin its search_path. When a trigger runs
-- from the auth schema, an unqualified `profiles` does not resolve to
-- public.profiles, the insert raises, and GoTrue rolls the whole sign-up back
-- and reports the 500.
--
-- Pinning search_path is also the correct hardening for any SECURITY DEFINER
-- function: without it, a caller who can create objects on the search path can
-- influence what the elevated function resolves. All four functions from 0001
-- are re-created here with an explicit path and schema-qualified names.
--
-- Safe to run on a database that already has 0001 applied.

create or replace function public.handle_new_user() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  return new;
exception when others then
  -- Never let profile creation block sign-up. A missing profile is
  -- recoverable and defaults to the lowest privilege; a failed sign-up is a
  -- dead end for the user.
  raise warning 'handle_new_user failed for %: %', new.id, sqlerrm;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.audit_cameras() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.audit_log (actor, action, entity, entity_id, before, after)
  values (
    auth.uid(),
    lower(tg_op),
    'cameras',
    coalesce(new.id, old.id),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return coalesce(new, old);
end $$;

create or replace function public.my_role() returns text
language sql stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select role from public.profiles where id = auth.uid()), 'viewer')
$$;

create or replace function public.my_zone() returns text
language sql stable
security definer
set search_path = public, pg_temp
as $$
  select (select zone_id from public.profiles where id = auth.uid())
$$;

-- Backfill: anyone who signed up while the trigger was broken has no profile,
-- so they would be stuck as a viewer with no row at all.
insert into public.profiles (id, email, full_name)
select u.id, u.email, u.raw_user_meta_data->>'full_name'
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null;

-- Re-seed departments idempotently, in case 0001 stopped before this point.
insert into public.departments (id, name, domain) values
  ('police',    'Home Department (Police)',                'public'),
  ('traffic',   'Traffic Police',                          'traffic'),
  ('health',    'Health & Family Welfare',                 'hospital'),
  ('pds',       'Food, Civil Supplies & Consumer Affairs',  'pds'),
  ('rto',       'Ports & Transport (RTO)',                 'rto'),
  ('municipal', 'Municipal / Panchayat',                   'public')
on conflict (id) do nothing;
