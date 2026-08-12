-- Treat the last board column as completion and expose controlled RPCs for
-- workspace-wide synchronization and owner-managed manual earnings.

create or replace function public.sync_board_completion_columns()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.columns as column_row
  set is_completion = (
    column_row.id = (
      select last_column.id
      from public.columns as last_column
      where last_column.board_id = column_row.board_id
      order by last_column.position desc, last_column.id desc
      limit 1
    )
  )
  where column_row.is_completion is distinct from (
    column_row.id = (
      select last_column.id
      from public.columns as last_column
      where last_column.board_id = column_row.board_id
      order by last_column.position desc, last_column.id desc
      limit 1
    )
  );

  update public.tasks as task_row
  set completed_at = null
  from public.columns as column_row
  where column_row.id = task_row.column_id
    and not column_row.is_completion
    and task_row.completed_at is not null;

  return null;
end;
$$;

drop trigger if exists columns_sync_completion_after_insert_delete on public.columns;
create trigger columns_sync_completion_after_insert_delete
after insert or delete on public.columns
for each statement execute function public.sync_board_completion_columns();

drop trigger if exists columns_sync_completion_after_reorder on public.columns;
create trigger columns_sync_completion_after_reorder
after update of position on public.columns
for each statement execute function public.sync_board_completion_columns();

-- Initialize every existing board before relying on the automatic triggers.
update public.columns as column_row
set is_completion = (
  column_row.id = (
    select last_column.id
    from public.columns as last_column
    where last_column.board_id = column_row.board_id
    order by last_column.position desc, last_column.id desc
    limit 1
  )
)
where column_row.is_completion is distinct from (
  column_row.id = (
    select last_column.id
    from public.columns as last_column
    where last_column.board_id = column_row.board_id
    order by last_column.position desc, last_column.id desc
    limit 1
  )
);

create or replace function public.stamp_task_completion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  completes_work boolean;
begin
  select is_completion into completes_work
  from public.columns
  where id = new.column_id;

  if coalesce(completes_work, false) then
    new.completed_at := coalesce(new.completed_at, now());
  elsif tg_op = 'UPDATE' and old.column_id is distinct from new.column_id then
    -- Reopened work becomes active again. Existing financial history is kept,
    -- and earning_events.task_id prevents a duplicate when it is delivered again.
    new.completed_at := null;
  end if;

  return new;
end;
$$;

