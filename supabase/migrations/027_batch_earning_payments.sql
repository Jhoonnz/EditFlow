-- Group several pending earnings into one real payment. Receiving fees are
-- calculated once per transfer instead of once per delivered video. BRL
-- payments are treated as PIX: no fees, spread or currency conversion.

update public.client_billing_settings
set payment_method = 'none',
    fee_percent = 0,
    fee_fixed_usd = 0,
    conversion_spread_percent = 0
where currency = 'BRL';

update public.earnings
set payment_method = 'none',
    fee_percent = 0,
    fee_fixed_usd = 0,
    conversion_spread_percent = 0,
    net_amount_usd = amount_usd
where currency = 'BRL' and status = 'pending';

update public.earning_events
set payment_method = 'none',
    fee_percent = 0,
    fee_fixed_usd = 0,
    conversion_spread_percent = 0
where currency = 'BRL' and earning_id is null;

alter table public.client_billing_settings
add constraint client_billing_settings_brl_pix_check
check (
  currency <> 'BRL'
  or (
    payment_method = 'none'
    and fee_percent = 0
    and fee_fixed_usd = 0
    and conversion_spread_percent = 0
  )
);

create table public.earning_payments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  currency text not null check (currency in ('USD', 'BRL')),
  payment_method text not null check (
    payment_method in ('none', 'paypal_international', 'wise_ach', 'wise_wire', 'custom')
  ),
  entry_count integer not null check (entry_count > 0),
  item_count integer not null check (item_count > 0),
  gross_amount numeric(14,2) not null check (gross_amount > 0),
  estimated_net_amount numeric(14,2) not null check (estimated_net_amount > 0),
  fee_percent numeric(7,4) not null default 0 check (fee_percent between 0 and 100),
  fee_fixed numeric(12,2) not null default 0 check (fee_fixed >= 0),
  conversion_spread_percent numeric(7,4) not null default 0
    check (conversion_spread_percent between 0 and 100),
  received_amount_brl numeric(14,2) not null check (received_amount_brl > 0),
  effective_exchange_rate numeric(14,6) not null check (effective_exchange_rate > 0),
  period_start date not null,
  period_end date not null,
  received_at timestamptz not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  check (period_end >= period_start),
  check (
    currency <> 'BRL'
    or (
      payment_method = 'none'
      and fee_percent = 0
      and fee_fixed = 0
      and conversion_spread_percent = 0
      and effective_exchange_rate = 1
      and received_amount_brl = gross_amount
      and estimated_net_amount = gross_amount
    )
  )
);

create index earning_payments_workspace_received_idx
on public.earning_payments(workspace_id, received_at desc);

create index earning_payments_client_received_idx
on public.earning_payments(client_id, received_at desc);

alter table public.earnings
add column if not exists payment_id uuid references public.earning_payments(id) on delete set null;

create index if not exists earnings_payment_idx
on public.earnings(payment_id)
where payment_id is not null;

alter table public.earning_payments enable row level security;

create policy "owners view earning payments" on public.earning_payments
for select to authenticated
using (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]));

revoke all on table public.earning_payments from public, anon, authenticated;
grant select on table public.earning_payments to authenticated;

