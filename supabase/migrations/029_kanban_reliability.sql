-- Safe, single-card movement, durable completion, workflow signals and alerts.
-- Apply before using the updated desktop app. Old reorder clients are rejected
-- instead of letting a stale full-board snapshot overwrite other members.
begin;

alter table public.tasks add column if not exists blocked_reason text;
alter table public.tasks add constraint tasks_blocked_reason_check
  check (blocked_reason is null or char_length(trim(blocked_reason)) between 1 and 300);
alter table public.columns add column if not exists wip_limit smallint;
alter table public.columns add constraint columns_wip_limit_check
  check (wip_limit is null or wip_limit between 1 and 1000);

-- UPDATE OF completed_at misses completion changes made by BEFORE triggers.
drop trigger if exists tasks_record_editor_cost on public.tasks;
create trigger tasks_record_editor_cost after insert or update on public.tasks
for each row execute function public.record_task_editor_cost();

create or replace function public.move_task_safely(
  target_task uuid, target_column uuid, before_task uuid, expected_updated_at timestamptz
)
returns public.tasks language plpgsql security definer set search_path = '' as $$
declare
  task_row public.tasks%rowtype;
  anchor public.tasks%rowtype;
  target_board uuid;
  previous_position numeric;
  next_position numeric;
begin
  select board_id into target_board from public.tasks where id = target_task;
  if target_board is null or not public.can_access_task(target_task) then
    raise exception 'Tarefa não encontrada ou acesso negado';
  end if;
  -- All single-card moves in a board share this lock, including different users.
  perform 1 from public.boards where id = target_board for update;
  select * into task_row from public.tasks where id = target_task for update;
  if not public.can_access_task(target_task) then raise exception 'Acesso à tarefa negado'; end if;
  if task_row.archived_at is not null then raise exception 'Restaure a tarefa antes de movê-la'; end if;
  if expected_updated_at is null or task_row.updated_at is distinct from expected_updated_at then
    raise exception 'Esta tarefa mudou em outra sessão. Atualize o quadro e tente novamente.';
  end if;
  if not exists (select 1 from public.columns where id = target_column and board_id = target_board) then
    raise exception 'A coluna não pertence a este quadro';
  end if;
  if before_task = target_task then return task_row; end if;
  if before_task is not null then
    select * into anchor from public.tasks
    where id = before_task and board_id = target_board and column_id = target_column and archived_at is null;
    if anchor.id is null then raise exception 'A posição de destino mudou. Atualize o quadro.'; end if;
    select max(position) into previous_position from public.tasks
    where column_id = target_column and archived_at is null and id <> target_task and position < anchor.position;
    next_position := (coalesce(previous_position, anchor.position - 2000) + anchor.position) / 2;
  else
    select coalesce(max(position), 0) + 1000 into next_position from public.tasks
    where column_id = target_column and archived_at is null and id <> target_task;
  end if;
  update public.tasks set column_id = target_column, position = next_position
  where id = target_task returning * into task_row;
  return task_row;
end;
$$;

create or replace function public.reorder_tasks(target_board uuid, ordered_items jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'Atualize o EditFlow para mover tarefas com segurança.';
end;
$$;

-- New columns belong before the existing final column. Renaming remains free.
create or replace function public.position_new_workflow_column()
returns trigger language plpgsql security definer set search_path = '' as $$
declare final_position numeric; previous_position numeric;
begin
  perform 1 from public.boards where id = new.board_id for update;
  select position into final_position from public.columns where board_id = new.board_id and is_completion limit 1;
  if final_position is not null then
    select max(position) into previous_position from public.columns
    where board_id = new.board_id and not is_completion;
    new.position := (coalesce(previous_position, final_position - 2000) + final_position) / 2;
    new.is_completion := false;
  end if;
  return new;
end;
$$;
-- Replace name inference: only the last column of a new board is completion.
create or replace function public.infer_completion_column()
returns trigger language plpgsql security definer set search_path = '' as $$
begin return new; end;
$$;
create trigger columns_position_new_workflow before insert on public.columns
for each row execute function public.position_new_workflow_column();

create or replace function public.sync_board_completion_columns()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Never reopen existing tasks merely because the board layout changed.
  if exists (
    select 1 from public.columns c where c.is_completion and c.id is distinct from (
      select id from public.columns where board_id = c.board_id order by position desc, id desc limit 1
    )
  ) then raise exception 'Mantenha a coluna de finalizados na última posição.'; end if;
  update public.columns c set is_completion = true
  where not exists (select 1 from public.columns f where f.board_id = c.board_id and f.is_completion)
    and c.id = (select id from public.columns where board_id = c.board_id order by position desc, id desc limit 1);
  return null;
end;
$$;

create or replace function public.protect_completion_column()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Permit cascading removal of the board/workspace itself.
  if not exists (select 1 from public.boards where id = old.board_id) then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' and old.is_completion then
    raise exception 'A coluna final é preservada para proteger o histórico. Você pode renomeá-la.';
  end if;
  if tg_op = 'UPDATE' and (old.is_completion and not new.is_completion
    or old.board_id is distinct from new.board_id) then
    raise exception 'A coluna final e o quadro de origem não podem ser alterados.';
  end if;
  if tg_op = 'UPDATE' and not old.is_completion and new.is_completion
     and exists (select 1 from public.columns where board_id=new.board_id and is_completion and id<>new.id) then
    raise exception 'O quadro já possui uma coluna final; ela é preservada para proteger o histórico.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger columns_protect_completion before update of is_completion, board_id or delete on public.columns
for each row execute function public.protect_completion_column();

-- Persist activity independently from layout-only updates (including old clients).
alter table public.tasks add column if not exists activity_at timestamptz not null default now();
update public.tasks set activity_at = updated_at;
create or replace function public.track_task_real_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then new.activity_at := now();
  elsif row(new.column_id,new.title,new.description,new.priority,new.due_at,new.assignee_id,new.client_id,new.revision_round,new.blocked_reason)
    is distinct from row(old.column_id,old.title,old.description,old.priority,old.due_at,old.assignee_id,old.client_id,old.revision_round,old.blocked_reason) then
    new.activity_at := now();
  else new.activity_at := old.activity_at;
  end if;
  return new;
end;
$$;
create trigger tasks_track_real_activity before insert or update on public.tasks
for each row execute function public.track_task_real_activity();

create or replace function public.protect_financial_task_deletion()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.boards where id = old.board_id)
     and (exists (select 1 from public.earning_events where task_id = old.id)
       or exists (select 1 from public.editor_cost_entries where task_id = old.id)) then
    raise exception 'Esta tarefa possui histórico financeiro. Arquive-a em vez de excluí-la.';
  end if;
  return old;
