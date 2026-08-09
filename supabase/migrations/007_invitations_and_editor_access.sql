-- Add invitation acceptance and enforce workspace roles at the database layer.
-- Owners/admins manage planning. Editors only see and operate assigned tasks.

create table public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null check (email = lower(trim(email)) and char_length(email) between 3 and 320),
  role public.workspace_role not null default 'editor' check (role <> 'owner'),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  invited_by uuid not null references public.profiles(id),
  invited_user_id uuid references public.profiles(id) on delete set null,
  expires_at timestamptz not null default (now() + interval '7 days'),
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index workspace_invitations_pending_email_idx
on public.workspace_invitations(workspace_id, email)
where status = 'pending';

create index workspace_invitations_email_status_idx
on public.workspace_invitations(email, status, created_at desc);

create trigger workspace_invitations_touch_updated_at
before update on public.workspace_invitations
for each row execute function public.touch_updated_at();

create or replace function public.is_workspace_invitee(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_invitations
    where workspace_id = target_workspace
      and email = lower(coalesce(auth.jwt() ->> 'email', ''))
      and status = 'pending'
      and expires_at > now()
  );
$$;

create or replace function public.can_access_task(target_task uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tasks as task_row
    where task_row.id = target_task
      and (
        public.has_workspace_role(
          task_row.workspace_id,
          array['owner', 'admin']::public.workspace_role[]
        )
        or (
          task_row.assignee_id = auth.uid()
          and public.has_workspace_role(
            task_row.workspace_id,
            array['editor']::public.workspace_role[]
          )
        )
      )
  );
$$;

