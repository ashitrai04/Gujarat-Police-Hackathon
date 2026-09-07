-- Read access for a visitor who has not signed in.
--
-- Every read policy written so far is `to authenticated`, which is correct for
-- the deployed system: an officer signs in, and `read_cameras` scopes them to
-- their own zone unless they are an admin or supervisor. That model is the
-- point, and none of it changes here.
--
-- But it means someone opening the link without credentials gets an empty
-- interface. Not an error, not a login wall — a map with no detections, no
-- alerts, no evidence. The cameras still appear, because those come from the
-- static registry rather than from here, which makes the failure look like the
-- analytics are broken rather than like the reader is anonymous.
--
-- For evaluation that is the wrong failure. So the operational tables also get
-- an anonymous read policy, kept deliberately separate from the policies above
-- so the two can be reasoned about — and removed — independently.
--
-- What is NOT opened, and will not be:
--
--   profiles    who the officers are, their roles and zones
--   audit_log   who looked at what, and when
--
-- Those are the two tables where anonymous read would be a genuine disclosure,
-- and they stay `to authenticated`. Writes stay authenticated everywhere too:
-- acknowledging an alert, editing the watchlist and changing a camera all
-- still require a signed-in account with the right role. This grant is read
-- and nothing but read.
--
-- To close it before a real deployment, run the revert block at the bottom.

do $$
declare
  t text;
begin
  -- Same shape for each: select only, anon only, no row filtering. The zone
  -- scoping in `read_cameras` is a property of who you are, and an anonymous
  -- reader is nobody in particular — there is no zone to scope them to.
  foreach t in array array[
    'cameras', 'camera_health', 'detections',
    'alerts', 'watchlist', 'coverage_gaps',
    'departments', 'zones'
  ] loop
    execute format('drop policy if exists demo_read_%1$s on %1$I', t);
    execute format(
      'create policy demo_read_%1$s on %1$I for select to anon using (true)', t);
  end loop;
end $$;

-- PostgREST checks table privileges before it ever reaches a policy, so the
-- grant and the policy are both required. Without this the policies above are
-- correct and still return nothing.
grant usage on schema public to anon;
grant select on
  cameras, camera_health, detections,
  alerts, watchlist, coverage_gaps,
  departments, zones
to anon;

-- Realtime delivers changes through the same policies, so alert subscriptions
-- reach an anonymous viewer once the select policy above exists.

notify pgrst, 'reload schema';

-- ── Reverting ─────────────────────────────────────────────────────────────
-- Closing this off leaves the signed-in policies untouched:
--
--   do $$
--   declare t text;
--   begin
--     foreach t in array array[
--       'cameras','camera_health','detections','alerts',
--       'watchlist','coverage_gaps','departments','zones'
--     ] loop
--       execute format('drop policy if exists demo_read_%1$s on %1$I', t);
--       execute format('revoke select on %1$I from anon', t);
--     end loop;
--   end $$;
--   notify pgrst, 'reload schema';
