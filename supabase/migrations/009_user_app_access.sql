-- Track the first and previous EditFlow access per account so the startup
-- experience can distinguish a new user from someone returning on any device.

alter table public.profiles
add column if not exists first_app_opened_at timestamptz,
add column if not exists last_app_opened_at timestamptz;

create or replace function public.record_app_open()
returns table (
  is_first_access boolean,
  previous_opened_at timestamptz,
  opened_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  previous_access timestamptz;
  current_access timestamptz := now();
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  select profile.last_app_opened_at
  into previous_access
  from public.profiles as profile
  where profile.id = current_user_id
  for update;

  if not found then
    raise exception 'Profile not found';
  end if;

  update public.profiles
  set
    first_app_opened_at = coalesce(first_app_opened_at, current_access),
    last_app_opened_at = current_access
  where id = current_user_id;

  return query select previous_access is null, previous_access, current_access;
end;
$$;

revoke all on function public.record_app_open() from public;
grant execute on function public.record_app_open() to authenticated;
