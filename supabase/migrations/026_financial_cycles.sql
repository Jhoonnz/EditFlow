-- Let each workspace use a contract-based financial cycle instead of being
-- forced into calendar months. Day 1 preserves the existing behavior.

alter table public.workspaces
add column if not exists financial_cycle_start_day smallint not null default 1;

alter table public.workspaces
drop constraint if exists workspaces_financial_cycle_start_day_check;

alter table public.workspaces
add constraint workspaces_financial_cycle_start_day_check
check (financial_cycle_start_day between 1 and 31);

-- Financial settings belong to the owner even when admins are allowed to
-- edit other workspace details through the regular API.
create or replace function public.enforce_workspace_financial_cycle_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.financial_cycle_start_day is distinct from old.financial_cycle_start_day
     and not public.has_workspace_role(
       old.id,
       array['owner']::public.workspace_role[]
     ) then
    raise exception 'Only the workspace owner can change the financial cycle';
  end if;

  return new;
end;
$$;

drop trigger if exists workspaces_enforce_financial_cycle_owner on public.workspaces;
create trigger workspaces_enforce_financial_cycle_owner
before update of financial_cycle_start_day on public.workspaces
for each row execute function public.enforce_workspace_financial_cycle_owner();

create or replace function public.update_workspace_financial_cycle(
  target_workspace uuid,
  cycle_start_day integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.has_workspace_role(
    target_workspace,
    array['owner']::public.workspace_role[]
  ) then
    raise exception 'Only the workspace owner can change the financial cycle';
  end if;

  if cycle_start_day is null or cycle_start_day not between 1 and 31 then
    raise exception 'The financial cycle day must be between 1 and 31';
  end if;

  update public.workspaces
  set financial_cycle_start_day = cycle_start_day
  where id = target_workspace;

  if not found then raise exception 'Workspace not found'; end if;
end;
$$;

revoke all on function public.enforce_workspace_financial_cycle_owner()
from public, anon, authenticated;
revoke all on function public.update_workspace_financial_cycle(uuid, integer)
from public, anon, authenticated;

grant execute on function public.update_workspace_financial_cycle(uuid, integer)
to authenticated;
