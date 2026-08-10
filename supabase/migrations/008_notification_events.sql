-- Expand notifications so assignments made during task creation, workflow
-- changes, editor feedback, and accepted invitations reach the right people.

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
    'invite_accepted'
  )
);

create or replace function public.notify_workspace_admins(
  target_workspace uuid,
  target_task uuid,
  target_actor uuid,
  notification_type text,
  notification_message text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.notifications (
    workspace_id,
    user_id,
    task_id,
    actor_id,
    type,
    message
  )
  select
    target_workspace,
    membership.user_id,
    target_task,
    target_actor,
    notification_type,
    notification_message
  from public.workspace_members as membership
  where membership.workspace_id = target_workspace
    and membership.role in ('owner', 'admin')
    and membership.user_id is distinct from target_actor;
end;
$$;

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

    -- Previously this case returned before notifying the initial assignee.
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

    select column_row.name
    into target_column_name
    from public.columns as column_row
    where column_row.id = new.column_id;

    if actor_is_editor then
      perform public.notify_workspace_admins(
        new.workspace_id,
        new.id,
        actor_id,
        'task_moved',
        actor_name || ' moveu “' || new.title || '” para “' || coalesce(target_column_name, 'outra etapa') || '”.'
      );
    elsif new.assignee_id is not null and new.assignee_id is distinct from actor_id then
      insert into public.notifications (workspace_id, user_id, task_id, actor_id, type, message)
      values (
        new.workspace_id,
        new.assignee_id,
        new.id,
        actor_id,
        'task_moved',
        '“' || new.title || '” foi movida para “' || coalesce(target_column_name, 'outra etapa') || '”.'
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

create or replace function public.log_task_comment_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_task public.tasks%rowtype;
  author_name text;
  actor_name text;
  author_is_editor boolean;
begin
  select * into target_task
  from public.tasks
  where id = new.task_id;

  select nullif(trim(profile.display_name), '')
  into author_name
  from public.profiles as profile
  where profile.id = new.author_id;

  author_name := coalesce(author_name, 'Um membro');

  select nullif(trim(profile.display_name), '')
  into actor_name
  from public.profiles as profile
  where profile.id = auth.uid();

  actor_name := coalesce(actor_name, 'Um membro');
  author_is_editor := exists (
    select 1
    from public.workspace_members as membership
    where membership.workspace_id = new.workspace_id
      and membership.user_id = new.author_id
      and membership.role = 'editor'
  );

  if tg_op = 'INSERT' then
    insert into public.task_activities (task_id, workspace_id, actor_id, action, details)
    values (
      new.task_id,
      new.workspace_id,
      new.author_id,
      case when new.kind = 'change_request' then 'adjustment_requested' else 'comment_added' end,
      jsonb_build_object('comment_id', new.id, 'revision_round', new.revision_round)
    );

    if author_is_editor then
      perform public.notify_workspace_admins(
        new.workspace_id,
        new.task_id,
        new.author_id,
        new.kind,
        case
          when new.kind = 'change_request' then author_name || ' solicitou um ajuste em “' || target_task.title || '”.'
          else author_name || ' comentou em “' || target_task.title || '”.'
        end
      );
    elsif target_task.assignee_id is not null and target_task.assignee_id <> new.author_id then
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

    if public.has_workspace_role(
      new.workspace_id,
      array['editor']::public.workspace_role[]
    ) then
      perform public.notify_workspace_admins(
        new.workspace_id,
        new.task_id,
        auth.uid(),
        'task_updated',
        actor_name || case when new.is_resolved then ' resolveu' else ' reabriu' end
          || ' um feedback em “' || target_task.title || '”.'
      );
    end if;
  end if;

  return new;
end;
$$;

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
  actor_id uuid := auth.uid();
  actor_name text;
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
    actor_id,
    case when tg_op = 'DELETE' then 'link_removed' else 'link_added' end,
    jsonb_build_object('label', link_label, 'category', link_category)
  );

  if public.has_workspace_role(
    target_task.workspace_id,
    array['editor']::public.workspace_role[]
  ) then
    select nullif(trim(profile.display_name), '')
    into actor_name
    from public.profiles as profile
    where profile.id = actor_id;

    perform public.notify_workspace_admins(
      target_task.workspace_id,
      target_task.id,
      actor_id,
      'task_updated',
      coalesce(actor_name, 'Um editor')
        || case when tg_op = 'DELETE' then ' removeu um link de “' else ' adicionou um link em “' end
        || target_task.title || '”.'
    );
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.log_workspace_invitation_acceptance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status is distinct from 'accepted' and new.status = 'accepted' then
    perform public.notify_workspace_admins(
      new.workspace_id,
      null,
      new.invited_user_id,
      'invite_accepted',
      new.email || ' aceitou o convite para a equipe.'
    );
  end if;

  return new;
end;
$$;

drop trigger if exists workspace_invitations_log_acceptance on public.workspace_invitations;
create trigger workspace_invitations_log_acceptance
after update of status on public.workspace_invitations
for each row execute function public.log_workspace_invitation_acceptance();

revoke all on function public.notify_workspace_admins(uuid, uuid, uuid, text, text) from public, authenticated;
