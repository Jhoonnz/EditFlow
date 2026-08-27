-- Clear busy completion columns without deleting production history. Archived
-- tasks keep their comments, links, activities, completion date and earnings.

alter table public.tasks
add column if not exists archived_at timestamptz,
add column if not exists archived_by uuid references public.profiles(id) on delete set null;

create index if not exists tasks_board_archived_at_idx
on public.tasks(board_id, archived_at desc)
where archived_at is not null;

alter table public.task_activities
drop constraint if exists task_activities_action_check;

alter table public.task_activities
add constraint task_activities_action_check check (
  action in (
    'created',
    'updated',
    'moved',
    'assigned',
    'link_added',
    'link_removed',
    'revision_changed',
    'comment_added',
    'adjustment_requested',
    'comment_resolved',
    'comment_reopened',
    'work_started',
    'archived',
    'restored'
  )
);

-- Editors can operate their assigned task, but archiving production history
-- remains a planning action reserved for owners and admins.
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
    if old.archived_at is not null then
      raise exception 'Archived tasks must be restored before they can be updated';
    end if;

    if old.assignee_id is distinct from auth.uid()
       or new.assignee_id is distinct from auth.uid() then
      raise exception 'Editors can only update tasks assigned to them';
    end if;

    if row(
      new.workspace_id, new.board_id, new.client_id, new.title,
      new.description, new.priority, new.due_at, new.created_by,
      new.archived_at, new.archived_by
    ) is distinct from row(
      old.workspace_id, old.board_id, old.client_id, old.title,
      old.description, old.priority, old.due_at, old.created_by,
      old.archived_at, old.archived_by
    ) then
      raise exception 'Editors cannot change task planning details';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.protect_archived_task_column()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.archived_at is not null
     and new.column_id is distinct from old.column_id then
    raise exception 'Restore the archived task before moving it';
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_protect_archived_column on public.tasks;
create trigger tasks_protect_archived_column
before update of column_id on public.tasks
for each row execute function public.protect_archived_task_column();

create or replace function public.archive_completed_tasks(target_board uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_workspace uuid;
  archived_count integer;
begin
  select workspace_id into target_workspace
  from public.boards
  where id = target_board;

  if target_workspace is null or not public.has_workspace_role(
    target_workspace,
    array['owner', 'admin']::public.workspace_role[]
  ) then
    raise exception 'Only workspace owners and admins can archive completed tasks';
  end if;

  with archived as (
    update public.tasks as task_row
    set archived_at = now(),
        archived_by = auth.uid()
    from public.columns as column_row
    where task_row.board_id = target_board
      and column_row.id = task_row.column_id
      and column_row.board_id = target_board
      and column_row.is_completion
      and task_row.completed_at is not null
      and task_row.archived_at is null
    returning task_row.id, task_row.workspace_id, task_row.column_id, task_row.archived_at
  ), logged as (
    insert into public.task_activities (
      task_id, workspace_id, actor_id, action, details
    )
    select
      archived.id,
      archived.workspace_id,
      auth.uid(),
      'archived',
      jsonb_build_object(
        'archived_at', archived.archived_at,
        'column_id', archived.column_id
      )
    from archived
    returning id
  )
  select count(*) into archived_count from logged;

  return archived_count;
end;
$$;

create or replace function public.restore_completed_task(target_task uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_workspace uuid;
  target_column uuid;
begin
  select workspace_id, column_id
  into target_workspace, target_column
  from public.tasks
  where id = target_task
    and archived_at is not null
  for update;

  if target_workspace is null or not public.has_workspace_role(
    target_workspace,
    array['owner', 'admin']::public.workspace_role[]
  ) then
    raise exception 'Archived task not found or access denied';
  end if;

  if not exists (
    select 1 from public.columns
    where id = target_column and is_completion
  ) then
    raise exception 'Only completed tasks can be restored to the board';
  end if;

  update public.tasks
  set archived_at = null,
      archived_by = null
  where id = target_task;

  insert into public.task_activities (
    task_id, workspace_id, actor_id, action, details
  ) values (
    target_task,
    target_workspace,
    auth.uid(),
    'restored',
    jsonb_build_object('column_id', target_column)
  );
end;
$$;

revoke all on function public.archive_completed_tasks(uuid)
from public, anon, authenticated;
revoke all on function public.restore_completed_task(uuid)
from public, anon, authenticated;
revoke all on function public.protect_archived_task_column()
from public, anon, authenticated;

grant execute on function public.archive_completed_tasks(uuid) to authenticated;
grant execute on function public.restore_completed_task(uuid) to authenticated;
