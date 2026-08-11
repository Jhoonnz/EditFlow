-- Determine first access from the permanent first-open marker, not only from
-- the previous-open timestamp. This also repairs the returned previous access
-- when an older profile has first_app_opened_at but a null last_app_opened_at.

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
  first_access timestamptz;
  previous_access timestamptz;
  current_access timestamptz := now();
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  select
    profile.first_app_opened_at,
    profile.last_app_opened_at
  into first_access, previous_access
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

  return query select
    first_access is null,
    coalesce(previous_access, first_access),
    current_access;
end;
$$;

revoke all on function public.record_app_open() from public;
grant execute on function public.record_app_open() to authenticated;