end;
$$;
create trigger tasks_protect_financial_delete before delete on public.tasks
for each row execute function public.protect_financial_task_deletion();

-- Duplicate is atomic and deliberately does not copy dates, status or history.
create or replace function public.duplicate_task(target_task uuid, copy_links boolean default false)
returns public.tasks language plpgsql security definer set search_path = '' as $$
declare original public.tasks%rowtype; duplicate public.tasks%rowtype; first_column uuid; next_position numeric;
begin
  select * into original from public.tasks where id = target_task;
  if original.id is null or not public.has_workspace_role(original.workspace_id, array['owner','admin']::public.workspace_role[]) then
    raise exception 'Somente administradores podem duplicar tarefas';
  end if;
  perform 1 from public.boards where id = original.board_id for update;
  select id into first_column from public.columns where board_id = original.board_id and not is_completion order by position,id limit 1;
  if first_column is null then raise exception 'Crie uma etapa antes de Finalizados para duplicar tarefas.'; end if;
  select coalesce(max(position),0)+1000 into next_position from public.tasks where column_id = first_column and archived_at is null;
  insert into public.tasks(workspace_id,board_id,column_id,client_id,assignee_id,title,description,priority,position,created_by)
  values(original.workspace_id,original.board_id,first_column,original.client_id,original.assignee_id,
    left(original.title,172)||' (cópia)',original.description,original.priority,next_position,auth.uid()) returning * into duplicate;
  if copy_links then
    insert into public.task_links(task_id,label,url,category,created_by)
    select duplicate.id,label,url,category,auth.uid() from public.task_links where task_id = original.id;
  end if;
  return duplicate;
end;
$$;

create or replace function public.set_column_wip_limit(target_column uuid, task_limit integer)
returns void language plpgsql security definer set search_path = '' as $$
declare target_workspace uuid;
begin
  select b.workspace_id into target_workspace from public.columns c join public.boards b on b.id=c.board_id where c.id=target_column;
  if not public.has_workspace_role(target_workspace,array['owner']::public.workspace_role[]) then
    raise exception 'Somente o proprietário pode configurar o limite de tarefas';
  end if;
  if task_limit is not null and task_limit not between 1 and 1000 then raise exception 'Use um limite entre 1 e 1000'; end if;
  update public.columns set wip_limit=task_limit where id=target_column;
end;
$$;
create or replace function public.protect_column_wip_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare target_workspace uuid;
begin
  if (tg_op='INSERT' and new.wip_limit is not null) or (tg_op='UPDATE' and new.wip_limit is distinct from old.wip_limit) then
    select workspace_id into target_workspace from public.boards where id=new.board_id;
    if not public.has_workspace_role(target_workspace,array['owner']::public.workspace_role[]) then
      raise exception 'Somente o proprietário pode configurar o limite de tarefas';
    end if;
  end if;
  return new;
end;
$$;
create trigger columns_protect_wip before insert or update of wip_limit on public.columns
for each row execute function public.protect_column_wip_limit();

