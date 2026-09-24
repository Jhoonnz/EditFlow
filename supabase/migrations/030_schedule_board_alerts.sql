-- Requires Supabase Cron (pg_cron). Enable Cron in Integrations first.
-- Separate from 029 so a missing extension never rolls back the Kanban fixes.
create extension if not exists pg_cron;
select cron.schedule(
  'editflow-board-inactivity',
  '*/10 * * * *',
  'select public.run_all_board_automation_alerts()'
);