create or replace function public.sync_workspace_earnings(target_workspace uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  billing_row record;
  earnings_before integer;
  earnings_after integer;
begin
  if not public.has_workspace_role(
    target_workspace,
    array['owner']::public.workspace_role[]
  ) then
    raise exception 'Only the workspace owner can synchronize earnings';
  end if;

  select count(*) into earnings_before
  from public.earnings
  where workspace_id = target_workspace;

  for billing_row in
    select client_id
    from public.client_billing_settings
    where workspace_id = target_workspace
  loop
    perform public.sync_client_earnings(billing_row.client_id);
  end loop;

  select count(*) into earnings_after
  from public.earnings
  where workspace_id = target_workspace;

  return earnings_after - earnings_before;
end;
$$;

create or replace function public.create_manual_earning(
  workspace_target uuid,
  client_target uuid,
  earning_description text,
  gross_amount_usd numeric,
  earning_date timestamptz,
  earning_payment_method text,
  earning_fee_percent numeric,
  earning_fee_fixed_usd numeric,
  earning_conversion_spread_percent numeric,
  mark_as_received boolean default false,
  actual_amount_brl numeric default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_earning_id uuid;
  calculated_net_usd numeric;
begin
  if not public.has_workspace_role(
    workspace_target,
    array['owner']::public.workspace_role[]
  ) then
    raise exception 'Only the workspace owner can create manual earnings';
  end if;

  if client_target is not null and not exists (
    select 1 from public.clients
    where id = client_target and workspace_id = workspace_target
  ) then
    raise exception 'The client does not belong to this workspace';
  end if;

  if earning_description is null
     or char_length(trim(earning_description)) < 1
     or char_length(trim(earning_description)) > 300 then
    raise exception 'The description must have between 1 and 300 characters';
  end if;
  if gross_amount_usd is null or gross_amount_usd <= 0 then
    raise exception 'The gross amount must be greater than zero';
  end if;
  if coalesce(earning_payment_method, '') not in ('none', 'paypal_international', 'wise_ach', 'wise_wire', 'custom') then
    raise exception 'Invalid payment method';
  end if;
  if coalesce(earning_fee_percent, -1) not between 0 and 100
     or coalesce(earning_fee_fixed_usd, -1) < 0
     or coalesce(earning_conversion_spread_percent, -1) not between 0 and 100 then
    raise exception 'Invalid payment fee configuration';
  end if;
  if mark_as_received and (actual_amount_brl is null or actual_amount_brl <= 0) then
    raise exception 'The actual BRL amount is required for a received earning';
  end if;

  calculated_net_usd := public.calculate_net_usd(
    gross_amount_usd,
    earning_fee_percent,
    earning_fee_fixed_usd,
    earning_conversion_spread_percent
  );
  if mark_as_received and calculated_net_usd <= 0 then
    raise exception 'The net amount must be greater than zero when received';
  end if;

  insert into public.earnings (
    workspace_id,
    client_id,
    source_type,
    description,
    item_count,
    amount_usd,
    net_amount_usd,
    payment_method,
    fee_percent,
    fee_fixed_usd,
    conversion_spread_percent,
    status,
    earned_at,
    received_at,
    exchange_rate_brl,
    amount_brl
  ) values (
    workspace_target,
    client_target,
    'manual',
    trim(earning_description),
    1,
    round(gross_amount_usd, 2),
    calculated_net_usd,
    earning_payment_method,
    earning_fee_percent,
    earning_fee_fixed_usd,
    earning_conversion_spread_percent,
    case when mark_as_received then 'received' else 'pending' end,
    coalesce(earning_date, now()),
    case when mark_as_received then now() else null end,
    case
      when mark_as_received and calculated_net_usd > 0
        then round(actual_amount_brl / calculated_net_usd, 6)
      else null
    end,
    case when mark_as_received then round(actual_amount_brl, 2) else null end
  ) returning id into new_earning_id;

  return new_earning_id;
end;
$$;

create or replace function public.update_manual_earning(
  earning_target uuid,
  client_target uuid,
  earning_description text,
  gross_amount_usd numeric,
  earning_date timestamptz,
  earning_payment_method text,
  earning_fee_percent numeric,
  earning_fee_fixed_usd numeric,
  earning_conversion_spread_percent numeric,
  mark_as_received boolean,
  actual_amount_brl numeric default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_workspace uuid;
  calculated_net_usd numeric;
begin
  select workspace_id into target_workspace
  from public.earnings
  where id = earning_target and source_type = 'manual';

  if target_workspace is null or not public.has_workspace_role(
    target_workspace,
    array['owner']::public.workspace_role[]
  ) then
    raise exception 'Manual earning not found or access denied';
  end if;

  if client_target is not null and not exists (
    select 1 from public.clients
    where id = client_target and workspace_id = target_workspace
  ) then
    raise exception 'The client does not belong to this workspace';
  end if;
  if earning_description is null
     or char_length(trim(earning_description)) < 1
     or char_length(trim(earning_description)) > 300 then
    raise exception 'The description must have between 1 and 300 characters';
  end if;
  if gross_amount_usd is null or gross_amount_usd <= 0 then
    raise exception 'The gross amount must be greater than zero';
  end if;
  if coalesce(earning_payment_method, '') not in ('none', 'paypal_international', 'wise_ach', 'wise_wire', 'custom') then
    raise exception 'Invalid payment method';
  end if;
  if coalesce(earning_fee_percent, -1) not between 0 and 100
     or coalesce(earning_fee_fixed_usd, -1) < 0
     or coalesce(earning_conversion_spread_percent, -1) not between 0 and 100 then
    raise exception 'Invalid payment fee configuration';
  end if;
  if mark_as_received and (actual_amount_brl is null or actual_amount_brl <= 0) then
    raise exception 'The actual BRL amount is required for a received earning';
  end if;

  calculated_net_usd := public.calculate_net_usd(
    gross_amount_usd,
    earning_fee_percent,
    earning_fee_fixed_usd,
    earning_conversion_spread_percent
  );
  if mark_as_received and calculated_net_usd <= 0 then
    raise exception 'The net amount must be greater than zero when received';
  end if;

  update public.earnings
  set client_id = client_target,
      description = trim(earning_description),
      amount_usd = round(gross_amount_usd, 2),
      net_amount_usd = calculated_net_usd,
      payment_method = earning_payment_method,
      fee_percent = earning_fee_percent,
      fee_fixed_usd = earning_fee_fixed_usd,
      conversion_spread_percent = earning_conversion_spread_percent,
      status = case when mark_as_received then 'received' else 'pending' end,
      earned_at = coalesce(earning_date, earned_at),
      received_at = case when mark_as_received then coalesce(received_at, now()) else null end,
      exchange_rate_brl = case
        when mark_as_received and calculated_net_usd > 0
          then round(actual_amount_brl / calculated_net_usd, 6)
        else null
      end,
      amount_brl = case when mark_as_received then round(actual_amount_brl, 2) else null end
  where id = earning_target and source_type = 'manual';
end;
$$;

create or replace function public.delete_manual_earning(earning_target uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_workspace uuid;
begin
  select workspace_id into target_workspace
  from public.earnings
  where id = earning_target and source_type = 'manual';

  if target_workspace is null or not public.has_workspace_role(
    target_workspace,
    array['owner']::public.workspace_role[]
  ) then
    raise exception 'Manual earning not found or access denied';
  end if;

  delete from public.earnings
  where id = earning_target and source_type = 'manual';
end;
$$;

revoke all on function public.sync_board_completion_columns() from public, authenticated;
revoke all on function public.sync_workspace_earnings(uuid) from public;
revoke all on function public.create_manual_earning(uuid, uuid, text, numeric, timestamptz, text, numeric, numeric, numeric, boolean, numeric) from public;
revoke all on function public.update_manual_earning(uuid, uuid, text, numeric, timestamptz, text, numeric, numeric, numeric, boolean, numeric) from public;
revoke all on function public.delete_manual_earning(uuid) from public;

grant execute on function public.sync_workspace_earnings(uuid) to authenticated;
grant execute on function public.create_manual_earning(uuid, uuid, text, numeric, timestamptz, text, numeric, numeric, numeric, boolean, numeric) to authenticated;
grant execute on function public.update_manual_earning(uuid, uuid, text, numeric, timestamptz, text, numeric, numeric, numeric, boolean, numeric) to authenticated;
grant execute on function public.delete_manual_earning(uuid) to authenticated;
