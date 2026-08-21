-- Configurable workflow automations for each board column. Rules are attached
-- to column IDs (never names), so teams can rename and reorder their workflow
-- without changing the behavior.

alter table public.columns
add column if not exists automation_register_start boolean not null default false,
add column if not exists automation_required_link_category text,
add column if not exists automation_notify_admins boolean not null default false,
add column if not exists automation_inactivity_days smallint;

alter table public.columns
drop constraint if exists columns_automation_required_link_category_check;

alter table public.columns
add constraint columns_automation_required_link_category_check
check (
  automation_required_link_category is null
  or automation_required_link_category in ('download', 'briefing', 'reference', 'review', 'delivery')
);

alter table public.columns
drop constraint if exists columns_automation_inactivity_days_check;

alter table public.columns
add constraint columns_automation_inactivity_days_check
check (automation_inactivity_days is null or automation_inactivity_days between 1 and 90);

-- A task has one real start date. Returning from review to editing does not
-- overwrite it, preserving accurate cycle-time information.
alter table public.tasks
add column if not exists started_at timestamptz,
add column if not exists started_by uuid references public.profiles(id) on delete set null;

create unique index if not exists columns_one_start_automation_per_board_idx
on public.columns(board_id)
where automation_register_start;

create index if not exists tasks_workspace_started_idx
on public.tasks(workspace_id, started_at)
where started_at is not null;

-- Clients cannot forge start timestamps. The later column automation trigger
-- is the only code path that stamps these fields during a column movement.
create or replace function public.protect_task_work_start()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and (new.started_at is not null or new.started_by is not null))
     or (tg_op = 'UPDATE' and row(new.started_at, new.started_by)
       is distinct from row(old.started_at, old.started_by)) then
    raise exception 'O início do trabalho é registrado automaticamente pelo quadro';
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_00_protect_work_start on public.tasks;
create trigger tasks_00_protect_work_start
before insert or update of started_at, started_by on public.tasks
for each row execute function public.protect_task_work_start();

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
    'work_started'
  )
);

alter table public.notifications
drop constraint if exists notifications_type_check;

alter table public.notifications
add constraint notifications_type_check check (
  type in (
    'assignment',
    'comment',
    'change_request',
    'task_updated',
    'task_moved',
    'invite_accepted',
    'chat_message',
    'chat_mention',
    'automation_alert'
  )
);

-- Admins may keep managing column names/colors, but automation rules belong to
-- the workspace owner. This also protects direct REST updates.
create or replace function public.enforce_column_automation_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_workspace uuid;
begin
  if tg_op = 'INSERT' then
    if new.automation_register_start
       or new.automation_required_link_category is not null
       or new.automation_notify_admins
       or new.automation_inactivity_days is not null then
      select workspace_id into target_workspace
      from public.boards
      where id = new.board_id;

      if not public.has_workspace_role(
        target_workspace,
        array['owner']::public.workspace_role[]
      ) then
        raise exception 'Somente o proprietário pode configurar automações do quadro';
      end if;
    end if;

    return new;
  end if;

  if row(
    new.automation_register_start,
    new.automation_required_link_category,
    new.automation_notify_admins,
    new.automation_inactivity_days
  ) is distinct from row(
    old.automation_register_start,
    old.automation_required_link_category,
    old.automation_notify_admins,
    old.automation_inactivity_days
  ) then
    select workspace_id into target_workspace
    from public.boards
    where id = new.board_id;

    if not public.has_workspace_role(
      target_workspace,
      array['owner']::public.workspace_role[]
    ) then
      raise exception 'Somente o proprietário pode configurar automações do quadro';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists columns_enforce_automation_owner on public.columns;
create trigger columns_enforce_automation_owner
before insert or update of automation_register_start, automation_required_link_category,
  automation_notify_admins, automation_inactivity_days
on public.columns
for each row execute function public.enforce_column_automation_owner();

