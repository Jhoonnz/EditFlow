-- Support client billing and earnings in either USD or BRL. Legacy monetary
-- columns keep their names for backwards compatibility, but now store values
-- in the row's declared currency.

alter table public.client_billing_settings
drop constraint if exists client_billing_settings_currency_check;

alter table public.client_billing_settings
add constraint client_billing_settings_currency_check
check (currency in ('USD', 'BRL'));

alter table public.earnings
add column if not exists currency text not null default 'USD';

alter table public.earnings
drop constraint if exists earnings_currency_check;

alter table public.earnings
add constraint earnings_currency_check
check (currency in ('USD', 'BRL'));

alter table public.earning_events
add column if not exists currency text not null default 'USD';

alter table public.earning_events
drop constraint if exists earning_events_currency_check;

alter table public.earning_events
add constraint earning_events_currency_check
check (currency in ('USD', 'BRL'));

create or replace function public.process_client_earning_events(target_client uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  pricing_group record;
  required_items integer;
  selected_event_ids uuid[];
  selected_count integer;
  generated_earning_id uuid;
  generated_at timestamptz;
begin
  for pricing_group in
    select distinct
      pricing_model,
      currency,
      amount_usd,
      bundle_size,
      payment_method,
      fee_percent,
      fee_fixed_usd,
      conversion_spread_percent
    from public.earning_events
    where client_id = target_client and earning_id is null
  loop
    required_items := case
      when pricing_group.pricing_model = 'per_video' then 1
      else pricing_group.bundle_size
    end;

    loop
      select array_agg(selected.id order by selected.completed_at),
             count(*),
             max(selected.completed_at)
      into selected_event_ids, selected_count, generated_at
      from (
        select id, completed_at
        from public.earning_events
        where client_id = target_client
          and earning_id is null
          and pricing_model = pricing_group.pricing_model
          and currency = pricing_group.currency
          and amount_usd = pricing_group.amount_usd
          and bundle_size = pricing_group.bundle_size
          and payment_method = pricing_group.payment_method
          and fee_percent = pricing_group.fee_percent
          and fee_fixed_usd = pricing_group.fee_fixed_usd
          and conversion_spread_percent = pricing_group.conversion_spread_percent
        order by completed_at, id
        limit required_items
        for update skip locked
      ) as selected;

      exit when selected_count < required_items;

      insert into public.earnings (
        workspace_id,
        client_id,
        source_type,
        description,
        item_count,
        currency,
        amount_usd,
        net_amount_usd,
        payment_method,
        fee_percent,
        fee_fixed_usd,
        conversion_spread_percent,
        earned_at
      )
      select
        event_row.workspace_id,
        target_client,
        pricing_group.pricing_model,
        case
          when pricing_group.pricing_model = 'per_video' then event_row.task_title
          else 'Pacote de ' || required_items || ' vídeos'
        end,
        required_items,
        pricing_group.currency,
        pricing_group.amount_usd,
        public.calculate_net_usd(
          pricing_group.amount_usd,
          pricing_group.fee_percent,
          pricing_group.fee_fixed_usd,
          pricing_group.conversion_spread_percent
        ),
        pricing_group.payment_method,
        pricing_group.fee_percent,
        pricing_group.fee_fixed_usd,
        pricing_group.conversion_spread_percent,
        generated_at
      from public.earning_events as event_row
      where event_row.id = selected_event_ids[1]
      returning id into generated_earning_id;

      update public.earning_events
      set earning_id = generated_earning_id
      where id = any(selected_event_ids);
    end loop;
  end loop;
end;
$$;

create or replace function public.record_task_earning()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  billing public.client_billing_settings%rowtype;
begin
  if new.completed_at is null or new.client_id is null then return new; end if;
  if tg_op = 'UPDATE' and old.completed_at is not distinct from new.completed_at then return new; end if;

  select * into billing
  from public.client_billing_settings
  where client_id = new.client_id and workspace_id = new.workspace_id;

  if billing.client_id is null then return new; end if;

  insert into public.earning_events (
    workspace_id,
    client_id,
    task_id,
    task_title,
    completed_at,
    pricing_model,
    currency,
    amount_usd,
    bundle_size,
    payment_method,
    fee_percent,
    fee_fixed_usd,
    conversion_spread_percent
  ) values (
    new.workspace_id,
    new.client_id,
    new.id,
    new.title,
    new.completed_at,
    billing.pricing_model,
    billing.currency,
    billing.amount_usd,
    billing.bundle_size,
    billing.payment_method,
    billing.fee_percent,
    billing.fee_fixed_usd,
    billing.conversion_spread_percent
  ) on conflict (task_id) do nothing;

  perform public.process_client_earning_events(new.client_id);
  return new;
end;
$$;

create or replace function public.sync_client_earnings(target_client uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_workspace uuid;
  billing public.client_billing_settings%rowtype;
begin
  select workspace_id into target_workspace from public.clients where id = target_client;

  if target_workspace is null or not public.has_workspace_role(
    target_workspace,
    array['owner']::public.workspace_role[]
  ) then
    raise exception 'Only the workspace owner can manage earnings';
  end if;

  select * into billing
  from public.client_billing_settings
  where client_id = target_client and workspace_id = target_workspace;

  if billing.client_id is null then
    raise exception 'Configure client billing before synchronizing earnings';
  end if;

  -- Pending automatic estimates adopt the current client rule. Confirmed
  -- receipts and manual entries keep the currency originally registered.
  update public.earnings
  set
    currency = billing.currency,
    amount_usd = billing.amount_usd,
    payment_method = billing.payment_method,
    fee_percent = billing.fee_percent,
    fee_fixed_usd = billing.fee_fixed_usd,
    conversion_spread_percent = billing.conversion_spread_percent,
    net_amount_usd = public.calculate_net_usd(
      billing.amount_usd,
      billing.fee_percent,
      billing.fee_fixed_usd,
      billing.conversion_spread_percent
    )
  where client_id = target_client
    and status = 'pending'
    and source_type <> 'manual';

  update public.earning_events
  set
    currency = billing.currency,
    amount_usd = billing.amount_usd,
    bundle_size = billing.bundle_size,
    payment_method = billing.payment_method,
    fee_percent = billing.fee_percent,
    fee_fixed_usd = billing.fee_fixed_usd,
    conversion_spread_percent = billing.conversion_spread_percent
  where client_id = target_client and earning_id is null;

  update public.tasks as task_row
  set completed_at = coalesce(task_row.completed_at, task_row.updated_at)
  from public.columns as column_row
  where task_row.client_id = target_client
    and column_row.id = task_row.column_id
    and column_row.is_completion
    and task_row.completed_at is null;

  insert into public.earning_events (
    workspace_id,
    client_id,
    task_id,
    task_title,
    completed_at,
    pricing_model,
    currency,
    amount_usd,
    bundle_size,
    payment_method,
    fee_percent,
    fee_fixed_usd,
    conversion_spread_percent
  )
  select
    task_row.workspace_id,
    target_client,
    task_row.id,
    task_row.title,
    task_row.completed_at,
    billing.pricing_model,
    billing.currency,
    billing.amount_usd,
    billing.bundle_size,
    billing.payment_method,
    billing.fee_percent,
    billing.fee_fixed_usd,
    billing.conversion_spread_percent
  from public.tasks as task_row
  where task_row.client_id = target_client
    and task_row.completed_at is not null
  on conflict (task_id) do nothing;

  perform public.process_client_earning_events(target_client);
end;
$$;

drop function if exists public.create_manual_earning(
  uuid, uuid, text, numeric, timestamptz, text, numeric, numeric, numeric, boolean, numeric
);

drop function if exists public.update_manual_earning(
  uuid, uuid, text, numeric, timestamptz, text, numeric, numeric, numeric, boolean, numeric
);

create function public.create_manual_earning(
  workspace_target uuid,
  client_target uuid,
  earning_description text,
  earning_currency text,
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
  calculated_net numeric;
begin
  if not public.has_workspace_role(workspace_target, array['owner']::public.workspace_role[]) then
    raise exception 'Only the workspace owner can create manual earnings';
  end if;
  if client_target is not null and not exists (
    select 1 from public.clients where id = client_target and workspace_id = workspace_target
  ) then
    raise exception 'The client does not belong to this workspace';
  end if;
  if earning_description is null
     or char_length(trim(earning_description)) < 1
     or char_length(trim(earning_description)) > 300 then
    raise exception 'The description must have between 1 and 300 characters';
  end if;
  if earning_currency not in ('USD', 'BRL') then raise exception 'Invalid currency'; end if;
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

  calculated_net := public.calculate_net_usd(
    gross_amount_usd,
    earning_fee_percent,
    earning_fee_fixed_usd,
    case when earning_currency = 'BRL' then 0 else earning_conversion_spread_percent end
  );

  insert into public.earnings (
    workspace_id, client_id, source_type, description, item_count, currency,
    amount_usd, net_amount_usd, payment_method, fee_percent, fee_fixed_usd,
    conversion_spread_percent, status, earned_at, received_at,
    exchange_rate_brl, amount_brl
  ) values (
    workspace_target, client_target, 'manual', trim(earning_description), 1, earning_currency,
    round(gross_amount_usd, 2), calculated_net, earning_payment_method,
    earning_fee_percent, earning_fee_fixed_usd,
    case when earning_currency = 'BRL' then 0 else earning_conversion_spread_percent end,
    case when mark_as_received then 'received' else 'pending' end,
    coalesce(earning_date, now()), case when mark_as_received then now() else null end,
    case
      when not mark_as_received then null
      when earning_currency = 'BRL' then 1
      when calculated_net > 0 then round(actual_amount_brl / calculated_net, 6)
      else null
    end,
    case when mark_as_received then round(actual_amount_brl, 2) else null end
  ) returning id into new_earning_id;

  return new_earning_id;
end;
$$;

create function public.update_manual_earning(
  earning_target uuid,
  client_target uuid,
  earning_description text,
  earning_currency text,
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
  calculated_net numeric;
begin
  select workspace_id into target_workspace
  from public.earnings
  where id = earning_target and source_type = 'manual';

  if target_workspace is null
     or not public.has_workspace_role(target_workspace, array['owner']::public.workspace_role[]) then
    raise exception 'Manual earning not found or access denied';
  end if;
  if client_target is not null and not exists (
    select 1 from public.clients where id = client_target and workspace_id = target_workspace
  ) then
    raise exception 'The client does not belong to this workspace';
  end if;
  if earning_description is null
     or char_length(trim(earning_description)) < 1
     or char_length(trim(earning_description)) > 300 then
    raise exception 'The description must have between 1 and 300 characters';
  end if;
  if earning_currency not in ('USD', 'BRL') then raise exception 'Invalid currency'; end if;
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

  calculated_net := public.calculate_net_usd(
    gross_amount_usd,
    earning_fee_percent,
    earning_fee_fixed_usd,
    case when earning_currency = 'BRL' then 0 else earning_conversion_spread_percent end
  );

  update public.earnings
  set client_id = client_target,
      description = trim(earning_description),
      currency = earning_currency,
      amount_usd = round(gross_amount_usd, 2),
      net_amount_usd = calculated_net,
      payment_method = earning_payment_method,
      fee_percent = earning_fee_percent,
      fee_fixed_usd = earning_fee_fixed_usd,
      conversion_spread_percent = case when earning_currency = 'BRL' then 0 else earning_conversion_spread_percent end,
      status = case when mark_as_received then 'received' else 'pending' end,
      earned_at = coalesce(earning_date, earned_at),
      received_at = case when mark_as_received then coalesce(received_at, now()) else null end,
      exchange_rate_brl = case
        when not mark_as_received then null
        when earning_currency = 'BRL' then 1
        when calculated_net > 0 then round(actual_amount_brl / calculated_net, 6)
        else null
      end,
      amount_brl = case when mark_as_received then round(actual_amount_brl, 2) else null end
  where id = earning_target and source_type = 'manual';
end;
$$;

revoke all on function public.process_client_earning_events(uuid) from public, authenticated;
revoke all on function public.record_task_earning() from public, authenticated;
revoke all on function public.sync_client_earnings(uuid) from public;
revoke all on function public.create_manual_earning(uuid, uuid, text, text, numeric, timestamptz, text, numeric, numeric, numeric, boolean, numeric) from public;
revoke all on function public.update_manual_earning(uuid, uuid, text, text, numeric, timestamptz, text, numeric, numeric, numeric, boolean, numeric) from public;

grant execute on function public.sync_client_earnings(uuid) to authenticated;
grant execute on function public.create_manual_earning(uuid, uuid, text, text, numeric, timestamptz, text, numeric, numeric, numeric, boolean, numeric) to authenticated;
grant execute on function public.update_manual_earning(uuid, uuid, text, text, numeric, timestamptz, text, numeric, numeric, numeric, boolean, numeric) to authenticated;
