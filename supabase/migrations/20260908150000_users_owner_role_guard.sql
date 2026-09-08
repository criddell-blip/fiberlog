-- Owner grants are owner-only — for real, not just in the Users screen.
--
-- admin-create-user refuses to CREATE an owner unless the caller is one, but
-- on the UPDATE path the same rule lived only in AdminUsersView's
-- `cannotPickOwner`: the users_staff_update RLS policy lets any manager set
-- any row — including their own — to role='owner' straight through the API.
-- This trigger makes the rule server-side: a role change to OR from 'owner'
-- requires the caller to already be an owner.
--
-- Direct SQL / service-role maintenance (no JWT → auth.uid() IS NULL) is
-- exempt on purpose: that is how a lost-owner situation gets repaired, and it
-- is the same posture is_owner() / is_staff() already take.

create or replace function public.guard_owner_role_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.role is distinct from new.role
     and (old.role = 'owner' or new.role = 'owner')
     and auth.uid() is not null
     and not public.is_owner()
  then
    raise exception 'Only an owner can grant or remove owner access'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_users_owner_role_guard on public.users;
create trigger trg_users_owner_role_guard
  before update of role on public.users
  for each row
  execute function public.guard_owner_role_change();

comment on function public.guard_owner_role_change() is
  'BEFORE UPDATE OF role on users: a change to or from owner needs an owner caller (is_owner()). No-JWT maintenance is exempt.';