create or replace function public.invite_workspace_member(
  target_workspace uuid,
  member_email text,
  member_role public.workspace_role default 'editor'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_email text := lower(trim(member_email));
  existing_user_id uuid;
  invitation_id uuid;
begin
  if not public.has_workspace_role(
    target_workspace,
    array['owner', 'admin']::public.workspace_role[]
  ) then
    raise exception 'Only workspace owners and admins can invite members';
  end if;

  if member_role = 'owner' then
    raise exception 'The owner role cannot be assigned by invitation';
  end if;

  if normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then
    raise exception 'A valid email is required';
  end if;

  select id into existing_user_id
  from auth.users
  where lower(email) = normalized_email
  limit 1;

  if existing_user_id is not null and exists (
    select 1 from public.workspace_members
    where workspace_id = target_workspace and user_id = existing_user_id
  ) then
    raise exception 'This account is already a workspace member';
  end if;

  select id into invitation_id
  from public.workspace_invitations
  where workspace_id = target_workspace
    and email = normalized_email
    and status = 'pending'
  for update;

  if invitation_id is null then
    insert into public.workspace_invitations (
      workspace_id, email, role, invited_by, expires_at
    ) values (
      target_workspace, normalized_email, member_role, auth.uid(), now() + interval '7 days'
    ) returning id into invitation_id;
  else
    update public.workspace_invitations
    set role = member_role,
        invited_by = auth.uid(),
        expires_at = now() + interval '7 days'
    where id = invitation_id;
  end if;

  return invitation_id;
end;
$$;

create or replace function public.accept_workspace_invitation(target_invitation uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  invitation public.workspace_invitations%rowtype;
  current_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into invitation
  from public.workspace_invitations
  where id = target_invitation
  for update;

  if invitation.id is null
     or invitation.status <> 'pending'
     or invitation.email <> current_email then
    raise exception 'Invitation not found or does not belong to this account';
  end if;

  if invitation.expires_at <= now() then
    raise exception 'This invitation has expired';
  end if;

  insert into public.profiles (id, display_name)
  select users.id, coalesce(users.raw_user_meta_data ->> 'full_name', '')
  from auth.users as users
  where users.id = auth.uid()
  on conflict (id) do nothing;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (invitation.workspace_id, auth.uid(), invitation.role)
  on conflict (workspace_id, user_id)
  do update set role = excluded.role;

  update public.workspace_invitations
  set status = 'accepted',
      invited_user_id = auth.uid(),
      responded_at = now()
  where id = invitation.id;

  return invitation.workspace_id;
end;
$$;

create or replace function public.decline_workspace_invitation(target_invitation uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.workspace_invitations
  set status = 'declined',
      invited_user_id = auth.uid(),
      responded_at = now()
  where id = target_invitation
    and status = 'pending'
    and email = lower(coalesce(auth.jwt() ->> 'email', ''));

  if not found then
    raise exception 'Invitation not found or does not belong to this account';
  end if;
end;
$$;

create or replace function public.cancel_workspace_invitation(target_invitation uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_workspace uuid;
begin
  select workspace_id into target_workspace
  from public.workspace_invitations
  where id = target_invitation and status = 'pending';

  if target_workspace is null or not public.has_workspace_role(
    target_workspace,
    array['owner', 'admin']::public.workspace_role[]
  ) then
    raise exception 'Only workspace owners and admins can cancel invitations';
  end if;

  update public.workspace_invitations
  set status = 'cancelled', responded_at = now()
  where id = target_invitation;
end;
$$;

create or replace function public.change_workspace_member_role(
  target_workspace uuid,
  target_user uuid,
  member_role public.workspace_role
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
    raise exception 'Only workspace owners and admins can change roles';
  end if;

  if member_role = 'owner' or exists (
    select 1 from public.workspaces
    where id = target_workspace and owner_id = target_user
  ) then
    raise exception 'The workspace owner role cannot be changed';
  end if;

  update public.workspace_members
  set role = member_role
  where workspace_id = target_workspace and user_id = target_user;

  if not found then raise exception 'Workspace member not found'; end if;
end;
$$;

-- Prevent editors from changing planning fields even through direct API calls.
create or replace function public.enforce_editor_task_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.has_workspace_role(
    old.workspace_id,
    array['editor']::public.workspace_role[]
  ) then
    if old.assignee_id is distinct from auth.uid()
       or new.assignee_id is distinct from auth.uid() then
      raise exception 'Editors can only update tasks assigned to them';
    end if;

    if row(
      new.workspace_id, new.board_id, new.client_id, new.title,
      new.description, new.priority, new.due_at, new.created_by
    ) is distinct from row(
      old.workspace_id, old.board_id, old.client_id, old.title,
      old.description, old.priority, old.due_at, old.created_by
    ) then
      raise exception 'Editors cannot change task planning details';
    end if;
  end if;

  return new;
end;
$$;

create trigger tasks_enforce_editor_update
before update on public.tasks
for each row execute function public.enforce_editor_task_update();

-- Invitation visibility.
alter table public.workspace_invitations enable row level security;

create policy "admins view workspace invitations" on public.workspace_invitations
for select to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

create policy "users view own workspace invitations" on public.workspace_invitations
for select to authenticated
using (email = lower(coalesce(auth.jwt() ->> 'email', '')));

create policy "invitees view invited workspaces" on public.workspaces
for select to authenticated
using (public.is_workspace_invitee(id));

-- Membership writes must go through the controlled RPC functions.
drop policy if exists "admins manage memberships" on public.workspace_members;
revoke insert, update, delete on table public.workspace_members from authenticated;

-- Clients: editors only see clients attached to one of their assigned tasks.
drop policy if exists "members manage clients" on public.clients;

create policy "admins manage clients" on public.clients
for all to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
with check (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

create policy "editors view assigned task clients" on public.clients
for select to authenticated
using (
  public.has_workspace_role(workspace_id, array['editor']::public.workspace_role[])
  and exists (
    select 1 from public.tasks as task_row
    where task_row.client_id = clients.id
      and task_row.workspace_id = clients.workspace_id
      and task_row.assignee_id = auth.uid()
  )
);

-- Boards and columns remain visible, but only admins can configure them.
drop policy if exists "members manage boards" on public.boards;

create policy "members view boards" on public.boards
for select to authenticated
using (public.is_workspace_member(workspace_id));

create policy "admins manage boards" on public.boards
for all to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
with check (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

drop policy if exists "members manage columns" on public.columns;

create policy "admins manage columns" on public.columns
for all to authenticated
using (
  exists (
    select 1 from public.boards as board_row
    where board_row.id = columns.board_id
      and public.has_workspace_role(board_row.workspace_id, array['owner', 'admin']::public.workspace_role[])
  )
)
with check (
  exists (
    select 1 from public.boards as board_row
    where board_row.id = columns.board_id
      and public.has_workspace_role(board_row.workspace_id, array['owner', 'admin']::public.workspace_role[])
  )
);

-- Tasks: admins see/manage everything; editors only see/update assigned tasks.
drop policy if exists "members manage tasks" on public.tasks;

create policy "admins manage tasks" on public.tasks
for all to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
with check (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

create policy "editors view assigned tasks" on public.tasks
for select to authenticated
using (
  assignee_id = auth.uid()
  and public.has_workspace_role(workspace_id, array['editor']::public.workspace_role[])
);

create policy "editors update assigned tasks" on public.tasks
for update to authenticated
using (
  assignee_id = auth.uid()
  and public.has_workspace_role(workspace_id, array['editor']::public.workspace_role[])
)
with check (
  assignee_id = auth.uid()
  and public.has_workspace_role(workspace_id, array['editor']::public.workspace_role[])
);

-- Task links follow task visibility. Assigned editors may add delivery/review links.
drop policy if exists "members manage task links" on public.task_links;

create policy "authorized users view task links" on public.task_links
for select to authenticated
using (public.can_access_task(task_id));

create policy "authorized users add task links" on public.task_links
for insert to authenticated
with check (public.can_access_task(task_id) and created_by = auth.uid());

create policy "authorized users update task links" on public.task_links
for update to authenticated
using (
  public.can_access_task(task_id)
  and (
    created_by = auth.uid()
    or exists (
      select 1 from public.tasks as task_row
      where task_row.id = task_links.task_id
        and public.has_workspace_role(task_row.workspace_id, array['owner', 'admin']::public.workspace_role[])
    )
  )
)
with check (
  public.can_access_task(task_id)
  and (
    created_by = auth.uid()
    or exists (
      select 1 from public.tasks as task_row
      where task_row.id = task_links.task_id
        and public.has_workspace_role(task_row.workspace_id, array['owner', 'admin']::public.workspace_role[])
    )
  )
);

create policy "authorized users delete task links" on public.task_links
for delete to authenticated
using (
  public.can_access_task(task_id)
  and (
    created_by = auth.uid()
    or exists (
      select 1 from public.tasks as task_row
      where task_row.id = task_links.task_id
        and public.has_workspace_role(task_row.workspace_id, array['owner', 'admin']::public.workspace_role[])
    )
  )
);

-- Feedback and history also follow task visibility.
drop policy if exists "members view task activities" on public.task_activities;

create policy "authorized users view task activities" on public.task_activities
for select to authenticated
using (public.can_access_task(task_id));

drop policy if exists "members view task comments" on public.task_comments;
drop policy if exists "members add task comments" on public.task_comments;
drop policy if exists "members update task comments" on public.task_comments;
drop policy if exists "authors and admins delete task comments" on public.task_comments;

create policy "authorized users view task comments" on public.task_comments
for select to authenticated
using (public.can_access_task(task_id));

create policy "authorized users add task comments" on public.task_comments
for insert to authenticated
with check (public.can_access_task(task_id) and author_id = auth.uid());

create policy "authorized users update task comments" on public.task_comments
for update to authenticated
using (public.can_access_task(task_id))
with check (public.can_access_task(task_id));

create policy "authorized users delete own task comments" on public.task_comments
for delete to authenticated
using (
  public.can_access_task(task_id)
  and (
    author_id = auth.uid()
    or public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
  )
);

-- Secure RPCs that bypass RLS because they are SECURITY DEFINER.
create or replace function public.reorder_columns(
  target_board uuid,
  ordered_column_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_workspace uuid;
  expected_count integer;
begin
  select workspace_id into target_workspace from public.boards where id = target_board;

  if target_workspace is null or not public.has_workspace_role(
    target_workspace,
    array['owner', 'admin']::public.workspace_role[]
  ) then
    raise exception 'Only workspace owners and admins can reorder columns';
  end if;

  select count(*) into expected_count from public.columns where board_id = target_board;

  if ordered_column_ids is null
     or cardinality(ordered_column_ids) <> expected_count
     or (select count(distinct id) from unnest(ordered_column_ids) as ids(id)) <> expected_count
     or (select count(*) from public.columns where board_id = target_board and id = any(ordered_column_ids)) <> expected_count then
    raise exception 'The column order is incomplete or invalid';
  end if;

  update public.columns as column_row
  set position = ordered.position * 1000
  from unnest(ordered_column_ids) with ordinality as ordered(id, position)
  where column_row.id = ordered.id and column_row.board_id = target_board;
end;
$$;

create or replace function public.reorder_tasks(
  target_board uuid,
  ordered_items jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_workspace uuid;
  input_count integer;
  updated_count integer;
  is_admin boolean;
  is_editor boolean;
begin
  select workspace_id into target_workspace from public.boards where id = target_board;
  is_admin := public.has_workspace_role(target_workspace, array['owner', 'admin']::public.workspace_role[]);
  is_editor := public.has_workspace_role(target_workspace, array['editor']::public.workspace_role[]);

  if target_workspace is null or not (is_admin or is_editor) then
    raise exception 'Board access denied';
  end if;

  if ordered_items is null or jsonb_typeof(ordered_items) <> 'array' then
    raise exception 'The task order must be an array';
  end if;

  input_count := jsonb_array_length(ordered_items);

  if (
    select count(distinct item.id)
    from jsonb_to_recordset(ordered_items) as item(id uuid, column_id uuid, position numeric)
  ) <> input_count then
    raise exception 'The task order contains duplicate or invalid task ids';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(ordered_items) as item(id uuid, column_id uuid, position numeric)
    left join public.tasks as task_row on task_row.id = item.id and task_row.board_id = target_board
    left join public.columns as column_row on column_row.id = item.column_id and column_row.board_id = target_board
    where task_row.id is null
       or column_row.id is null
       or item.position is null
       or (is_editor and task_row.assignee_id is distinct from auth.uid())
  ) then
    raise exception 'The task order contains an inaccessible task or column';
  end if;

  update public.tasks as task_row
  set column_id = item.column_id, position = item.position
  from jsonb_to_recordset(ordered_items) as item(id uuid, column_id uuid, position numeric)
  where task_row.id = item.id and task_row.board_id = target_board;

  get diagnostics updated_count = row_count;
  if updated_count <> input_count then raise exception 'Not all tasks could be reordered'; end if;
end;
$$;

-- Require admin role in the atomic task creation RPC.
create or replace function public.create_task_with_download_link(
  workspace_target uuid,
  board_target uuid,
  column_target uuid,
  client_target uuid,
  assignee_target uuid,
  task_title text,
  task_description text,
  task_priority text,
  task_position numeric,
  task_due_at timestamptz,
  task_revision_round integer,
  download_label text,
  download_url text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_task_id uuid;
begin
  if auth.uid() is null or not public.has_workspace_role(
    workspace_target,
    array['owner', 'admin']::public.workspace_role[]
  ) then
    raise exception 'Only workspace owners and admins can create tasks';
  end if;

  if not exists (select 1 from public.boards where id = board_target and workspace_id = workspace_target) then
    raise exception 'The board does not belong to this workspace';
  end if;
  if not exists (select 1 from public.columns where id = column_target and board_id = board_target) then
    raise exception 'The column does not belong to this board';
  end if;
  if client_target is not null and not exists (
    select 1 from public.clients where id = client_target and workspace_id = workspace_target
  ) then
    raise exception 'The client does not belong to this workspace';
  end if;
  if download_url is not null and trim(download_url) <> '' and download_url !~ '^https://' then
    raise exception 'The download URL must use HTTPS';
  end if;

  insert into public.tasks (
    workspace_id, board_id, column_id, client_id, assignee_id, title,
    description, priority, position, due_at, revision_round, created_by
  ) values (
    workspace_target, board_target, column_target, client_target, assignee_target,
    trim(task_title), trim(task_description), task_priority, task_position,
    task_due_at, task_revision_round, auth.uid()
  ) returning id into new_task_id;

  if download_url is not null and trim(download_url) <> '' then
    insert into public.task_links (task_id, label, url, category, created_by)
    values (
      new_task_id,
      coalesce(nullif(trim(download_label), ''), 'Arquivos para download'),
      trim(download_url), 'download', auth.uid()
    );
  end if;

  return new_task_id;
end;
$$;

revoke all on table public.workspace_invitations from anon, authenticated;
grant select on table public.workspace_invitations to authenticated;

revoke all on function public.add_workspace_member(uuid, text, public.workspace_role) from public, authenticated;
revoke all on function public.invite_workspace_member(uuid, text, public.workspace_role) from public;
revoke all on function public.accept_workspace_invitation(uuid) from public;
revoke all on function public.decline_workspace_invitation(uuid) from public;
revoke all on function public.cancel_workspace_invitation(uuid) from public;
revoke all on function public.change_workspace_member_role(uuid, uuid, public.workspace_role) from public;
revoke all on function public.is_workspace_invitee(uuid) from public;
revoke all on function public.can_access_task(uuid) from public;

grant execute on function public.invite_workspace_member(uuid, text, public.workspace_role) to authenticated;
grant execute on function public.accept_workspace_invitation(uuid) to authenticated;
grant execute on function public.decline_workspace_invitation(uuid) to authenticated;
grant execute on function public.cancel_workspace_invitation(uuid) to authenticated;
grant execute on function public.change_workspace_member_role(uuid, uuid, public.workspace_role) to authenticated;
grant execute on function public.is_workspace_invitee(uuid) to authenticated;
grant execute on function public.can_access_task(uuid) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'workspace_invitations'
  ) then
    alter publication supabase_realtime add table public.workspace_invitations;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'workspace_members'
  ) then
    alter publication supabase_realtime add table public.workspace_members;
  end if;
end;
$$;