create or replace function public.update_column_configuration_v2(
  target_column uuid, column_name text, column_color text, register_work_start boolean,
  required_link_category text, notify_admins_on_entry boolean, inactivity_days integer, task_limit integer
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.update_column_configuration(target_column,column_name,column_color,register_work_start,required_link_category,notify_admins_on_entry,inactivity_days);
  if exists(select 1 from public.columns where id=target_column and wip_limit is distinct from task_limit) then
    perform public.set_column_wip_limit(target_column,task_limit);
  end if;
end;
$$;

create or replace function public.restore_completed_task(target_task uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare archived public.tasks%rowtype; final_column uuid;
begin
  select * into archived from public.tasks where id=target_task and archived_at is not null for update;
  if archived.id is null or not public.has_workspace_role(archived.workspace_id,array['owner','admin']::public.workspace_role[]) then
    raise exception 'Tarefa arquivada não encontrada ou acesso negado';
  end if;
  select id into final_column from public.columns where board_id=archived.board_id and is_completion;
  if final_column is null then raise exception 'Coluna final não encontrada'; end if;
  update public.tasks set archived_at=null,archived_by=null where id=target_task;
  -- Also recovers archived tasks affected by layout changes in older versions.
  if archived.column_id is distinct from final_column then
    update public.tasks set column_id=final_column,completed_at=coalesce(archived.completed_at,archived.archived_at) where id=target_task;
  end if;
  insert into public.task_activities(task_id,workspace_id,actor_id,action,details)
  values(target_task,archived.workspace_id,auth.uid(),'restored',jsonb_build_object('column_id',final_column));
end;
$$;

create or replace function public.log_task_block_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.blocked_reason is distinct from old.blocked_reason then
    insert into public.task_activities(task_id,workspace_id,actor_id,action,details)
    values(new.id,new.workspace_id,auth.uid(),'updated',jsonb_build_object('blocked_reason',new.blocked_reason,'block_changed',true));
  end if;
  return new;
end;
$$;
create trigger tasks_log_block_change after update of blocked_reason on public.tasks
for each row execute function public.log_task_block_change();

-- Internal worker is available only to the scheduler/database owner, not REST.
create or replace function public.run_workspace_automation_alerts(target_workspace uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare candidate record; inserted_alerts integer := 0;
begin
  for candidate in
    select t.id as task_id,t.title,t.column_id,c.name as column_name,c.automation_inactivity_days,
      greatest(t.activity_at,
        coalesce((select max(created_at) from public.task_activities where task_id=t.id and action in ('link_added','link_removed','comment_added','adjustment_requested','comment_resolved','comment_reopened')),t.activity_at)
      ) as activity_at
    from public.tasks t join public.columns c on c.id=t.column_id
    where t.workspace_id=target_workspace and t.completed_at is null and t.archived_at is null and c.automation_inactivity_days is not null
  loop
    if candidate.activity_at <= now() - candidate.automation_inactivity_days * interval '1 day' then
      insert into public.task_automation_alerts(task_id,column_id,activity_at)
      values(candidate.task_id,candidate.column_id,candidate.activity_at) on conflict do nothing;
      if found then
        inserted_alerts := inserted_alerts+1;
        perform public.notify_workspace_admins(target_workspace,candidate.task_id,null,'automation_alert',
          '“'||candidate.title||'” está há '||candidate.automation_inactivity_days||' dia(s) sem atividade em “'||candidate.column_name||'”.');
      end if;
    end if;
  end loop;
  return inserted_alerts;
end;
$$;
create or replace function public.process_workspace_automation_alerts(target_workspace uuid)
returns integer language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.is_workspace_member(target_workspace) then raise exception 'Acesso à equipe negado'; end if;
  return public.run_workspace_automation_alerts(target_workspace);
end;
$$;
create or replace function public.run_all_board_automation_alerts()
returns void language plpgsql security definer set search_path = '' as $$
declare workspace_id uuid;
begin
  for workspace_id in select distinct b.workspace_id from public.boards b join public.columns c on c.board_id=b.id where c.automation_inactivity_days is not null loop
    perform public.run_workspace_automation_alerts(workspace_id);
  end loop;
end;
$$;

revoke all on function public.move_task_safely(uuid,uuid,uuid,timestamptz) from public,anon,authenticated;
revoke all on function public.duplicate_task(uuid,boolean) from public,anon,authenticated;
revoke all on function public.set_column_wip_limit(uuid,integer) from public,anon,authenticated;
grant execute on function public.move_task_safely(uuid,uuid,uuid,timestamptz) to authenticated;
grant execute on function public.duplicate_task(uuid,boolean) to authenticated;
grant execute on function public.set_column_wip_limit(uuid,integer) to authenticated;
revoke all on function public.update_column_configuration_v2(uuid,text,text,boolean,text,boolean,integer,integer) from public,anon,authenticated;
grant execute on function public.update_column_configuration_v2(uuid,text,text,boolean,text,boolean,integer,integer) to authenticated;
revoke all on function public.log_task_block_change() from public,anon,authenticated;
revoke all on function public.position_new_workflow_column() from public,anon,authenticated;
revoke all on function public.protect_completion_column() from public,anon,authenticated;
revoke all on function public.track_task_real_activity() from public,anon,authenticated;
revoke all on function public.protect_financial_task_deletion() from public,anon,authenticated;
revoke all on function public.protect_column_wip_limit() from public,anon,authenticated;
revoke all on function public.run_workspace_automation_alerts(uuid) from public,anon,authenticated;
revoke all on function public.run_all_board_automation_alerts() from public,anon,authenticated;

commit;
