create extension if not exists pgcrypto;

create type public.workspace_role as enum ('owner', 'admin', 'editor');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 80),
  owner_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.workspace_role not null default 'editor',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.boards (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.columns (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.boards(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  position numeric not null,
  color text,
  created_at timestamptz not null default now()
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  board_id uuid not null references public.boards(id) on delete cascade,
  column_id uuid not null references public.columns(id) on delete restrict,
  client_id uuid references public.clients(id) on delete set null,
  title text not null check (char_length(title) between 1 and 180),
  description text not null default '',
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  position numeric not null,
  due_at timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.task_links (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 100),
  url text not null check (url ~ '^https://'),
  category text not null default 'download' check (category in ('download', 'briefing', 'reference', 'review', 'delivery')),
  expires_at timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create index workspace_members_user_idx on public.workspace_members(user_id);
create index clients_workspace_idx on public.clients(workspace_id);
create index boards_workspace_idx on public.boards(workspace_id);
create index columns_board_position_idx on public.columns(board_id, position);
create index tasks_board_column_position_idx on public.tasks(board_id, column_id, position);
create index task_links_task_idx on public.task_links(task_id);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at before update on public.profiles
for each row execute function public.touch_updated_at();
create trigger workspaces_touch_updated_at before update on public.workspaces
for each row execute function public.touch_updated_at();
create trigger clients_touch_updated_at before update on public.clients
for each row execute function public.touch_updated_at();
create trigger boards_touch_updated_at before update on public.boards
for each row execute function public.touch_updated_at();
create trigger tasks_touch_updated_at before update on public.tasks
for each row execute function public.touch_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''));
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = target_workspace and user_id = auth.uid()
  );
$$;

create or replace function public.has_workspace_role(target_workspace uuid, allowed_roles public.workspace_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = target_workspace
      and user_id = auth.uid()
      and role = any(allowed_roles)
  );
$$;

create or replace function public.create_workspace(workspace_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_workspace_id uuid;
  new_board_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if char_length(trim(workspace_name)) < 2 then raise exception 'Workspace name is too short'; end if;

  insert into public.workspaces (name, owner_id)
  values (trim(workspace_name), auth.uid())
  returning id into new_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new_workspace_id, auth.uid(), 'owner');

  insert into public.boards (workspace_id, name)
  values (new_workspace_id, 'Produção')
  returning id into new_board_id;

  insert into public.columns (board_id, name, position, color) values
    (new_board_id, 'Novos trabalhos', 1000, '#8b8fa3'),
    (new_board_id, 'Briefing pendente', 2000, '#a78bfa'),
    (new_board_id, 'Arquivos disponíveis', 3000, '#60a5fa'),
    (new_board_id, 'Em edição', 4000, '#f59e0b'),
    (new_board_id, 'Revisão', 5000, '#f97316'),
    (new_board_id, 'Ajustes', 6000, '#fb7185'),
    (new_board_id, 'Aprovado', 7000, '#34d399'),
    (new_board_id, 'Entregue', 8000, '#22c55e');

  return new_workspace_id;
end;
$$;

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.clients enable row level security;
alter table public.boards enable row level security;
alter table public.columns enable row level security;
alter table public.tasks enable row level security;
alter table public.task_links enable row level security;

create policy "profiles are visible to authenticated users" on public.profiles
for select to authenticated using (true);
create policy "users update own profile" on public.profiles
for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "members view workspaces" on public.workspaces
for select to authenticated using (public.is_workspace_member(id));
create policy "admins update workspaces" on public.workspaces
for update to authenticated using (public.has_workspace_role(id, array['owner','admin']::public.workspace_role[]));

create policy "members view memberships" on public.workspace_members
for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "admins manage memberships" on public.workspace_members
for all to authenticated using (public.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[]))
with check (public.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[]));

create policy "members manage clients" on public.clients
for all to authenticated using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
create policy "members manage boards" on public.boards
for all to authenticated using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
create policy "members view columns" on public.columns
for select to authenticated using (
  exists (select 1 from public.boards b where b.id = board_id and public.is_workspace_member(b.workspace_id))
);
create policy "members manage columns" on public.columns
for all to authenticated using (
  exists (select 1 from public.boards b where b.id = board_id and public.is_workspace_member(b.workspace_id))
) with check (
  exists (select 1 from public.boards b where b.id = board_id and public.is_workspace_member(b.workspace_id))
);
create policy "members manage tasks" on public.tasks
for all to authenticated using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
create policy "members manage task links" on public.task_links
for all to authenticated using (
  exists (select 1 from public.tasks t where t.id = task_id and public.is_workspace_member(t.workspace_id))
) with check (
  exists (select 1 from public.tasks t where t.id = task_id and public.is_workspace_member(t.workspace_id))
);

grant execute on function public.create_workspace(text) to authenticated;
grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.has_workspace_role(uuid, public.workspace_role[]) to authenticated;

alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.task_links;
