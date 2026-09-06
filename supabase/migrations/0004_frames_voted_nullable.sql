-- Fix: the worker could not insert a detection whose read count is unknown.
--
--   null value in column "frames_voted" violates not-null constraint
--
-- 0001 declared frames_voted `not null default 1`. That default is a claim,
-- not a fact: it says one frame voted on this plate. The pipeline's plate list
-- does not carry the count, so writing 1 would understate confidence for a
-- plate resolved from twenty frames — and that number is precisely what tells
-- an operator how far to trust the string. "Unknown" is a real state and needs
-- to be representable.
--
-- The column stays populated wherever the count is known; the UI already falls
-- back to per-read confidence when it is null.

alter table detections
  alter column frames_voted drop not null,
  alter column frames_voted drop default;

comment on column detections.frames_voted is
  'Frames that voted on this plate. NULL means the count was not reported, '
  'not that one frame voted.';

notify pgrst, 'reload schema';
