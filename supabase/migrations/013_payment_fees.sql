-- Estimate PayPal/Wise receiving fees and snapshot them into each earning so
-- historical net revenue never changes when a client's configuration changes.

alter table public.client_billing_settings
add column payment_method text not null default 'none'
check (payment_method in ('none', 'paypal_international', 'wise_ach', 'wise_wire', 'custom')),
add column fee_percent numeric(7,4) not null default 0 check (fee_percent between 0 and 100),
add column fee_fixed_usd numeric(12,2) not null default 0 check (fee_fixed_usd >= 0),
add column conversion_spread_percent numeric(7,4) not null default 0
check (conversion_spread_percent between 0 and 100);

alter table public.earning_events
add column payment_method text not null default 'none'
check (payment_method in ('none', 'paypal_international', 'wise_ach', 'wise_wire', 'custom')),
add column fee_percent numeric(7,4) not null default 0 check (fee_percent between 0 and 100),
add column fee_fixed_usd numeric(12,2) not null default 0 check (fee_fixed_usd >= 0),
add column conversion_spread_percent numeric(7,4) not null default 0
check (conversion_spread_percent between 0 and 100);

alter table public.earnings
add column net_amount_usd numeric(12,2),
add column payment_method text not null default 'none'
check (payment_method in ('none', 'paypal_international', 'wise_ach', 'wise_wire', 'custom')),
add column fee_percent numeric(7,4) not null default 0 check (fee_percent between 0 and 100),
add column fee_fixed_usd numeric(12,2) not null default 0 check (fee_fixed_usd >= 0),
add column conversion_spread_percent numeric(7,4) not null default 0
check (conversion_spread_percent between 0 and 100);

update public.earnings
set net_amount_usd = amount_usd
where net_amount_usd is null;

alter table public.earnings
alter column net_amount_usd set not null;

create or replace function public.calculate_net_usd(
  gross_amount numeric,
  variable_fee_percent numeric,
  fixed_fee_usd numeric,
  conversion_spread numeric
)
returns numeric
language sql
immutable
security invoker
set search_path = ''
as $$
  select round(greatest(
    0,
    (gross_amount - (gross_amount * variable_fee_percent / 100) - fixed_fee_usd)
      * (1 - conversion_spread / 100)
  ), 2);
$$;

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

  if billing.client_id is null then raise exception 'Configure client billing before synchronizing earnings'; end if;

  -- Pending estimates may adopt the latest client rule. Confirmed receipts are
  -- deliberately immutable because they represent the actual bank deposit.
  update public.earnings
  set
    payment_method = billing.payment_method,
    fee_percent = billing.fee_percent,
    fee_fixed_usd = billing.fee_fixed_usd,
    conversion_spread_percent = billing.conversion_spread_percent,
    net_amount_usd = public.calculate_net_usd(
      amount_usd,
      billing.fee_percent,
      billing.fee_fixed_usd,
      billing.conversion_spread_percent
    )
  where client_id = target_client and status = 'pending';

  update public.earning_events
  set
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

revoke all on function public.calculate_net_usd(numeric, numeric, numeric, numeric) from public;
revoke all on function public.process_client_earning_events(uuid) from public;
revoke all on function public.record_task_earning() from public;
revoke all on function public.sync_client_earnings(uuid) from public;
grant execute on function public.sync_client_earnings(uuid) to authenticated;
