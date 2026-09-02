-- Automatic editor compensation. Each editor can have one default per-video
-- rate plus client-specific overrides. A cost snapshot is created when an
-- assigned task is completed, so later rate changes never rewrite history.

create table public.editor_compensation_settings (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  editor_user_id uuid not null references public.profiles(id) on delete cascade,
  currency text not null check (currency in ('USD', 'BRL')),
  amount_per_video numeric(12,2) not null check (amount_per_video > 0),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, editor_user_id),
  foreign key (workspace_id, editor_user_id)
    references public.workspace_members(workspace_id, user_id) on delete cascade
);

create table public.editor_client_compensation_rates (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  editor_user_id uuid not null references public.profiles(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  currency text not null check (currency in ('USD', 'BRL')),
  amount_per_video numeric(12,2) not null check (amount_per_video > 0),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, editor_user_id, client_id),
  foreign key (workspace_id, editor_user_id)
    references public.workspace_members(workspace_id, user_id) on delete cascade
);

create table public.editor_cost_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  task_id uuid not null unique references public.tasks(id) on delete cascade,
  editor_user_id uuid references public.profiles(id) on delete set null,
  editor_name text not null check (char_length(trim(editor_name)) between 1 and 120),
  client_id uuid references public.clients(id) on delete set null,
  task_title text not null check (char_length(trim(task_title)) between 1 and 300),
  currency text not null check (currency in ('USD', 'BRL')),
  amount numeric(12,2) not null check (amount > 0),
  rate_source text not null check (rate_source in ('default', 'client')),
  completed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index editor_compensation_settings_workspace_idx
on public.editor_compensation_settings(workspace_id);

create index editor_client_compensation_rates_editor_idx
on public.editor_client_compensation_rates(workspace_id, editor_user_id);

create index editor_cost_entries_workspace_completed_idx
on public.editor_cost_entries(workspace_id, completed_at desc);

create index editor_cost_entries_editor_completed_idx
on public.editor_cost_entries(editor_user_id, completed_at desc);

create trigger editor_compensation_settings_touch_updated_at
before update on public.editor_compensation_settings
for each row execute function public.touch_updated_at();

create trigger editor_client_compensation_rates_touch_updated_at
before update on public.editor_client_compensation_rates
for each row execute function public.touch_updated_at();

create trigger editor_cost_entries_touch_updated_at
before update on public.editor_cost_entries
for each row execute function public.touch_updated_at();

