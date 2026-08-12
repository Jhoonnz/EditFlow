-- Workspace chat with one general channel and private conversations.
-- General messages are visible to workspace members. Direct messages are
-- visible only to the two participants, including through the REST API.

create table if not exists public.chat_conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in ('general', 'direct')),
  title text,
  direct_key text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (kind = 'general' and direct_key is null)
    or (kind = 'direct' and direct_key is not null)
  )
);

create unique index if not exists chat_conversations_general_workspace_idx
on public.chat_conversations(workspace_id)
where kind = 'general';

create unique index if not exists chat_conversations_direct_key_idx
on public.chat_conversations(workspace_id, direct_key)
where kind = 'direct';

create index if not exists chat_conversations_workspace_updated_idx
on public.chat_conversations(workspace_id, updated_at desc);

create table if not exists public.chat_conversation_members (
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  last_read_at timestamptz,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create index if not exists chat_conversation_members_user_idx
on public.chat_conversation_members(user_id, workspace_id);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  sender_id uuid not null references public.profiles(id),
  body text not null check (char_length(trim(body)) between 1 and 4000),
  edited_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_conversation_created_idx
on public.chat_messages(conversation_id, created_at desc);

create index if not exists chat_messages_workspace_created_idx
on public.chat_messages(workspace_id, created_at desc);

-- Create the general conversation for existing workspaces and include every
-- current member so read positions can be tracked independently.
insert into public.chat_conversations (workspace_id, kind, title, created_by)
select workspace.id, 'general', 'Geral', workspace.owner_id
from public.workspaces as workspace
on conflict do nothing;

insert into public.chat_conversation_members (conversation_id, workspace_id, user_id)
select conversation.id, membership.workspace_id, membership.user_id
from public.workspace_members as membership
join public.chat_conversations as conversation
  on conversation.workspace_id = membership.workspace_id
 and conversation.kind = 'general'
on conflict do nothing;

create or replace function public.can_access_chat_conversation(target_conversation uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.chat_conversations as conversation
    where conversation.id = target_conversation
      and public.is_workspace_member(conversation.workspace_id)
      and (
        conversation.kind = 'general'
        or exists (
          select 1
          from public.chat_conversation_members as participant
          where participant.conversation_id = conversation.id
            and participant.user_id = auth.uid()
        )
      )
  );
$$;

create or replace function public.get_or_create_general_chat(target_workspace uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_id uuid;
begin
  if auth.uid() is null or not public.is_workspace_member(target_workspace) then
    raise exception 'Workspace access denied';
  end if;

  select id into conversation_id
  from public.chat_conversations
  where workspace_id = target_workspace and kind = 'general';

  if conversation_id is null then
    insert into public.chat_conversations (workspace_id, kind, title, created_by)
    values (target_workspace, 'general', 'Geral', auth.uid())
    on conflict do nothing;

    select id into conversation_id
    from public.chat_conversations
    where workspace_id = target_workspace and kind = 'general';
  end if;

  insert into public.chat_conversation_members (conversation_id, workspace_id, user_id)
  values (conversation_id, target_workspace, auth.uid())
  on conflict do nothing;

  return conversation_id;
end;
$$;

create or replace function public.open_direct_chat(
  target_workspace uuid,
  target_user uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_id uuid;
  normalized_key text;
begin
  if auth.uid() is null or not public.is_workspace_member(target_workspace) then
    raise exception 'Workspace access denied';
  end if;

  if target_user = auth.uid() then
    raise exception 'A private conversation requires another member';
  end if;

  if not exists (
    select 1 from public.workspace_members
    where workspace_id = target_workspace and user_id = target_user
  ) then
    raise exception 'The selected user is not a workspace member';
  end if;

  normalized_key := least(auth.uid()::text, target_user::text)
    || ':' || greatest(auth.uid()::text, target_user::text);

  insert into public.chat_conversations (
    workspace_id, kind, direct_key, created_by
  ) values (
    target_workspace, 'direct', normalized_key, auth.uid()
  )
  on conflict (workspace_id, direct_key) where kind = 'direct'
  do update set direct_key = excluded.direct_key
  returning id into conversation_id;

  insert into public.chat_conversation_members (conversation_id, workspace_id, user_id)
  values
    (conversation_id, target_workspace, auth.uid()),
    (conversation_id, target_workspace, target_user)
  on conflict do nothing;

  return conversation_id;
end;
$$;

create or replace function public.sync_general_chat_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_id uuid;
begin
  if tg_op = 'DELETE' then
    delete from public.chat_conversation_members
    where workspace_id = old.workspace_id and user_id = old.user_id;
    return old;
  end if;

  select id into conversation_id
  from public.chat_conversations
  where workspace_id = new.workspace_id and kind = 'general';

  if conversation_id is null then
    insert into public.chat_conversations (workspace_id, kind, title, created_by)
    values (new.workspace_id, 'general', 'Geral', new.user_id)
    on conflict do nothing;

    select id into conversation_id
    from public.chat_conversations
    where workspace_id = new.workspace_id and kind = 'general';
  end if;

  insert into public.chat_conversation_members (conversation_id, workspace_id, user_id)
  values (conversation_id, new.workspace_id, new.user_id)
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists workspace_members_sync_general_chat on public.workspace_members;
create trigger workspace_members_sync_general_chat
after insert or delete on public.workspace_members
for each row execute function public.sync_general_chat_membership();

create or replace function public.enforce_chat_read_position_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.conversation_id is distinct from old.conversation_id
     or new.workspace_id is distinct from old.workspace_id
     or new.user_id is distinct from old.user_id
     or new.joined_at is distinct from old.joined_at then
    raise exception 'Only the read position can be updated';
  end if;
  return new;
end;
$$;

drop trigger if exists chat_conversation_members_enforce_update on public.chat_conversation_members;
create trigger chat_conversation_members_enforce_update
before update on public.chat_conversation_members
for each row execute function public.enforce_chat_read_position_update();

create or replace function public.prepare_chat_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_workspace uuid;
begin
  select workspace_id into target_workspace
  from public.chat_conversations
  where id = new.conversation_id;

  if target_workspace is null or target_workspace <> new.workspace_id then
    raise exception 'The conversation does not belong to this workspace';
  end if;

  if new.sender_id <> auth.uid() or not public.can_access_chat_conversation(new.conversation_id) then
    raise exception 'Conversation access denied';
  end if;

  new.body := trim(new.body);
  return new;
end;
$$;

drop trigger if exists chat_messages_prepare on public.chat_messages;
create trigger chat_messages_prepare
before insert on public.chat_messages
for each row execute function public.prepare_chat_message();

create or replace function public.enforce_chat_message_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.sender_id <> auth.uid()
     or new.sender_id is distinct from old.sender_id
     or new.workspace_id is distinct from old.workspace_id
     or new.conversation_id is distinct from old.conversation_id
     or new.created_at is distinct from old.created_at then
    raise exception 'Only the message body can be edited by its author';
  end if;

  new.body := trim(new.body);
  new.edited_at := now();
  return new;
end;
$$;

drop trigger if exists chat_messages_enforce_update on public.chat_messages;
create trigger chat_messages_enforce_update
before update on public.chat_messages
for each row execute function public.enforce_chat_message_update();

create or replace function public.handle_chat_message_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  sender_name text;
  conversation_kind text;
begin
  update public.chat_conversations
  set updated_at = now()
  where id = new.conversation_id;

  select coalesce(nullif(trim(profile.display_name), ''), 'Um membro')
  into sender_name
  from public.profiles as profile
  where profile.id = new.sender_id;

  select kind into conversation_kind
  from public.chat_conversations
  where id = new.conversation_id;

  insert into public.notifications (
    workspace_id, user_id, actor_id, type, message, conversation_id
  )
  select
    new.workspace_id,
    recipient.user_id,
    new.sender_id,
    'chat_message',
    case when conversation_kind = 'general' then 'Geral · ' else '' end
      || coalesce(sender_name, 'Um membro') || ': '
      || left(new.body, 320),
    new.conversation_id
  from (
    select membership.user_id
    from public.workspace_members as membership
    where conversation_kind = 'general'
      and membership.workspace_id = new.workspace_id
    union
    select participant.user_id
    from public.chat_conversation_members as participant
    where conversation_kind = 'direct'
      and participant.conversation_id = new.conversation_id
  ) as recipient
  where recipient.user_id <> new.sender_id;

  return new;
end;
$$;

-- Connect chat notifications to the existing inbox and native alerts.
alter table public.notifications
add column if not exists conversation_id uuid references public.chat_conversations(id) on delete set null;

alter table public.notifications
drop constraint if exists notifications_type_check;

alter table public.notifications
add constraint notifications_type_check check (
  type in (
    'assignment',
    'comment',
    'change_request',
    'task_updated',
    'task_moved',
    'invite_accepted',
    'chat_message'
  )
);

drop trigger if exists chat_messages_handle_event on public.chat_messages;
create trigger chat_messages_handle_event
after insert on public.chat_messages
for each row execute function public.handle_chat_message_event();

create or replace function public.handle_chat_message_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.chat_conversations
  set updated_at = now()
  where id = old.conversation_id;
  return old;
end;
$$;

drop trigger if exists chat_messages_handle_delete on public.chat_messages;
create trigger chat_messages_handle_delete
after delete on public.chat_messages
for each row execute function public.handle_chat_message_delete();

-- Include the conversation id in DELETE events so every open client can
-- refresh the correct room when an author removes a message.
alter table public.chat_messages replica identity full;

alter table public.chat_conversations enable row level security;
alter table public.chat_conversation_members enable row level security;
alter table public.chat_messages enable row level security;

drop policy if exists "members view accessible chat conversations" on public.chat_conversations;
create policy "members view accessible chat conversations" on public.chat_conversations
for select to authenticated
using (public.can_access_chat_conversation(id));

drop policy if exists "members view accessible chat participants" on public.chat_conversation_members;
create policy "members view accessible chat participants" on public.chat_conversation_members
for select to authenticated
using (public.can_access_chat_conversation(conversation_id));

drop policy if exists "members update own chat read position" on public.chat_conversation_members;
create policy "members update own chat read position" on public.chat_conversation_members
for update to authenticated
using (user_id = auth.uid() and public.can_access_chat_conversation(conversation_id))
with check (user_id = auth.uid() and public.can_access_chat_conversation(conversation_id));

drop policy if exists "members view accessible chat messages" on public.chat_messages;
create policy "members view accessible chat messages" on public.chat_messages
for select to authenticated
using (public.can_access_chat_conversation(conversation_id));

drop policy if exists "members send accessible chat messages" on public.chat_messages;
create policy "members send accessible chat messages" on public.chat_messages
for insert to authenticated
with check (
  sender_id = auth.uid()
  and public.can_access_chat_conversation(conversation_id)
);

drop policy if exists "authors edit own chat messages" on public.chat_messages;
create policy "authors edit own chat messages" on public.chat_messages
for update to authenticated
using (sender_id = auth.uid() and public.can_access_chat_conversation(conversation_id))
with check (sender_id = auth.uid() and public.can_access_chat_conversation(conversation_id));

drop policy if exists "authors delete own chat messages" on public.chat_messages;
create policy "authors delete own chat messages" on public.chat_messages
for delete to authenticated
using (sender_id = auth.uid() and public.can_access_chat_conversation(conversation_id));

revoke all on table public.chat_conversations from anon, authenticated;
revoke all on table public.chat_conversation_members from anon, authenticated;
revoke all on table public.chat_messages from anon, authenticated;

grant select on table public.chat_conversations to authenticated;
grant select, update on table public.chat_conversation_members to authenticated;
grant select, insert, update, delete on table public.chat_messages to authenticated;

revoke all on function public.can_access_chat_conversation(uuid) from public;
revoke all on function public.get_or_create_general_chat(uuid) from public;
revoke all on function public.open_direct_chat(uuid, uuid) from public;

grant execute on function public.can_access_chat_conversation(uuid) to authenticated;
grant execute on function public.get_or_create_general_chat(uuid) to authenticated;
grant execute on function public.open_direct_chat(uuid, uuid) to authenticated;

-- Realtime publication changes are intentionally kept in
-- 018_realtime_reliability.sql so this schema migration does not compete
-- with active replication sessions for publication locks.
