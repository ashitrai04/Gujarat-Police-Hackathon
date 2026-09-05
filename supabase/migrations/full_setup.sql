-- Project Sentinel — registry schema (Model 1) and the tables Model 2 writes into.
--
-- Run once against a fresh Supabase project:
--   Supabase dashboard > SQL Editor > paste > Run
-- or, with the CLI:  supabase db push
--
-- PostGIS is used for real geography rather than a pair of float columns, so
-- "every camera inside this drawn area" is one indexed query instead of a
-- client-side scan of the whole estate.

create extension if not exists postgis;
create extension if not exists "uuid-ossp";

-- ─────────────────────────────────────────────────────────────────────
-- Reference tables
-- ─────────────────────────────────────────────────────────────────────

create table if not exists departments (
  id          text primary key,           -- 'police', 'health', 'pds', 'rto', 'municipal'
  name        text not null,
  domain      text not null,
  created_at  timestamptz not null default now()
);

create table if not exists zones (
  id          text primary key,
  name        text not null,
  kind        text not null default 'district'  -- district | police | municipal
    check (kind in ('district', 'police', 'municipal')),
  boundary    geometry(MultiPolygon, 4326),
  created_at  timestamptz not null default now()
);

create index if not exists zones_boundary_gix on zones using gist (boundary);

-- ─────────────────────────────────────────────────────────────────────
-- Cameras — the registry. Every map pin and every filter reads this.
-- ─────────────────────────────────────────────────────────────────────

