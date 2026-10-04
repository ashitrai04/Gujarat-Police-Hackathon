-- ─────────────────────────────────────────────────────────────────────
-- Scene events: crowd, fire, accident
--
-- These do not belong in `detections`. That table is one row per vehicle
-- sighting, keyed on a plate, and the whole point of it is that a plate can
-- be searched across cameras over time. A crowd has no plate, a fire has no
-- plate, and filing them there would mean a table where most rows are a
-- vehicle and some are weather.
--
-- The column that matters most here is `method`. Crowd counting is a real
-- detector: YOLO finds people and they are counted. Fire and accident are
-- scored zero-shot by the same image/text model that answers prompt search,
-- which is a screener, not a trained classifier -- it is good at "this frame
-- is worth a look" and must not be presented as "there is a fire". Storing
-- how a row was produced lets the control room show it at the right
-- confidence instead of treating all three alike.
-- ─────────────────────────────────────────────────────────────────────

create table if not exists events (
  id          uuid primary key default uuid_generate_v4(),
  camera_id   text not null references cameras(id) on delete cascade,
  kind        text not null check (kind in ('crowd', 'fire', 'accident')),

  -- 'detector' = something was found and counted.
  -- 'zero-shot' = a frame scored above a similarity threshold. Needs review.
  method      text not null default 'zero-shot'
    check (method in ('detector', 'zero-shot')),

  -- For zero-shot, the margin between the positive and negative prompt sets,
  -- not a probability. Kept raw so a threshold can be retuned later against
  -- rows already collected, rather than only against new footage.
  score       real,
  severity    text not null default 'review'
    check (severity in ('review', 'low', 'medium', 'high')),

  -- Crowd only. Null for the other kinds rather than 0, which would read as
  -- "nobody there" instead of "not applicable".
  people_peak integer,
  people_mean real,

  -- How many of the sampled frames agreed. A single frame above threshold is
  -- usually a reflection or a brake light; persistence is what separates an
  -- event from a flicker.
  frames_hit  integer not null default 1,
  frames_seen integer not null default 1,

  snapshot_url text,
  note         text,
  geom         geometry(Point, 4326),
  seen_at      timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists events_camera_idx  on events (camera_id, seen_at desc);
create index if not exists events_kind_idx    on events (kind, seen_at desc);
create index if not exists events_seen_at_idx on events (seen_at desc);
create index if not exists events_geom_gix    on events using gist (geom);
-- The control room's default view is "what needs looking at", which is a
-- severity filter in time order, not a scan of everything.
create index if not exists events_triage_idx  on events (severity, seen_at desc)
  where severity in ('medium', 'high');

alter table events enable row level security;

-- Signed-in staff read; only the service role writes. The worker uses the
-- service key and bypasses this entirely.
drop policy if exists events_read on events;
create policy events_read on events
  for select to authenticated using (true);

-- And the anonymous read the deployed demo depends on, in the same shape as
-- 0006. Without it the control room shows an empty event list to a visitor
-- who has not signed in, which reads as "the models found nothing" rather
-- than "you are nobody in particular" -- exactly the failure 0006 exists to
-- avoid. Writes stay closed.
drop policy if exists demo_read_events on events;
create policy demo_read_events on events
  for select to anon using (true);

-- PostgREST checks table privileges before it reaches a policy, so the grant
-- is required as well; without it the policies above are correct and still
-- return nothing.
grant select on events to anon;
grant select on events to authenticated;

notify pgrst, 'reload schema';

-- ── Reverting ─────────────────────────────────────────────────────────────
--   drop policy if exists demo_read_events on events;
--   revoke select on events from anon;
--   notify pgrst, 'reload schema';
