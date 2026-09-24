-- First delivery, independent of completion and earnings. No inferred backfill:
-- existing cards receive a delivery stamp only on their next real entry.
begin;

alter table public.columns add column automation_client_review boolean not null default false;
alter table public.columns add constraint columns_review_not_completion
  check (not (automation_client_review and is_completion));
alter table public.tasks
  add column first_sent_at timestamptz,
  add column first_sent_due_at timestamptz,
  add column first_sent_late boolean;

create function public.protect_column_client_review()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (tg_op = 'INSERT' and new.automation_client_review)
     or (tg_op = 'UPDATE' and new.automation_client_review is distinct from old.automation_client_review) then
    if not public.has_workspace_role(
      (select workspace_id from public.boards where id = new.board_id),
      array['owner']::public.workspace_role[]
    ) then
      raise exception 'Somente o proprietário pode configurar o envio ao cliente';
    end if;
  end if;
  return new;
end;
$$;
create trigger columns_protect_client_review before insert or update on public.columns
for each row execute function public.protect_column_client_review();

create function public.update_column_configuration_v3(
  target_column uuid, column_name text, column_color text, register_work_start boolean,
  required_link_category text, notify_admins_on_entry boolean, inactivity_days integer,
  task_limit integer, client_review boolean
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.update_column_configuration_v2(target_column,column_name,column_color,
    register_work_start,required_link_category,notify_admins_on_entry,inactivity_days,task_limit);
  update public.columns set automation_client_review = coalesce(client_review,false)
  where id = target_column and automation_client_review is distinct from coalesce(client_review,false);
end;
$$;

-- A single trigger both protects and stamps the snapshot. Later edits, returns
-- to editing, and re-sends never change the first delivery or its original due date.
create function public.stamp_task_client_delivery()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.first_sent_at is not null or new.first_sent_due_at is not null or new.first_sent_late is not null then
      raise exception 'O envio ao cliente é registrado automaticamente';
    end if;
  else
    if row(new.first_sent_at,new.first_sent_due_at,new.first_sent_late)
      is distinct from row(old.first_sent_at,old.first_sent_due_at,old.first_sent_late) then
      raise exception 'O primeiro envio ao cliente não pode ser alterado';
    end if;
    if old.column_id is not distinct from new.column_id then return new; end if;
  end if;

  if new.first_sent_at is null and exists (
    select 1 from public.columns where id = new.column_id and board_id = new.board_id
      and automation_client_review and not is_completion
  ) then
    new.first_sent_at := now();
    new.first_sent_due_at := new.due_at;
    -- Deadlines in this app are whole days, not noon cutoffs. Evaluate once in
    -- the product's Brazilian timezone; viewing from another timezone is stable.
    new.first_sent_late := case when new.due_at is null then null else
      (new.first_sent_at at time zone 'America/Sao_Paulo')::date
        > (new.due_at at time zone 'America/Sao_Paulo')::date end;
  end if;
  return new;
end;
$$;
create trigger tasks_stamp_client_delivery before insert or update on public.tasks
for each row execute function public.stamp_task_client_delivery();

create function public.log_task_client_delivery()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and old.column_id is not distinct from new.column_id then return new; end if;
  if exists (select 1 from public.columns where id = new.column_id and automation_client_review) then
    insert into public.task_activities(task_id,workspace_id,actor_id,action,details)
    values(new.id,new.workspace_id,auth.uid(),'updated',jsonb_build_object(
      'client_submission',true,'first_submission',tg_op = 'INSERT' or old.first_sent_at is null,
      'sent_at',now(),'first_sent_at',new.first_sent_at,'first_sent_due_at',new.first_sent_due_at,
      'first_sent_late',new.first_sent_late,'column_id',new.column_id));
  end if;
  return new;
end;
$$;
create trigger tasks_log_client_delivery after insert or update on public.tasks
for each row execute function public.log_task_client_delivery();

revoke all on function public.protect_column_client_review() from public,anon,authenticated;
revoke all on function public.stamp_task_client_delivery() from public,anon,authenticated;
revoke all on function public.log_task_client_delivery() from public,anon,authenticated;
revoke all on function public.update_column_configuration_v3(uuid,text,text,boolean,text,boolean,integer,integer,boolean) from public,anon,authenticated;
grant execute on function public.update_column_configuration_v3(uuid,text,text,boolean,text,boolean,integer,integer,boolean) to authenticated;
commit;
