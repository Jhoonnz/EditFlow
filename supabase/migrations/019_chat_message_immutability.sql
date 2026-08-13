-- Chat messages are intentionally immutable in the EditFlow interface.
-- Enforce the same rule at the API layer so removed edit/delete controls
-- cannot be bypassed with a direct REST request.

drop policy if exists "authors edit own chat messages" on public.chat_messages;
drop policy if exists "authors delete own chat messages" on public.chat_messages;

revoke update, delete on table public.chat_messages from authenticated;
grant select, insert on table public.chat_messages to authenticated;

drop trigger if exists chat_messages_enforce_update on public.chat_messages;
drop trigger if exists chat_messages_handle_delete on public.chat_messages;

drop function if exists public.enforce_chat_message_update();
drop function if exists public.handle_chat_message_delete();
