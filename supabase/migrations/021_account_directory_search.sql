-- Let workspace owners and admins find existing EditFlow accounts while
-- composing an invitation. The protected auth.users table remains private:
-- only this limited, role-checked search function can expose matching rows.

create or replace function public.search_editflow_accounts(
  target_workspace uuid,
  search_query text,
  result_limit integer default 8
)
returns table (
  user_id uuid,
  display_name text,
  email text,
  avatar_url text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_query text := lower(trim(coalesce(search_query, '')));
  limited_results integer := least(greatest(coalesce(result_limit, 8), 1), 8);
begin
  if auth.uid() is null or not public.has_workspace_role(
    target_workspace,
    array['owner', 'admin']::public.workspace_role[]
  ) then
    raise exception 'Only workspace owners and admins can search accounts';
  end if;

  -- Avoid broad directory enumeration from empty or one-character searches.
  if char_length(normalized_query) < 2 then
    return;
  end if;

  return query
  select
    users.id,
    coalesce(
      nullif(trim(profile.display_name), ''),
      split_part(users.email::text, '@', 1)
    ) as display_name,
    users.email::text,
    profile.avatar_url
  from auth.users as users
  join public.profiles as profile on profile.id = users.id
  where users.email is not null
    and users.deleted_at is null
    and not exists (
      select 1
      from public.workspace_members as membership
      where membership.workspace_id = target_workspace
        and membership.user_id = users.id
    )
    and not exists (
      select 1
      from public.workspace_invitations as invitation
      where invitation.workspace_id = target_workspace
        and invitation.status = 'pending'
        and invitation.expires_at > now()
        and invitation.email = lower(users.email::text)
    )
    and (
      position(normalized_query in lower(users.email::text)) > 0
      or position(normalized_query in lower(profile.display_name)) > 0
    )
  order by
    case
      when lower(users.email::text) = normalized_query then 0
      when lower(profile.display_name) = normalized_query then 1
      when lower(users.email::text) like normalized_query || '%' then 2
      when lower(profile.display_name) like normalized_query || '%' then 3
      else 4
    end,
    lower(coalesce(nullif(trim(profile.display_name), ''), users.email::text)),
    users.id
  limit limited_results;
end;
$$;

revoke all on function public.search_editflow_accounts(uuid, text, integer)
from public, anon, authenticated;

grant execute on function public.search_editflow_accounts(uuid, text, integer)
to authenticated;