-- Save the visual column settings and its automations in one transaction.
create or replace function public.update_column_configuration(
  target_column uuid,
  column_name text,
  column_color text,
  register_work_start boolean,
  required_link_category text,
  notify_admins_on_entry boolean,
  inactivity_days integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_board uuid;
  target_workspace uuid;
  current_column public.columns%rowtype;
  changes_automation boolean;
begin
  select * into current_column
  from public.columns
  where id = target_column;

  if current_column.id is null then
    raise exception 'Coluna não encontrada';
  end if;

  target_board := current_column.board_id;
  -- Lock every column in a stable order so two simultaneous configuration
  -- changes cannot deadlock while swapping the board's start rule.
  perform 1
  from public.columns
  where board_id = target_board
  order by id
  for update;

  select * into current_column
  from public.columns
  where id = target_column;

  select workspace_id into target_workspace
  from public.boards
  where id = target_board;

  if not public.has_workspace_role(
    target_workspace,
    array['owner', 'admin']::public.workspace_role[]
  ) then
    raise exception 'Acesso ao quadro negado';
  end if;

  if column_name is null or char_length(trim(column_name)) not between 1 and 80 then
    raise exception 'O nome da coluna deve ter entre 1 e 80 caracteres';
  end if;

  if required_link_category is not null
     and required_link_category not in ('download', 'briefing', 'reference', 'review', 'delivery') then
    raise exception 'Categoria de link inválida';
  end if;

  if inactivity_days is not null and inactivity_days not between 1 and 90 then
    raise exception 'O alerta de inatividade deve ficar entre 1 e 90 dias';
  end if;

  changes_automation := row(
    coalesce(register_work_start, false),
    required_link_category,
    coalesce(notify_admins_on_entry, false),
    inactivity_days
  ) is distinct from row(
    current_column.automation_register_start,
    current_column.automation_required_link_category,
    current_column.automation_notify_admins,
    current_column.automation_inactivity_days::integer
  );

  if changes_automation and not public.has_workspace_role(
    target_workspace,
    array['owner']::public.workspace_role[]
  ) then
    raise exception 'Somente o proprietário pode configurar automações do quadro';
  end if;

  if coalesce(register_work_start, false) then
    update public.columns
    set automation_register_start = false
    where board_id = target_board
      and id <> target_column
      and automation_register_start;
  end if;

  update public.columns
  set name = trim(column_name),
      color = column_color,
      automation_register_start = coalesce(register_work_start, false),
      automation_required_link_category = required_link_category,
      automation_notify_admins = coalesce(notify_admins_on_entry, false),
      automation_inactivity_days = inactivity_days
  where id = target_column;
end;
$$;

-- Validate the destination and stamp the first real work start before the
-- existing completion trigger evaluates the same movement.
create or replace function public.apply_task_column_automation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_column public.columns%rowtype;
begin
  if tg_op = 'UPDATE' and old.column_id is not distinct from new.column_id then
    return new;
  end if;

  select * into target_column
  from public.columns
  where id = new.column_id;

  if target_column.id is null or target_column.board_id <> new.board_id then
    raise exception 'A coluna de destino não pertence a este quadro';
  end if;

  -- Initial creation is allowed because its optional link is inserted by the
  -- same RPC immediately after the task row. Requirements apply to movement.
  if tg_op = 'UPDATE'
     and target_column.automation_required_link_category is not null
     and not exists (
       select 1
       from public.task_links as link_row
       where link_row.task_id = new.id
         and link_row.category = target_column.automation_required_link_category
     ) then
    raise exception 'Adicione um link de % antes de mover a tarefa para %',
      case target_column.automation_required_link_category
        when 'download' then 'download'
        when 'briefing' then 'briefing'
        when 'reference' then 'referência'
        when 'review' then 'revisão'
        else 'entrega'
      end,
      target_column.name;
  end if;

  if target_column.automation_register_start and new.started_at is null then
    new.started_at := now();
    new.started_by := auth.uid();
  end if;

  return new;
end;
$$;

drop trigger if exists tasks_apply_column_automation on public.tasks;
create trigger tasks_apply_column_automation
before insert or update of column_id on public.tasks
for each row execute function public.apply_task_column_automation();

create or replace function public.log_task_automation_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.started_at is not null
     and (tg_op = 'INSERT' or old.started_at is null) then
    insert into public.task_activities (
      task_id, workspace_id, actor_id, action, details
    ) values (
      new.id,
      new.workspace_id,
      new.started_by,
      'work_started',
      jsonb_build_object('started_at', new.started_at, 'column_id', new.column_id)
    );
  end if;

  return new;
end;
$$;

drop trigger if exists tasks_log_automation_event on public.tasks;
create trigger tasks_log_automation_event
after insert or update on public.tasks
for each row execute function public.log_task_automation_event();

-- Keep the existing activity/assignment behavior while making movement
-- notifications obey the destination rules. A start column never pings the
-- assigned editor; review/delivery columns may explicitly ping admins.
create or replace function public.log_task_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  actor_name text;
  target_column_name text;
  target_registers_start boolean := false;
  target_notifies_admins boolean := false;
  actor_is_editor boolean;
begin
  select nullif(trim(profile.display_name), '')
  into actor_name
  from public.profiles as profile
  where profile.id = actor_id;

  actor_name := coalesce(actor_name, 'Um membro');
  actor_is_editor := public.has_workspace_role(
    new.workspace_id,
    array['editor']::public.workspace_role[]
  );

  if tg_op = 'INSERT' then
    insert into public.task_activities (task_id, workspace_id, actor_id, action, details)
    values (
      new.id,
      new.workspace_id,
      actor_id,
      'created',
      jsonb_build_object('title', new.title, 'column_id', new.column_id)
    );

    if new.assignee_id is not null and new.assignee_id is distinct from actor_id then
      insert into public.notifications (workspace_id, user_id, task_id, actor_id, type, message)
      values (
        new.workspace_id,
        new.assignee_id,
        new.id,
        actor_id,
        'assignment',
        'Você foi definido como responsável por “' || new.title || '”.'
      );
    end if;

    return new;
  end if;

  if old.column_id is distinct from new.column_id then
    insert into public.task_activities (task_id, workspace_id, actor_id, action, details)
    values (
      new.id,
      new.workspace_id,
      actor_id,
      'moved',
      jsonb_build_object('from_column_id', old.column_id, 'to_column_id', new.column_id)
    );

    select name, automation_register_start, automation_notify_admins
    into target_column_name, target_registers_start, target_notifies_admins
    from public.columns
    where id = new.column_id;

    if target_notifies_admins then
      perform public.notify_workspace_admins(
        new.workspace_id,
        new.id,
        actor_id,
        'task_moved',
        actor_name || ' moveu “' || new.title || '” para “'
          || coalesce(target_column_name, 'outra etapa') || '”.'
      );
    elsif not actor_is_editor
       and not target_registers_start
       and new.assignee_id is not null
       and new.assignee_id is distinct from actor_id then
      insert into public.notifications (workspace_id, user_id, task_id, actor_id, type, message)
      values (
        new.workspace_id,
        new.assignee_id,
        new.id,
        actor_id,
        'task_moved',
        '“' || new.title || '” foi movida para “'
          || coalesce(target_column_name, 'outra etapa') || '”.'
      );
    end if;
  end if;

  if old.assignee_id is distinct from new.assignee_id then
    insert into public.task_activities (task_id, workspace_id, actor_id, action, details)
    values (
      new.id,
      new.workspace_id,
      actor_id,
      'assigned',
      jsonb_build_object('from_user_id', old.assignee_id, 'to_user_id', new.assignee_id)
    );

    if new.assignee_id is not null and new.assignee_id is distinct from actor_id then
      insert into public.notifications (workspace_id, user_id, task_id, actor_id, type, message)
      values (
        new.workspace_id,
        new.assignee_id,
        new.id,
        actor_id,
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
      actor_id,
      'revision_changed',
      jsonb_build_object('from_revision', old.revision_round, 'to_revision', new.revision_round)
    );

    if actor_is_editor then
      perform public.notify_workspace_admins(
        new.workspace_id,
        new.id,
        actor_id,
        'task_updated',
        actor_name || ' atualizou “' || new.title || '” para a V' || new.revision_round || '.'
      );
    elsif new.assignee_id is not null and new.assignee_id is distinct from actor_id then
      insert into public.notifications (workspace_id, user_id, task_id, actor_id, type, message)
      values (
        new.workspace_id,
        new.assignee_id,
        new.id,
        actor_id,
        'task_updated',
        '“' || new.title || '” foi atualizada para a V' || new.revision_round || '.'
      );
    end if;
  end if;

  if row(old.title, old.description, old.priority, old.due_at, old.client_id)
     is distinct from
     row(new.title, new.description, new.priority, new.due_at, new.client_id) then
    insert into public.task_activities (task_id, workspace_id, actor_id, action, details)
    values (new.id, new.workspace_id, actor_id, 'updated', '{}'::jsonb);

    if new.assignee_id is not null
       and new.assignee_id is distinct from actor_id
       and old.assignee_id is not distinct from new.assignee_id then
      insert into public.notifications (workspace_id, user_id, task_id, actor_id, type, message)
      values (
        new.workspace_id,
        new.assignee_id,
        new.id,
        actor_id,
        'task_updated',
        'Os detalhes de “' || new.title || '” foram atualizados.'
      );
    end if;
  end if;

  return new;
end;
$$;

-- If an unfinished automatic earning is invalidated by reopening a task, undo
-- only that estimate. Confirmed receipts remain immutable financial history.
create or replace function public.reconcile_reopened_task_earning()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_event public.earning_events%rowtype;
  target_earning public.earnings%rowtype;
begin
  if old.completed_at is null or new.completed_at is not null then
    return new;
  end if;

  select * into target_event
  from public.earning_events
  where task_id = new.id
  for update;

  if target_event.id is null then return new; end if;

  if target_event.earning_id is null then
    delete from public.earning_events where id = target_event.id;
    return new;
  end if;

  select * into target_earning
  from public.earnings
  where id = target_event.earning_id
  for update;

  if target_earning.id is null or target_earning.status = 'received' then
    return new;
  end if;

  update public.earning_events
  set earning_id = null
  where earning_id = target_earning.id;

  delete from public.earning_events where id = target_event.id;
  delete from public.earnings
  where id = target_earning.id and status = 'pending' and source_type <> 'manual';

  perform public.process_client_earning_events(target_event.client_id);
  return new;
end;
$$;

drop trigger if exists tasks_reconcile_reopened_earning on public.tasks;
create trigger tasks_reconcile_reopened_earning
after update on public.tasks
for each row execute function public.reconcile_reopened_task_earning();

-- Store each inactivity episode once. A new task/link/comment update creates a
-- new activity timestamp and therefore permits a future alert if it stalls again.
create table public.task_automation_alerts (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  column_id uuid not null references public.columns(id) on delete cascade,
  activity_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (task_id, column_id, activity_at)
);

revoke all on table public.task_automation_alerts from public, anon, authenticated;

create or replace function public.process_workspace_automation_alerts(target_workspace uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate record;
  inserted_alerts integer := 0;
begin
  if auth.uid() is null or not public.is_workspace_member(target_workspace) then
    raise exception 'Acesso à equipe negado';
  end if;

  for candidate in
    select
      task_row.id as task_id,
      task_row.title,
      task_row.column_id,
      column_row.name as column_name,
      column_row.automation_inactivity_days,
      greatest(
        task_row.updated_at,
        coalesce((select max(link_row.created_at) from public.task_links as link_row where link_row.task_id = task_row.id), task_row.updated_at),
        coalesce((select max(comment_row.updated_at) from public.task_comments as comment_row where comment_row.task_id = task_row.id), task_row.updated_at)
      ) as activity_at
    from public.tasks as task_row
    join public.columns as column_row on column_row.id = task_row.column_id
    where task_row.workspace_id = target_workspace
      and task_row.completed_at is null
      and column_row.automation_inactivity_days is not null
  loop
    if candidate.activity_at <= now() - (candidate.automation_inactivity_days * interval '1 day') then
      insert into public.task_automation_alerts (task_id, column_id, activity_at)
      values (candidate.task_id, candidate.column_id, candidate.activity_at)
      on conflict do nothing;

      if found then
        inserted_alerts := inserted_alerts + 1;
        perform public.notify_workspace_admins(
          target_workspace,
          candidate.task_id,
          null,
          'automation_alert',
          '“' || candidate.title || '” está há ' || candidate.automation_inactivity_days
            || case when candidate.automation_inactivity_days = 1 then ' dia' else ' dias' end
            || ' sem atividade em “' || candidate.column_name || '”.'
        );
      end if;
    end if;
  end loop;

  return inserted_alerts;
end;
$$;

revoke all on function public.update_column_configuration(uuid, text, text, boolean, text, boolean, integer)
from public, anon, authenticated;
revoke all on function public.process_workspace_automation_alerts(uuid)
from public, anon, authenticated;
revoke all on function public.enforce_column_automation_owner() from public, anon, authenticated;
revoke all on function public.protect_task_work_start() from public, anon, authenticated;
revoke all on function public.apply_task_column_automation() from public, anon, authenticated;
revoke all on function public.log_task_automation_event() from public, anon, authenticated;
revoke all on function public.reconcile_reopened_task_earning() from public, anon, authenticated;

grant execute on function public.update_column_configuration(uuid, text, text, boolean, text, boolean, integer)
to authenticated;
grant execute on function public.process_workspace_automation_alerts(uuid)
to authenticated;
