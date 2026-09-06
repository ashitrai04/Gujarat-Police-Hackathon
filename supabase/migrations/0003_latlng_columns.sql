-- Fix: reading a camera's coordinates failed with PGRST200.
--
-- The client selected `lat:st_y(geom::geometry)`. PostgREST does not evaluate
-- function calls in a select list — it parses `st_y(...)` as an embedded
-- relationship and looks for a foreign key to a table called `st_y`, then
-- fails. Every camera read would have returned that error, so the map would
-- have been empty against a database that was in fact correct.
--
-- Generated columns solve it properly. The coordinates become ordinary
-- columns PostgREST can select, they cannot drift from the geometry because
-- Postgres maintains them, and `geom` stays authoritative for spatial queries
-- so "every camera inside this polygon" is still one indexed operation.
--
-- ST_X and ST_Y are IMMUTABLE for geometry, which is what makes them legal in
-- a STORED generated column.

alter table cameras
  add column if not exists lat double precision
    generated always as (st_y(geom)) stored,
  add column if not exists lng double precision
    generated always as (st_x(geom)) stored;

alter table detections
  add column if not exists lat double precision
    generated always as (st_y(geom)) stored,
  add column if not exists lng double precision
    generated always as (st_x(geom)) stored;

-- PostgREST caches the schema; without this the new columns stay invisible
-- until the next restart.
notify pgrst, 'reload schema';
