-- Wording only: the grant behind West Mountain is not BEAD, so the column
-- comment shipped in 20260908120000_service_projects.sql named the wrong
-- program. No schema or data change.
comment on column public.projects.service_for_project_id is
  'Set on a non-grant "Service" sibling: the grant project whose fix-job material this project absorbs. NULL on every ordinary project. A project with a sibling is grant-restricted.';
