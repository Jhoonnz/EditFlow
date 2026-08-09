-- Complete the production workflow with task assignment, activity history,
-- and atomic ordering operations for cards and columns.

alter table public.tasks
add column if not exists assignee_id uuid references public.profiles(id) on delete set null;

create index if not exists tasks_assignee_idx on public.tasks(assignee_id);

create table public.task_activities (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null check (action in ('created', 'updated', 'moved', 'assigned', 'link_added', 'link_removed')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index task_activities_task_created_idx
on public.task_activities(task_id, created_at desc);

create index task_activities_workspace_idx
on public.task_activities(workspace_id);

insert into public.task_activities (task_id, workspace_id, actor_id, action, details, created_at)
select
  task_row.id,
  task_row.workspace_id,
  task_row.created_by,
  'created',
  jsonb_build_object('title', task_row.title, 'column_id', task_row.column_id),
  task_row.created_at
from public.tasks as task_row
where not exists (
  select 1 from public.task_activities as activity
  where activity.task_id = task_row.id and activity.action = 'created'
);

create or replace function public.validate_task_assignee()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.assignee_id is not null and not exists (
    select 1
    from public.workspace_members
    where workspace_id = new.workspace_id
      and user_id = new.assignee_id
  ) then
    raise exception 'The assignee must be a member of this workspace';
  end if;

  return new;
end;
$$;

create trigger tasks_validate_assignee
before insert or update of assignee_id, workspace_id on public.tasks
for each row execute function public.validate_task_assignee();

create or replace function public.log_task_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.task_activities (task_id, workspace_id, actor_id, action, details)
    values (
      new.id,
      new.workspace_id,
      auth.uid(),
      'created',
      jsonb_build_object('title', new.title, 'column_id', new.column_id)
    );
    return new;
  end if;

  if old.column_id is distinct from new.column_id then
    insert into public.task_activities (task_id, workspace_id, actor_id, action, details)
    values (
      new.id,
      new.workspace_id,
      auth.uid(),
      'moved',
      jsonb_build_object('from_column_id', old.column_id, 'to_column_id', new.column_id)
    );
  end if;

  if old.assignee_id is distinct from new.assignee_id then
    insert into public.task_activities (task_id, workspace_id, actor_id, action, details)
    values (
      new.id,
      new.workspace_id,
      auth.uid(),
      'assigned',
      jsonb_build_object('from_user_id', old.assignee_id, 'to_user_id', new.assignee_id)
    );
  end if;

  if row(old.title, old.description, old.priority, old.due_at, old.client_id)
     is distinct from
     row(new.title, new.description, new.priority, new.due_at, new.client_id) then
    insert into public.task_activities (task_id, workspace_id, actor_id, action, details)
    values (new.id, new.workspace_id, auth.uid(), 'updated', '{}'::jsonb);
  end if;

  return new;
end;
$$;

create trigger tasks_log_activity
after insert or update on public.tasks
for each row execute function public.log_task_activity();

create or replace function public.log_task_link_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_task public.tasks%rowtype;
  target_task_id uuid;
  link_label text;
  link_category text;
begin
  if tg_op = 'DELETE' then
    target_task_id := old.task_id;
    link_label := old.label;
    link_category := old.category;
  else
    target_task_id := new.task_id;
    link_label := new.label;
    link_category := new.category;
  end if;

  select * into target_task
  from public.tasks
  where id = target_task_id;

  if target_task.id is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  insert into public.task_activities (task_id, workspace_id, actor_id, action, details)
  values (
    target_task.id,
    target_task.workspace_id,
    auth.uid(),
    case when tg_op = 'DELETE' then 'link_removed' else 'link_added' end,
    jsonb_build_object(
      'label', link_label,
      'category', link_category
    )
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger task_links_log_activity
after insert or delete on public.task_links
for each row execute function public.log_task_link_activity();

create or replace function public.clear_removed_member_assignments()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.tasks
  set assignee_id = null
  where workspace_id = old.workspace_id
    and assignee_id = old.user_id;
  return old;
end;
$$;

create trigger workspace_members_clear_assignments
before delete on public.workspace_members
for each row execute function public.clear_removed_member_assignments();

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
  select workspace_id into target_workspace
  from public.boards
  where id = target_board;

  if target_workspace is null or not public.is_workspace_member(target_workspace) then
    raise exception 'Board access denied';
  end if;

  select count(*) into expected_count
  from public.columns
  where board_id = target_board;

  if ordered_column_ids is null
     or cardinality(ordered_column_ids) <> expected_count
     or (select count(distinct id) from unnest(ordered_column_ids) as ids(id)) <> expected_count
     or (select count(*) from public.columns where board_id = target_board and id = any(ordered_column_ids)) <> expected_count then
    raise exception 'The column order is incomplete or invalid';
  end if;

  update public.columns as column_row
  set position = ordered.position * 1000
  from unnest(ordered_column_ids) with ordinality as ordered(id, position)
  where column_row.id = ordered.id
    and column_row.board_id = target_board;
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
begin
  select workspace_id into target_workspace
  from public.boards
  where id = target_board;

  if target_workspace is null or not public.is_workspace_member(target_workspace) then
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
    where task_row.id is null or column_row.id is null or item.position is null
  ) then
    raise exception 'The task order contains a task or column from another board';
  end if;

  update public.tasks as task_row
  set
    column_id = item.column_id,
    position = item.position
  from jsonb_to_recordset(ordered_items) as item(id uuid, column_id uuid, position numeric)
  where task_row.id = item.id
    and task_row.board_id = target_board;

  get diagnostics updated_count = row_count;
  if updated_count <> input_count then
    raise exception 'Not all tasks could be reordered';
  end if;
end;
$$;

alter table public.task_activities enable row level security;

create policy "members view task activities" on public.task_activities
for select to authenticated
using (public.is_workspace_member(workspace_id));

grant select on table public.task_activities to authenticated;
grant execute on function public.reorder_columns(uuid, uuid[]) to authenticated;
grant execute on function public.reorder_tasks(uuid, jsonb) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'columns'
  ) then
    alter publication supabase_realtime add table public.columns;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'task_activities'
  ) then
    alter publication supabase_realtime add table public.task_activities;
  end if;
end;
$$;
