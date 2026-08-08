-- Remove accidental duplicate workspaces, keeping the oldest workspace for
-- each owner/name pair. Child boards and columns are removed by cascade.
with ranked_workspaces as (
  select
    id,
    row_number() over (
      partition by owner_id, lower(trim(name))
      order by created_at asc, id asc
    ) as duplicate_number
  from public.workspaces
)
delete from public.workspaces as workspace
using ranked_workspaces as ranked
where workspace.id = ranked.id
  and ranked.duplicate_number > 1;

create or replace function public.add_workspace_member(
  target_workspace uuid,
  member_email text,
  member_role public.workspace_role default 'editor'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  member_user auth.users%rowtype;
begin
  if not public.has_workspace_role(
    target_workspace,
    array['owner', 'admin']::public.workspace_role[]
  ) then
    raise exception 'Only workspace owners and admins can add members';
  end if;

  if member_role = 'owner' then
    raise exception 'The owner role cannot be assigned by invitation';
  end if;

  select * into member_user
  from auth.users
  where lower(email) = lower(trim(member_email))
  limit 1;

  if member_user.id is null then
    raise exception 'No EditFlow account was found for this email';
  end if;

  insert into public.profiles (id, display_name)
  values (
    member_user.id,
    coalesce(member_user.raw_user_meta_data ->> 'full_name', '')
  )
  on conflict (id) do nothing;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (target_workspace, member_user.id, member_role)
  on conflict (workspace_id, user_id)
  do update set role = excluded.role;
end;
$$;

create or replace function public.remove_workspace_member(
  target_workspace uuid,
  target_user uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_workspace_role(
    target_workspace,
    array['owner', 'admin']::public.workspace_role[]
  ) then
    raise exception 'Only workspace owners and admins can remove members';
  end if;

  if exists (
    select 1 from public.workspaces
    where id = target_workspace and owner_id = target_user
  ) then
    raise exception 'The workspace owner cannot be removed';
  end if;

  delete from public.workspace_members
  where workspace_id = target_workspace and user_id = target_user;
end;
$$;

create or replace function public.delete_workspace(target_workspace uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.workspaces
    where id = target_workspace and owner_id = auth.uid()
  ) then
    raise exception 'Only the workspace owner can delete it';
  end if;

  delete from public.workspaces where id = target_workspace;
end;
$$;

grant execute on function public.add_workspace_member(uuid, text, public.workspace_role) to authenticated;
grant execute on function public.remove_workspace_member(uuid, uuid) to authenticated;
grant execute on function public.delete_workspace(uuid) to authenticated;