create table if not exists cameras (
  id            text primary key,                   -- 'cam01', or a department's own id
  name          text not null,
  department_id text references departments(id) on delete set null,
  domain        text not null default 'public',
  zone_id       text references zones(id) on delete set null,
  district      text,

  cam_type      text not null default 'fixed'
    check (cam_type in ('fixed', 'ptz', 'anpr', 'overview')),
  anpr_capable  boolean not null default false,

  -- Feed endpoints. hls_url is what a browser can play; rtsp_url is what the
  -- inference worker consumes. Both are kept because they are different
  -- transports to the same camera, not alternatives.
  hls_url       text,
  rtsp_url      text,
  onvif_url     text,
  vendor        text,

  status        text not null default 'unknown'
    check (status in ('online', 'offline', 'degraded', 'maintenance', 'unknown')),
  -- Maintenance state is deliberately separate from health: a camera can be
  -- reachable but scheduled for replacement, which is what ageing-infrastructure
  -- reporting needs to see.
  commissioned_on date,
  last_serviced_on date,
  maintenance_note text,

  geom          geometry(Point, 4326),
  tags          text[] not null default '{}',
  source        text not null default 'manual'      -- manual | csv | api | grid
    check (source in ('manual', 'csv', 'api', 'grid')),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists cameras_geom_gix   on cameras using gist (geom);
create index if not exists cameras_dept_idx   on cameras (department_id);
create index if not exists cameras_status_idx on cameras (status);
create index if not exists cameras_tags_gin   on cameras using gin (tags);

-- Health is a time series, not a column: "has this camera been flapping for a
-- week?" cannot be answered by a single current-status field.
create table if not exists camera_health (
  id          bigserial primary key,
  camera_id   text not null references cameras(id) on delete cascade,
  status      text not null,
  latency_ms  integer,
  detail      text,
  checked_at  timestamptz not null default now()
);

create index if not exists camera_health_cam_time_idx
  on camera_health (camera_id, checked_at desc);

-- ─────────────────────────────────────────────────────────────────────
-- Model 2 writes here. Created now so the ANPR worker has a target and the
-- schema is one agreed contract rather than two that drift apart.
-- ─────────────────────────────────────────────────────────────────────

create table if not exists detections (
  id           uuid primary key default uuid_generate_v4(),
  camera_id    text not null references cameras(id) on delete cascade,
  plate        text,
  plate_confidence real,
  vehicle_type text,
  colour       text,
  -- How many frames voted on this plate. A single-frame read on this footage
  -- is roughly 60-75% exact; the count is what tells an operator how much to
  -- trust the string.
  frames_voted integer not null default 1,
  snapshot_url text,
  clip_url     text,
  geom         geometry(Point, 4326),
  seen_at      timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists detections_plate_idx    on detections (plate);
create index if not exists detections_camera_idx   on detections (camera_id, seen_at desc);
create index if not exists detections_seen_at_idx  on detections (seen_at desc);
create index if not exists detections_geom_gix     on detections using gist (geom);
-- Vehicle-movement search is "this plate, everywhere, in time order".
create index if not exists detections_plate_time_idx on detections (plate, seen_at);

create table if not exists watchlist (
  id          uuid primary key default uuid_generate_v4(),
  category    text not null check (category in ('stolen', 'wanted', 'missing', 'other')),
  plate       text,
  person_ref  text,
  note        text,
  active      boolean not null default true,
  created_by  uuid,
  created_at  timestamptz not null default now()
);

create index if not exists watchlist_plate_idx on watchlist (plate) where active;

create table if not exists alerts (
  id            uuid primary key default uuid_generate_v4(),
  detection_id  uuid references detections(id) on delete cascade,
  watchlist_id  uuid references watchlist(id) on delete set null,
  camera_id     text references cameras(id) on delete set null,
  status        text not null default 'open'
    check (status in ('open', 'acknowledged', 'closed')),
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists alerts_status_idx on alerts (status, created_at desc);

create table if not exists coverage_gaps (
  id         uuid primary key default uuid_generate_v4(),
  area       geometry(Polygon, 4326) not null,
  priority   text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  reason     text,
  computed_at timestamptz not null default now()
);

create index if not exists coverage_gaps_gix on coverage_gaps using gist (area);

-- ─────────────────────────────────────────────────────────────────────
-- People, roles, and the audit trail
-- ─────────────────────────────────────────────────────────────────────

-- Mirrors auth.users. Supabase owns identity; this holds what Sentinel needs
-- to make an access decision.
create table if not exists profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text,
  full_name     text,
  role          text not null default 'viewer'
    check (role in ('admin', 'supervisor', 'operator', 'viewer')),
  department_id text references departments(id) on delete set null,
  zone_id       text references zones(id) on delete set null,
  created_at    timestamptz not null default now()
);

-- Append-only. Nothing updates or deletes rows here.
create table if not exists audit_log (
  id         bigserial primary key,
  actor      uuid,
  actor_email text,
  action     text not null,          -- create | update | delete | import | export | search
  entity     text not null,          -- cameras | watchlist | ...
  entity_id  text,
  before     jsonb,
  after      jsonb,
  detail     text,
  at         timestamptz not null default now()
);

create index if not exists audit_log_entity_idx on audit_log (entity, entity_id, at desc);
create index if not exists audit_log_at_idx     on audit_log (at desc);

-- ─────────────────────────────────────────────────────────────────────
-- Triggers
-- ─────────────────────────────────────────────────────────────────────

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists cameras_touch on cameras;
create trigger cameras_touch before update on cameras
  for each row execute function touch_updated_at();

-- Every camera write lands in the audit trail without the application having
-- to remember to log it. A client that forgets is exactly how audit trails end
-- up with holes.
create or replace function audit_cameras() returns trigger
language plpgsql security definer as $$
declare
  who uuid := auth.uid();
begin
  insert into audit_log (actor, action, entity, entity_id, before, after)
  values (
    who,
    lower(tg_op),
    'cameras',
    coalesce(new.id, old.id),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return coalesce(new, old);
end $$;

drop trigger if exists cameras_audit on cameras;
create trigger cameras_audit after insert or update or delete on cameras
  for each row execute function audit_cameras();

-- ─────────────────────────────────────────────────────────────────────
-- Row-level security
--
-- Read is open to any signed-in user; writes need a role. Zone scoping is
-- applied on top for non-admins, which is what "an officer in one district is
-- not shown the whole state" actually means in SQL.
-- ─────────────────────────────────────────────────────────────────────

alter table cameras       enable row level security;
alter table camera_health enable row level security;
alter table detections    enable row level security;
alter table watchlist     enable row level security;
alter table alerts        enable row level security;
alter table coverage_gaps enable row level security;
alter table profiles      enable row level security;
alter table audit_log     enable row level security;
alter table departments   enable row level security;
alter table zones         enable row level security;

create or replace function my_role() returns text
language sql stable security definer as $$
  select coalesce((select role from profiles where id = auth.uid()), 'viewer')
$$;

create or replace function my_zone() returns text
language sql stable security definer as $$
  select (select zone_id from profiles where id = auth.uid())
$$;

do $$
begin
  -- Reference data: readable by anyone signed in.
  execute 'drop policy if exists read_departments on departments';
  execute 'create policy read_departments on departments for select to authenticated using (true)';
  execute 'drop policy if exists read_zones on zones';
  execute 'create policy read_zones on zones for select to authenticated using (true)';

  -- Cameras: zone-scoped read, role-gated write.
  execute 'drop policy if exists read_cameras on cameras';
  execute $p$create policy read_cameras on cameras for select to authenticated
    using (my_role() in ('admin','supervisor') or my_zone() is null or zone_id = my_zone())$p$;

  execute 'drop policy if exists write_cameras on cameras';
  execute $p$create policy write_cameras on cameras for all to authenticated
    using (my_role() in ('admin','supervisor'))
    with check (my_role() in ('admin','supervisor'))$p$;

  execute 'drop policy if exists read_health on camera_health';
  execute 'create policy read_health on camera_health for select to authenticated using (true)';

  execute 'drop policy if exists read_detections on detections';
  execute 'create policy read_detections on detections for select to authenticated using (true)';

  execute 'drop policy if exists read_alerts on alerts';
  execute 'create policy read_alerts on alerts for select to authenticated using (true)';
  execute 'drop policy if exists ack_alerts on alerts';
  execute $p$create policy ack_alerts on alerts for update to authenticated
    using (my_role() in ('admin','supervisor','operator'))
    with check (my_role() in ('admin','supervisor','operator'))$p$;

  execute 'drop policy if exists read_watchlist on watchlist';
  execute 'create policy read_watchlist on watchlist for select to authenticated using (true)';
  execute 'drop policy if exists write_watchlist on watchlist';
  execute $p$create policy write_watchlist on watchlist for all to authenticated
    using (my_role() in ('admin','supervisor'))
    with check (my_role() in ('admin','supervisor'))$p$;

  execute 'drop policy if exists read_gaps on coverage_gaps';
  execute 'create policy read_gaps on coverage_gaps for select to authenticated using (true)';

  -- A user sees their own profile; admins see everyone.
  execute 'drop policy if exists read_profiles on profiles';
  execute $p$create policy read_profiles on profiles for select to authenticated
    using (id = auth.uid() or my_role() = 'admin')$p$;

  -- The audit trail is readable by supervisors and above, and never writable
  -- from the client — only the trigger inserts, and it is security definer.
  execute 'drop policy if exists read_audit on audit_log';
  execute $p$create policy read_audit on audit_log for select to authenticated
    using (my_role() in ('admin','supervisor'))$p$;
end $$;

-- New sign-ups get a profile automatically, defaulting to the least privilege.
create or replace function handle_new_user() returns trigger
language plpgsql security definer as $$
begin
  insert into profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- ─────────────────────────────────────────────────────────────────────
-- Seed: the departments the design document names.
-- ─────────────────────────────────────────────────────────────────────

insert into departments (id, name, domain) values
  ('police',    'Home Department (Police)',                       'public'),
  ('traffic',   'Traffic Police',                                 'traffic'),
  ('health',    'Health & Family Welfare',                        'hospital'),
  ('pds',       'Food, Civil Supplies & Consumer Affairs',        'pds'),
  ('rto',       'Ports & Transport (RTO)',                        'rto'),
  ('municipal', 'Municipal / Panchayat',                          'public')
on conflict (id) do nothing;
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
