-- Ensure every table observed by the desktop app is available through
-- Supabase Realtime. Run this migration with all EditFlow instances closed
-- to avoid publication-lock conflicts with active replication sessions.

do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'tasks',
    'task_links',
    'columns',
    'clients',
    'profiles',
    'workspace_members',
    'notifications',
    'chat_conversations',
    'chat_conversation_members',
    'chat_messages'
  ]
  loop
    if to_regclass('public.' || target_table) is not null
       and not exists (
         select 1
         from pg_publication_tables
         where pubname = 'supabase_realtime'
           and schemaname = 'public'
           and tablename = target_table
       ) then
      execute format(
        'alter publication supabase_realtime add table public.%I',
        target_table
      );
    end if;
  end loop;
end;
$$;