-- Internal helper used by completion and repair flows. Existing snapshots are
-- preserved during backfills; only a new completion may replace its snapshot.
create or replace function public.refresh_task_editor_cost(
  target_task uuid,
  overwrite_existing boolean default true
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  task_row public.tasks%rowtype;
  selected_currency text;
  selected_amount numeric(12,2);
  selected_source text;
  selected_editor_name text;
begin
  select * into task_row
  from public.tasks
  where id = target_task;

  if task_row.id is null then return false; end if;

  if task_row.completed_at is null then
    delete from public.editor_cost_entries where task_id = target_task;
    return false;
  end if;

  if not overwrite_existing and exists (
    select 1 from public.editor_cost_entries where task_id = target_task
  ) then
    return false;
  end if;

  if task_row.assignee_id is null or not exists (
    select 1
    from public.workspace_members as membership
    where membership.workspace_id = task_row.workspace_id
      and membership.user_id = task_row.assignee_id
      and membership.role = 'editor'
  ) then
    return false;
  end if;

  select chosen.currency, chosen.amount_per_video, chosen.rate_source
  into selected_currency, selected_amount, selected_source
  from (
    select rate.currency, rate.amount_per_video, 'client'::text as rate_source, 1 as priority
    from public.editor_client_compensation_rates as rate
    where task_row.client_id is not null
      and rate.workspace_id = task_row.workspace_id
      and rate.editor_user_id = task_row.assignee_id
      and rate.client_id = task_row.client_id

    union all

    select setting.currency, setting.amount_per_video, 'default'::text as rate_source, 2 as priority
    from public.editor_compensation_settings as setting
    where setting.workspace_id = task_row.workspace_id
      and setting.editor_user_id = task_row.assignee_id
  ) as chosen
  order by chosen.priority
  limit 1;

  if selected_amount is null then return false; end if;

  select coalesce(nullif(trim(profile.display_name), ''), 'Editor')
  into selected_editor_name
  from public.profiles as profile
  where profile.id = task_row.assignee_id;

  insert into public.editor_cost_entries (
    workspace_id,
    task_id,
    editor_user_id,
    editor_name,
    client_id,
    task_title,
    currency,
    amount,
    rate_source,
    completed_at
  ) values (
    task_row.workspace_id,
    task_row.id,
    task_row.assignee_id,
    coalesce(selected_editor_name, 'Editor'),
    task_row.client_id,
    task_row.title,
    selected_currency,
    selected_amount,
    selected_source,
    task_row.completed_at
  )
  on conflict (task_id) do update
  set editor_user_id = excluded.editor_user_id,
      editor_name = excluded.editor_name,
      client_id = excluded.client_id,
      task_title = excluded.task_title,
      currency = excluded.currency,
      amount = excluded.amount,
      rate_source = excluded.rate_source,
      completed_at = excluded.completed_at;

  return true;
end;
$$;

create or replace function public.record_task_editor_cost()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.completed_at is not distinct from new.completed_at then
    return new;
  end if;

  perform public.refresh_task_editor_cost(new.id, true);
  return new;
end;
$$;

drop trigger if exists tasks_record_editor_cost on public.tasks;
create trigger tasks_record_editor_cost
after insert or update of completed_at on public.tasks
for each row execute function public.record_task_editor_cost();

create or replace function public.backfill_editor_costs(
  target_workspace uuid,
  target_editor uuid default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  task_record record;
  inserted_count integer := 0;
begin
  for task_record in
    select task_row.id
    from public.tasks as task_row
    where task_row.workspace_id = target_workspace
      and task_row.completed_at is not null
      and (target_editor is null or task_row.assignee_id = target_editor)
    order by task_row.id
  loop
    if public.refresh_task_editor_cost(task_record.id, false) then
      inserted_count := inserted_count + 1;
    end if;
  end loop;

  return inserted_count;
end;
$$;

-- Replaces one editor's current configuration atomically. Passing a null
-- default amount leaves the editor with client-specific rates only.
create or replace function public.update_editor_compensation(
  target_workspace uuid,
  target_editor uuid,
  default_currency text,
  default_amount numeric,
  client_rates jsonb default '[]'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_rates jsonb := coalesce(client_rates, '[]'::jsonb);
begin
  if auth.uid() is null or not public.has_workspace_role(
    target_workspace,
    array['owner']::public.workspace_role[]
  ) then
    raise exception 'Only the workspace owner can configure editor compensation';
  end if;

  if not exists (
    select 1
    from public.workspace_members
    where workspace_id = target_workspace
      and user_id = target_editor
      and role = 'editor'
  ) then
    raise exception 'The selected member is not an editor in this workspace';
  end if;

  if default_amount is not null then
    if default_currency not in ('USD', 'BRL') then raise exception 'Invalid default currency'; end if;
    if default_amount <= 0 or default_amount > 1000000 then raise exception 'Invalid default editor rate'; end if;
  end if;

  if jsonb_typeof(normalized_rates) <> 'array' or jsonb_array_length(normalized_rates) > 500 then
    raise exception 'Invalid client rate list';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(normalized_rates) as rate(client_id uuid, currency text, amount numeric)
    where rate.client_id is null
       or rate.currency not in ('USD', 'BRL')
       or rate.amount is null
       or rate.amount <= 0
       or rate.amount > 1000000
       or not exists (
         select 1 from public.clients as client_row
         where client_row.id = rate.client_id
           and client_row.workspace_id = target_workspace
       )
  ) then
    raise exception 'One or more client rates are invalid';
  end if;

  if (
    select count(*) <> count(distinct rate.client_id)
    from jsonb_to_recordset(normalized_rates) as rate(client_id uuid)
  ) then
    raise exception 'Duplicate client rates are not allowed';
  end if;

  if default_amount is null then
    delete from public.editor_compensation_settings
    where workspace_id = target_workspace and editor_user_id = target_editor;
  else
    insert into public.editor_compensation_settings (
      workspace_id, editor_user_id, currency, amount_per_video, created_by
    ) values (
      target_workspace, target_editor, default_currency, round(default_amount, 2), auth.uid()
    )
    on conflict (workspace_id, editor_user_id) do update
    set currency = excluded.currency,
        amount_per_video = excluded.amount_per_video;
  end if;

  delete from public.editor_client_compensation_rates
  where workspace_id = target_workspace and editor_user_id = target_editor;

  insert into public.editor_client_compensation_rates (
    workspace_id, editor_user_id, client_id, currency, amount_per_video, created_by
  )
  select
    target_workspace,
    target_editor,
    rate.client_id,
    rate.currency,
    round(rate.amount, 2),
    auth.uid()
  from jsonb_to_recordset(normalized_rates) as rate(client_id uuid, currency text, amount numeric);

  perform public.backfill_editor_costs(target_workspace, target_editor);
end;
$$;

create or replace function public.sync_workspace_editor_costs(target_workspace uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.has_workspace_role(
    target_workspace,
    array['owner']::public.workspace_role[]
  ) then
    raise exception 'Only the workspace owner can synchronize editor costs';
  end if;

  return public.backfill_editor_costs(target_workspace, null);
end;
$$;

alter table public.editor_compensation_settings enable row level security;
alter table public.editor_client_compensation_rates enable row level security;
alter table public.editor_cost_entries enable row level security;

create policy "owners view editor compensation settings" on public.editor_compensation_settings
for select to authenticated
using (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]));

create policy "owners view editor client rates" on public.editor_client_compensation_rates
for select to authenticated
using (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]));

create policy "owners view editor cost entries" on public.editor_cost_entries
for select to authenticated
using (public.has_workspace_role(workspace_id, array['owner']::public.workspace_role[]));

revoke all on table public.editor_compensation_settings from public, anon, authenticated;
revoke all on table public.editor_client_compensation_rates from public, anon, authenticated;
revoke all on table public.editor_cost_entries from public, anon, authenticated;

grant select on table public.editor_compensation_settings to authenticated;
grant select on table public.editor_client_compensation_rates to authenticated;
grant select on table public.editor_cost_entries to authenticated;

revoke all on function public.refresh_task_editor_cost(uuid, boolean) from public, anon, authenticated;
revoke all on function public.record_task_editor_cost() from public, anon, authenticated;
revoke all on function public.backfill_editor_costs(uuid, uuid) from public, anon, authenticated;
revoke all on function public.update_editor_compensation(uuid, uuid, text, numeric, jsonb) from public, anon, authenticated;
revoke all on function public.sync_workspace_editor_costs(uuid) from public, anon, authenticated;

grant execute on function public.update_editor_compensation(uuid, uuid, text, numeric, jsonb) to authenticated;
grant execute on function public.sync_workspace_editor_costs(uuid) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'editor_compensation_settings'
  ) then
    alter publication supabase_realtime add table public.editor_compensation_settings;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'editor_client_compensation_rates'
  ) then
    alter publication supabase_realtime add table public.editor_client_compensation_rates;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'editor_cost_entries'
  ) then
    alter publication supabase_realtime add table public.editor_cost_entries;
  end if;
end;
$$;
