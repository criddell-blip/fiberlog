-- Cutover step 2 of 2 — DO NOT APPLY WITH THE REST.
--
-- Apply this only AFTER the strand-footage-map bundle has been live for at
-- least a full working day. Crews keep phone tabs open for days; any client
-- still running the old JS relies on the per_ft row below and would silently
-- log zero strand the moment it disappears.
--
-- Why the waiting window is safe: between the deploy and this migration BOTH
-- paths are active, but the mapped SKU is the same SKU the strand-ft assembly
-- already derives, so linesToParts' per-assembly collision guard drops the
-- footage row and behavior stays byte-identical to before the deploy. This
-- migration is the point where footageParts takes over.
--
-- Run as SQL, NOT through the Assembly editor. Saving strand-ft from a stale
-- bundle sends a payload without is_strand, and replace_assembly's
-- COALESCE(..., false) would reset the flag — killing the picker with the
-- per_ft row already gone.
--
-- `down-guy` KEEPS its own 20-ft-per-guy row on this same SKU. That is
-- legitimate non-footage consumption, and it is exactly why the collision
-- guard had to be narrowed from app-wide to per-assembly first: an app-wide
-- skip would let a single down guy suppress an entire day of strand footage.
--
-- Verify before AND after — quantity should equal total_strand_ft + 20 × guys:
--   select le.created_at::date, ep.quantity, s.total_strand_ft
--   from entry_parts ep join log_entries le on le.id = ep.entry_id
--   left join submissions s on s.id = le.submission_id
--   where ep.part_id = '600-200001-5000-ERC'
--     and le.created_at > now() - interval '3 days'
--   order by le.created_at desc;

delete from public.assembly_parts
where assembly_id = 'strand-ft'
  and part_id = '600-200001-5000-ERC';
