-- Evidence images for each sighting.
--
-- OCR on this footage is right most of the time, not all of the time. An
-- operator acting on a plate needs to be able to check it — and a wrong plate
-- acted on in a control room is a far worse failure than a plate the system
-- declines to read. So every detection carries two images:
--
--   snapshot_url    the full frame, vehicle boxed, plate labelled. Context:
--                   which vehicle, which lane, what else was around it.
--   plate_crop_url  the plate alone, enlarged. This is what an operator reads
--                   to confirm or correct the characters by eye.
--
-- The full frame is also the accountability record: it shows the moment the
-- system claims something happened, not just its conclusion about it.

alter table detections
  add column if not exists plate_crop_url text;

comment on column detections.snapshot_url is
  'Full frame with the vehicle boxed and the plate labelled — context and audit.';
comment on column detections.plate_crop_url is
  'Enlarged crop of the plate alone, for an operator to verify the read by eye.';

-- Public bucket: these are evidence images the control room displays, and the
-- URLs are unguessable. Nothing here is more sensitive than the live feed the
-- same operator is already watching.
insert into storage.buckets (id, name, public)
values ('evidence', 'evidence', true)
on conflict (id) do nothing;

do $$
begin
  execute 'drop policy if exists evidence_read on storage.objects';
  execute $p$create policy evidence_read on storage.objects
    for select using (bucket_id = 'evidence')$p$;

  -- Only the worker writes here, and it uses the service role, which bypasses
  -- these policies. No client-side write policy is created on purpose.
  execute 'drop policy if exists evidence_no_client_write on storage.objects';
end $$;

notify pgrst, 'reload schema';
