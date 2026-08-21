-- Structured chat mentions. Each message stores a validated snapshot of the
-- mentioned member IDs and names so the UI can highlight them and open the
-- correct profile without relying on ambiguous plain-text parsing.

alter table public.chat_messages
add column if not exists mentions jsonb not null default '[]'::jsonb;

alter table public.chat_messages
drop constraint if exists chat_messages_mentions_check;

alter table public.chat_messages
add constraint chat_messages_mentions_check
check (
  case
    when jsonb_typeof(mentions) = 'array' then jsonb_array_length(mentions) <= 20
    else false
  end
);

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
    'chat_message',
    'chat_mention'
  )
);

create or replace function public.prepare_chat_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_workspace uuid;
  conversation_kind text;
begin
  select workspace_id, kind
  into target_workspace, conversation_kind
  from public.chat_conversations
  where id = new.conversation_id;

  if target_workspace is null or target_workspace <> new.workspace_id then
    raise exception 'The conversation does not belong to this workspace';
  end if;

  if new.sender_id <> auth.uid() or not public.can_access_chat_conversation(new.conversation_id) then
    raise exception 'Conversation access denied';
  end if;

  new.body := trim(new.body);
  new.mentions := coalesce(new.mentions, '[]'::jsonb);

  if jsonb_typeof(new.mentions) <> 'array' then
    raise exception 'Invalid chat mentions';
  end if;

  if jsonb_array_length(new.mentions) > 20 then
    raise exception 'Invalid chat mentions';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(new.mentions) as mention(value)
    where jsonb_typeof(mention.value) <> 'object'
       or coalesce(mention.value ->> 'user_id', '') !~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
       or char_length(trim(coalesce(mention.value ->> 'label', ''))) not between 1 and 80
  ) then
    raise exception 'Invalid chat mention data';
  end if;

  if (
    select count(*) <> count(distinct mention.value ->> 'user_id')
    from jsonb_array_elements(new.mentions) as mention(value)
  ) then
    raise exception 'Duplicate chat mentions are not allowed';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(new.mentions) as mention(value)
    where (mention.value ->> 'user_id')::uuid = auth.uid()
       or not exists (
         select 1
         from public.workspace_members as membership
         where membership.workspace_id = new.workspace_id
           and membership.user_id = (mention.value ->> 'user_id')::uuid
       )
       or (
         conversation_kind = 'direct'
         and not exists (
           select 1
           from public.chat_conversation_members as participant
           where participant.conversation_id = new.conversation_id
             and participant.user_id = (mention.value ->> 'user_id')::uuid
         )
       )
  ) then
    raise exception 'A mentioned user cannot access this conversation';
  end if;

  -- Replace client-provided labels with the current profile names.
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'user_id', membership.user_id,
        'label', coalesce(nullif(trim(profile.display_name), ''), 'Membro')
      )
      order by requested.position
    ),
    '[]'::jsonb
  )
  into new.mentions
  from jsonb_array_elements(new.mentions) with ordinality as requested(value, position)
  join public.workspace_members as membership
    on membership.workspace_id = new.workspace_id
   and membership.user_id = (requested.value ->> 'user_id')::uuid
  join public.profiles as profile on profile.id = membership.user_id;

  return new;
end;
$$;

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
    case
      when exists (
        select 1
        from jsonb_array_elements(new.mentions) as mention(value)
        where mention.value ->> 'user_id' = recipient.user_id::text
      ) then 'chat_mention'
      else 'chat_message'
    end,
    case
      when exists (
        select 1
        from jsonb_array_elements(new.mentions) as mention(value)
        where mention.value ->> 'user_id' = recipient.user_id::text
      ) then coalesce(sender_name, 'Um membro') || ' mencionou você'
        || case when conversation_kind = 'general' then ' no Geral: ' else ': ' end
        || left(new.body, 260)
      else case when conversation_kind = 'general' then 'Geral · ' else '' end
        || coalesce(sender_name, 'Um membro') || ': '
        || left(new.body, 320)
    end,
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
