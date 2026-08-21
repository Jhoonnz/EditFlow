-- One default task template per client. Owners and admins manage templates
-- directly from the task editor; selecting a client can then prefill the task.

create table public.client_task_templates (
  client_id uuid primary key references public.clients(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title_template text not null default '' check (char_length(title_template) <= 180),
  description_template text not null default '' check (char_length(description_template) <= 4000),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  assignee_id uuid references public.profiles(id) on delete set null,
  due_offset_days integer not null default 7 check (due_offset_days between 0 and 365),
  due_business_days boolean not null default false,
  link_label text not null default 'Arquivos para download' check (char_length(trim(link_label)) between 1 and 100),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index client_task_templates_workspace_idx
on public.client_task_templates(workspace_id);

create trigger client_task_templates_touch_updated_at
before update on public.client_task_templates
for each row execute function public.touch_updated_at();

create or replace function public.validate_client_task_template()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.clients
    where id = new.client_id and workspace_id = new.workspace_id
  ) then
    raise exception 'The template client does not belong to this workspace';
  end if;

  if new.assignee_id is not null and not exists (
    select 1 from public.workspace_members
    where workspace_id = new.workspace_id and user_id = new.assignee_id
  ) then
    raise exception 'The template assignee is not a workspace member';
  end if;

  return new;
end;
$$;

create trigger client_task_templates_validate
before insert or update of client_id, workspace_id, assignee_id
on public.client_task_templates
for each row execute function public.validate_client_task_template();

alter table public.client_task_templates enable row level security;

create policy "admins view client task templates" on public.client_task_templates
for select to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

create policy "admins create client task templates" on public.client_task_templates
for insert to authenticated
with check (
  created_by = auth.uid()
  and public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
);

create policy "admins update client task templates" on public.client_task_templates
for update to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
with check (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

create policy "admins delete client task templates" on public.client_task_templates
for delete to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

revoke all on table public.client_task_templates from anon, authenticated;
grant select, insert, update, delete on table public.client_task_templates to authenticated;

revoke all on function public.validate_client_task_template() from public, anon, authenticated;
