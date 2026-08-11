-- Track client pricing and generate immutable earning records when tasks reach
-- a completion column. Financial data is visible only to workspace owners.

alter table public.columns
add column if not exists is_completion boolean not null default false;

update public.columns
set is_completion = true
where lower(trim(name)) in ('entregue', 'concluido', 'concluído', 'finalizado');

alter table public.tasks
add column if not exists completed_at timestamptz;

update public.tasks as task_row
set completed_at = task_row.updated_at
from public.columns as column_row
where column_row.id = task_row.column_id
  and column_row.is_completion
  and task_row.completed_at is null;

create table public.client_billing_settings (
  client_id uuid primary key references public.clients(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  currency text not null default 'USD' check (currency = 'USD'),
  pricing_model text not null check (pricing_model in ('per_video', 'bundle')),
  amount_usd numeric(12,2) not null check (amount_usd > 0),
  bundle_size integer not null default 1 check (bundle_size between 1 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (pricing_model = 'per_video' and bundle_size = 1)
    or pricing_model = 'bundle'
  )
);

create index client_billing_settings_workspace_idx
on public.client_billing_settings(workspace_id);

create table public.earnings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  source_type text not null check (source_type in ('per_video', 'bundle', 'manual')),
  description text not null check (char_length(description) between 1 and 300),
  item_count integer not null default 1 check (item_count > 0),
  amount_usd numeric(12,2) not null check (amount_usd <> 0),
  status text not null default 'pending' check (status in ('pending', 'received')),
  earned_at timestamptz not null default now(),
  received_at timestamptz,
  exchange_rate_brl numeric(14,6) check (exchange_rate_brl > 0),
  amount_brl numeric(14,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'pending' and received_at is null and exchange_rate_brl is null and amount_brl is null)
    or
    (status = 'received' and received_at is not null and exchange_rate_brl is not null and amount_brl is not null)
  )
);

create index earnings_workspace_earned_idx
on public.earnings(workspace_id, earned_at desc);

create index earnings_client_idx on public.earnings(client_id);

create table public.earning_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  task_id uuid unique references public.tasks(id) on delete set null,
  task_title text not null,
  completed_at timestamptz not null,
  pricing_model text not null check (pricing_model in ('per_video', 'bundle')),
  amount_usd numeric(12,2) not null check (amount_usd > 0),
  bundle_size integer not null check (bundle_size between 1 and 1000),
  earning_id uuid references public.earnings(id) on delete set null,
  created_at timestamptz not null default now()
);

create index earning_events_client_unallocated_idx
on public.earning_events(client_id, completed_at)
where earning_id is null;

create index earning_events_earning_idx on public.earning_events(earning_id);

create trigger client_billing_settings_touch_updated_at
before update on public.client_billing_settings
for each row execute function public.touch_updated_at();

create trigger earnings_touch_updated_at
before update on public.earnings
for each row execute function public.touch_updated_at();

create or replace function public.validate_client_billing_setting()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.clients
    where id = new.client_id and workspace_id = new.workspace_id
  ) then
    raise exception 'The billing client does not belong to this workspace';
  end if;

  return new;
end;
$$;

drop trigger if exists client_billing_settings_validate_client on public.client_billing_settings;
create trigger client_billing_settings_validate_client
before insert or update of client_id, workspace_id on public.client_billing_settings
for each row execute function public.validate_client_billing_setting();

create or replace function public.infer_completion_column()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if lower(trim(new.name)) in ('entregue', 'concluido', 'concluído', 'finalizado') then
    new.is_completion := true;
  end if;
  return new;
end;
$$;

drop trigger if exists columns_infer_completion on public.columns;
create trigger columns_infer_completion
before insert on public.columns
for each row execute function public.infer_completion_column();

create or replace function public.stamp_task_completion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  completes_work boolean;
begin
  if new.completed_at is not null then return new; end if;

  select is_completion into completes_work
  from public.columns
  where id = new.column_id;

  if coalesce(completes_work, false) then
    new.completed_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists tasks_stamp_completion on public.tasks;
create trigger tasks_stamp_completion
before insert or update of column_id on public.tasks
for each row execute function public.stamp_task_completion();

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
    select distinct pricing_model, amount_usd, bundle_size
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
  if new.completed_at is null or new.client_id is null then
    return new;
  end if;

  if tg_op = 'UPDATE' and old.completed_at is not distinct from new.completed_at then
    return new;
  end if;

  select * into billing
  from public.client_billing_settings
  where client_id = new.client_id
    and workspace_id = new.workspace_id;

  if billing.client_id is null then return new; end if;

  insert into public.earning_events (
    workspace_id,
    client_id,
    task_id,
    task_title,
    completed_at,
    pricing_model,
    amount_usd,
    bundle_size
  ) values (
    new.workspace_id,
    new.client_id,
    new.id,
    new.title,
    new.completed_at,
    billing.pricing_model,
    billing.amount_usd,
    billing.bundle_size
  ) on conflict (task_id) do nothing;

  perform public.process_client_earning_events(new.client_id);
  return new;
end;
$$;

drop trigger if exists tasks_record_earning on public.tasks;
create trigger tasks_record_earning
after insert or update on public.tasks
for each row execute function public.record_task_earning();

create or replace function public.activate_completion_column()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.is_completion is distinct from true and new.is_completion then
    update public.tasks
    set completed_at = coalesce(completed_at, now())
    where column_id = new.id and completed_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists columns_activate_completion on public.columns;
create trigger columns_activate_completion
after update of is_completion on public.columns
for each row execute function public.activate_completion_column();

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
  select workspace_id into target_workspace
  from public.clients
  where id = target_client;

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
    bundle_size
  )
  select
    task_row.workspace_id,
    target_client,
    task_row.id,
    task_row.title,
    task_row.completed_at,
    billing.pricing_model,
    billing.amount_usd,
    billing.bundle_size
  from public.tasks as task_row
  where task_row.client_id = target_client
    and task_row.completed_at is not null
  on conflict (task_id) do nothing;

  perform public.process_client_earning_events(target_client);
end;
$$;

alter table public.client_billing_settings enable row level security;
alter table public.earnings enable row level security;
alter table public.earning_events enable row level security;

create policy "owners manage client billing" on public.client_billing_settings
for all to authenticated
using (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]))
with check (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]));

create policy "owners manage earnings" on public.earnings
for all to authenticated
using (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]))
with check (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]));

create policy "owners view earning events" on public.earning_events
for select to authenticated
using (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]));

grant select, insert, update, delete on table public.client_billing_settings to authenticated;
grant select, insert, update, delete on table public.earnings to authenticated;
grant select on table public.earning_events to authenticated;

revoke all on function public.process_client_earning_events(uuid) from public;
revoke all on function public.sync_client_earnings(uuid) from public;
revoke all on function public.validate_client_billing_setting() from public;
revoke all on function public.infer_completion_column() from public;
revoke all on function public.stamp_task_completion() from public;
revoke all on function public.record_task_earning() from public;
revoke all on function public.activate_completion_column() from public;
grant execute on function public.sync_client_earnings(uuid) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'client_billing_settings'
  ) then
    alter publication supabase_realtime add table public.client_billing_settings;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'earnings'
  ) then
    alter publication supabase_realtime add table public.earnings;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'earning_events'
  ) then
    alter publication supabase_realtime add table public.earning_events;
  end if;
end;
$$;
