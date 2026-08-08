-- Accounts created before 001_initial.sql do not have a public.profiles row.
-- Backfill them and make workspace creation repair the current profile safely.

insert into public.profiles (id, display_name)
select
  users.id,
  coalesce(users.raw_user_meta_data ->> 'full_name', '')
from auth.users as users
on conflict (id) do nothing;

create or replace function public.create_workspace(workspace_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  new_workspace_id uuid;
  new_board_id uuid;
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  if char_length(trim(workspace_name)) < 2 then
    raise exception 'Workspace name is too short';
  end if;

  insert into public.profiles (id, display_name)
  select
    users.id,
    coalesce(users.raw_user_meta_data ->> 'full_name', '')
  from auth.users as users
  where users.id = current_user_id
  on conflict (id) do nothing;

  insert into public.workspaces (name, owner_id)
  values (trim(workspace_name), current_user_id)
  returning id into new_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new_workspace_id, current_user_id, 'owner');

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

grant execute on function public.create_workspace(text) to authenticated;