create or replace function public.register_earning_payment_batch(
  target_workspace uuid,
  target_client uuid,
  target_earning_ids uuid[],
  target_payment_method text,
  target_fee_percent numeric,
  target_fee_fixed numeric,
  target_conversion_spread_percent numeric,
  target_received_amount_brl numeric,
  target_period_start date,
  target_period_end date,
  target_received_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  batch_id uuid;
  batch_currency text;
  batch_entry_count integer;
  batch_item_count integer;
  batch_gross numeric(14,2);
  batch_net numeric(14,2);
  batch_received_brl numeric(14,2);
  batch_exchange_rate numeric(14,6);
  normalized_method text;
  normalized_fee_percent numeric(7,4);
  normalized_fee_fixed numeric(12,2);
  normalized_spread numeric(7,4);
begin
  if auth.uid() is null or not public.has_workspace_role(
    target_workspace,
    array['owner']::public.workspace_role[]
  ) then
    raise exception 'Only the workspace owner can register payments';
  end if;

  if target_client is not null and not exists (
    select 1 from public.clients
    where id = target_client and workspace_id = target_workspace
  ) then
    raise exception 'The payment client does not belong to this workspace';
  end if;

  if target_earning_ids is null
     or cardinality(target_earning_ids) < 1
     or cardinality(target_earning_ids) > 500
     or (
       select count(distinct earning_id)
       from unnest(target_earning_ids) as selected(earning_id)
     ) <> cardinality(target_earning_ids) then
    raise exception 'Select between 1 and 500 unique earnings';
  end if;

  if target_period_start is null
     or target_period_end is null
     or target_period_end < target_period_start then
    raise exception 'The payment period is invalid';
  end if;

  if target_received_at is null or target_received_at > now() + interval '1 day' then
    raise exception 'The payment date is invalid';
  end if;

  -- A stable locking order prevents two open EditFlow instances from
  -- receiving the same earnings at the same time.
  perform 1
  from public.earnings
  where id = any(target_earning_ids)
  order by id
  for update;

  select
    count(*),
    coalesce(sum(item_count), 0),
    round(coalesce(sum(amount_usd), 0), 2),
    min(currency)
  into batch_entry_count, batch_item_count, batch_gross, batch_currency
  from public.earnings
  where id = any(target_earning_ids);

  if batch_entry_count <> cardinality(target_earning_ids)
     or exists (
       select 1
       from public.earnings
       where id = any(target_earning_ids)
         and (
           workspace_id <> target_workspace
           or client_id is distinct from target_client
           or (target_client is null and source_type <> 'manual')
           or status <> 'pending'
           or payment_id is not null
           or currency <> batch_currency
         )
     ) then
    raise exception 'The selection contains an unavailable or incompatible earning';
  end if;

  if batch_currency = 'BRL' then
    normalized_method := 'none';
    normalized_fee_percent := 0;
    normalized_fee_fixed := 0;
    normalized_spread := 0;
    batch_net := batch_gross;
    batch_received_brl := batch_gross;
    batch_exchange_rate := 1;
  else
    if coalesce(target_payment_method, '') not in (
      'none', 'paypal_international', 'wise_ach', 'wise_wire', 'custom'
    ) then
      raise exception 'Invalid payment method';
    end if;
    if coalesce(target_fee_percent, -1) not between 0 and 100
       or coalesce(target_fee_fixed, -1) < 0
       or coalesce(target_conversion_spread_percent, -1) not between 0 and 100 then
      raise exception 'Invalid payment fee configuration';
    end if;
    if target_received_amount_brl is null or target_received_amount_brl <= 0 then
      raise exception 'The actual BRL amount is required';
    end if;

    normalized_method := target_payment_method;
    normalized_fee_percent := target_fee_percent;
    normalized_fee_fixed := target_fee_fixed;
    normalized_spread := target_conversion_spread_percent;
    batch_net := public.calculate_net_usd(
      batch_gross,
      normalized_fee_percent,
      normalized_fee_fixed,
      normalized_spread
    );
    if batch_net <= 0 then raise exception 'The net payment amount must be greater than zero'; end if;
    batch_received_brl := round(target_received_amount_brl, 2);
    batch_exchange_rate := round(batch_received_brl / batch_net, 6);
  end if;

  insert into public.earning_payments (
    workspace_id, client_id, currency, payment_method, entry_count, item_count,
    gross_amount, estimated_net_amount, fee_percent, fee_fixed,
    conversion_spread_percent, received_amount_brl, effective_exchange_rate,
    period_start, period_end, received_at, created_by
  ) values (
    target_workspace, target_client, batch_currency, normalized_method,
    batch_entry_count, batch_item_count, batch_gross, batch_net,
    normalized_fee_percent, normalized_fee_fixed, normalized_spread,
    batch_received_brl, batch_exchange_rate, target_period_start,
    target_period_end, target_received_at, auth.uid()
  ) returning id into batch_id;

  -- Allocate the batch totals proportionally. The final row receives any
  -- rounding remainder, so sums always equal the actual transfer exactly.
  perform set_config('editflow.payment_batch_write', 'on', true);
  with source_rows as (
    select
      earning_row.id,
      earning_row.amount_usd,
      row_number() over (order by earning_row.earned_at, earning_row.id) as row_number,
      count(*) over () as row_count
    from public.earnings as earning_row
    where earning_row.id = any(target_earning_ids)
  ), raw_allocations as (
    select
      source_rows.*,
      round(source_rows.amount_usd / batch_gross * batch_net, 2) as allocated_net,
      round(source_rows.amount_usd / batch_gross * batch_received_brl, 2) as allocated_brl
    from source_rows
  ), allocations as (
    select
      raw_allocations.*,
      sum(allocated_net) over () as allocated_net_total,
      sum(allocated_brl) over () as allocated_brl_total
    from raw_allocations
  )
  update public.earnings as earning_row
  set
    net_amount_usd = case
      when allocations.row_number = allocations.row_count
        then round(batch_net - (allocations.allocated_net_total - allocations.allocated_net), 2)
      else allocations.allocated_net
    end,
    payment_method = normalized_method,
    fee_percent = normalized_fee_percent,
    fee_fixed_usd = normalized_fee_fixed,
    conversion_spread_percent = normalized_spread,
    status = 'received',
    received_at = target_received_at,
    exchange_rate_brl = batch_exchange_rate,
    amount_brl = case
      when allocations.row_number = allocations.row_count
        then round(batch_received_brl - (allocations.allocated_brl_total - allocations.allocated_brl), 2)
      else allocations.allocated_brl
    end,
    payment_id = batch_id
  from allocations
  where earning_row.id = allocations.id;

  return batch_id;
end;
$$;

create or replace function public.reopen_earning_payment(target_payment uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_workspace uuid;
begin
  select workspace_id into target_workspace
  from public.earning_payments
  where id = target_payment
  for update;

  if target_workspace is null or not public.has_workspace_role(
    target_workspace,
    array['owner']::public.workspace_role[]
  ) then
    raise exception 'Payment not found or access denied';
  end if;

  perform set_config('editflow.payment_batch_write', 'on', true);
  update public.earnings
  set
    net_amount_usd = public.calculate_net_usd(
      amount_usd,
      fee_percent,
      fee_fixed_usd,
      conversion_spread_percent
    ),
    status = 'pending',
    received_at = null,
    exchange_rate_brl = null,
    amount_brl = null,
    payment_id = null
  where payment_id = target_payment;

  delete from public.earning_payments where id = target_payment;
end;
$$;

-- A manual earning already included in a payment must first have its whole
-- payment reopened so totals and audit history cannot become inconsistent.
create or replace function public.protect_earning_payment_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('editflow.payment_batch_write', true), '') = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  -- Allow referential actions such as deleting a workspace or removing a
  -- client. Both the payment and its earnings keep matching nullable clients.
  if pg_trigger_depth() > 1 then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if old.payment_id is not null
     or (tg_op = 'UPDATE' and new.payment_id is not null) then
    raise exception 'Reopen the payment before changing one of its earnings';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists earnings_protect_payment_membership on public.earnings;
create trigger earnings_protect_payment_membership
before update or delete on public.earnings
for each row execute function public.protect_earning_payment_membership();

revoke all on function public.register_earning_payment_batch(
  uuid, uuid, uuid[], text, numeric, numeric, numeric, numeric, date, date, timestamptz
) from public, anon, authenticated;
revoke all on function public.reopen_earning_payment(uuid)
from public, anon, authenticated;
revoke all on function public.protect_earning_payment_membership()
from public, anon, authenticated;

grant execute on function public.register_earning_payment_batch(
  uuid, uuid, uuid[], text, numeric, numeric, numeric, numeric, date, date, timestamptz
) to authenticated;
grant execute on function public.reopen_earning_payment(uuid) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'earning_payments'
  ) then
    alter publication supabase_realtime add table public.earning_payments;
  end if;
end;
$$;
