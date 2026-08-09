-- Add revision rounds, team feedback, assignee notifications, and an atomic
-- task creation function that can save the initial download link.

alter table public.tasks
add column if not exists revision_round integer not null default 1
check (revision_round between 1 and 99);

create table public.task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  author_id uuid not null references public.profiles(id),
  kind text not null default 'comment' check (kind in ('comment', 'change_request')),
  body text not null check (char_length(trim(body)) between 1 and 4000),
  revision_round integer not null default 1 check (revision_round between 1 and 99),
  is_resolved boolean not null default false,
  resolved_by uuid references public.profiles(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index task_comments_task_created_idx
on public.task_comments(task_id, created_at asc);

create index task_comments_workspace_idx
on public.task_comments(workspace_id);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  type text not null check (type in ('assignment', 'comment', 'change_request')),
  message text not null check (char_length(message) between 1 and 500),
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_user_created_idx
on public.notifications(user_id, created_at desc);

create index notifications_workspace_idx
on public.notifications(workspace_id);

create trigger task_comments_touch_updated_at
before update on public.task_comments
for each row execute function public.touch_updated_at();

create or replace function public.validate_task_comment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.tasks
    where id = new.task_id
      and workspace_id = new.workspace_id
  ) then
    raise exception 'The comment task does not belong to this workspace';
  end if;

  return new;
end;
$$;

create trigger task_comments_validate_task
before insert or update of task_id, workspace_id on public.task_comments
for each row execute function public.validate_task_comment();

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
    'comment_reopened'
  )
);

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

    if new.assignee_id is not null and new.assignee_id is distinct from auth.uid() then
      insert into public.notifications (workspace_id, user_id, task_id, actor_id, type, message)
      values (
        new.workspace_id,
        new.assignee_id,
        new.id,
        auth.uid(),
        'assignment',
        'Você foi definido como responsável por “' || new.title || '”.'
      );
    end if;
  end if;

  if old.revision_round is distinct from new.revision_round then
    insert into public.task_activities (task_id, workspace_id, actor_id, action, details)
    values (
      new.id,
      new.workspace_id,
      auth.uid(),
      'revision_changed',
      jsonb_build_object('from_revision', old.revision_round, 'to_revision', new.revision_round)
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

create or replace function public.log_task_comment_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_task public.tasks%rowtype;
begin
  select * into target_task
  from public.tasks
  where id = new.task_id;

  if tg_op = 'INSERT' then
    insert into public.task_activities (task_id, workspace_id, actor_id, action, details)
    values (
      new.task_id,
      new.workspace_id,
      new.author_id,
      case when new.kind = 'change_request' then 'adjustment_requested' else 'comment_added' end,
      jsonb_build_object('comment_id', new.id, 'revision_round', new.revision_round)
    );

    if target_task.assignee_id is not null and target_task.assignee_id <> new.author_id then
      insert into public.notifications (workspace_id, user_id, task_id, actor_id, type, message)
      values (
        new.workspace_id,
        target_task.assignee_id,
        new.task_id,
        new.author_id,
        new.kind,
        case
          when new.kind = 'change_request' then 'Novo ajuste solicitado em “' || target_task.title || '”.'
          else 'Novo comentário em “' || target_task.title || '”.'
        end
      );
    end if;

    return new;
  end if;

  if old.is_resolved is distinct from new.is_resolved then
    insert into public.task_activities (task_id, workspace_id, actor_id, action, details)
    values (
      new.task_id,
      new.workspace_id,
      auth.uid(),
      case when new.is_resolved then 'comment_resolved' else 'comment_reopened' end,
      jsonb_build_object('comment_id', new.id, 'revision_round', new.revision_round)
    );
  end if;

  return new;
end;
$$;

create trigger task_comments_log_activity
after insert or update on public.task_comments
for each row execute function public.log_task_comment_activity();

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
  if auth.uid() is null or not public.is_workspace_member(workspace_target) then
    raise exception 'Workspace access denied';
  end if;

  if not exists (
    select 1 from public.boards
    where id = board_target and workspace_id = workspace_target
  ) then
    raise exception 'The board does not belong to this workspace';
  end if;

  if not exists (
    select 1 from public.columns
    where id = column_target and board_id = board_target
  ) then
    raise exception 'The column does not belong to this board';
  end if;

  if client_target is not null and not exists (
    select 1 from public.clients
    where id = client_target and workspace_id = workspace_target
  ) then
    raise exception 'The client does not belong to this workspace';
  end if;

  if download_url is not null and trim(download_url) <> '' and download_url !~ '^https://' then
    raise exception 'The download URL must use HTTPS';
  end if;

  insert into public.tasks (
    workspace_id,
    board_id,
    column_id,
    client_id,
    assignee_id,
    title,
    description,
    priority,
    position,
    due_at,
    revision_round,
    created_by
  ) values (
    workspace_target,
    board_target,
    column_target,
    client_target,
    assignee_target,
    trim(task_title),
    trim(task_description),
    task_priority,
    task_position,
    task_due_at,
    task_revision_round,
    auth.uid()
  ) returning id into new_task_id;

  if download_url is not null and trim(download_url) <> '' then
    insert into public.task_links (task_id, label, url, category, created_by)
    values (
      new_task_id,
      coalesce(nullif(trim(download_label), ''), 'Arquivos para download'),
      trim(download_url),
      'download',
      auth.uid()
    );
  end if;

  return new_task_id;
end;
$$;

alter table public.task_comments enable row level security;
alter table public.notifications enable row level security;

create policy "members view task comments" on public.task_comments
for select to authenticated
using (public.is_workspace_member(workspace_id));

create policy "members add task comments" on public.task_comments
for insert to authenticated
with check (public.is_workspace_member(workspace_id) and author_id = auth.uid());

create policy "members update task comments" on public.task_comments
for update to authenticated
using (public.is_workspace_member(workspace_id))
with check (public.is_workspace_member(workspace_id));

create policy "authors and admins delete task comments" on public.task_comments
for delete to authenticated
using (
  author_id = auth.uid()
  or public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
);

create policy "users view own notifications" on public.notifications
for select to authenticated
using (user_id = auth.uid());

create policy "users update own notifications" on public.notifications
for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy "users delete own notifications" on public.notifications
for delete to authenticated
using (user_id = auth.uid());

grant select, insert, update, delete on table public.task_comments to authenticated;
grant select, update, delete on table public.notifications to authenticated;
grant execute on function public.create_task_with_download_link(
  uuid, uuid, uuid, uuid, uuid, text, text, text, numeric, timestamptz, integer, text, text
) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'task_comments'
  ) then
    alter publication supabase_realtime add table public.task_comments;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end;
$$;
