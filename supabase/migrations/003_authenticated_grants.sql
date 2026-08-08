-- RLS policies do not replace PostgreSQL table privileges.
-- Grant authenticated users access; the existing policies still restrict rows.

grant usage on schema public to authenticated;
grant usage on type public.workspace_role to authenticated;

grant select, insert, update, delete on table
  public.profiles,
  public.workspaces,
  public.workspace_members,
  public.clients,
  public.boards,
  public.columns,
  public.tasks,
  public.task_links
to authenticated;

grant execute on function public.create_workspace(text) to authenticated;
grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.has_workspace_role(uuid, public.workspace_role[]) to authenticated;

-- Keep the same baseline for tables added by future migrations.
alter default privileges in schema public
grant select, insert, update, delete on tables to authenticated;
