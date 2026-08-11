-- Add collaborator availability and expose profile details only to members of
-- the same workspace. E-mail addresses remain behind this controlled RPC.

alter table public.profiles
add column if not exists availability text not null default 'available'
check (availability in ('available', 'busy', 'away'));

update public.profiles as profile
set avatar_url = coalesce(
  profile.avatar_url,
  users.raw_user_meta_data ->> 'avatar_url',
  users.raw_user_meta_data ->> 'picture'
)
from auth.users as users
where users.id = profile.id
  and profile.avatar_url is null;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(
      new.raw_user_meta_data ->> 'avatar_url',
      new.raw_user_meta_data ->> 'picture'
    )
  );
  return new;
end;
$$;

create or replace function public.shares_workspace_with(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members as current_membership
    join public.workspace_members as target_membership
      on target_membership.workspace_id = current_membership.workspace_id
    where current_membership.user_id = auth.uid()
      and target_membership.user_id = target_user
  );
$$;

drop policy if exists "profiles are visible to authenticated users" on public.profiles;
drop policy if exists "users view shared workspace profiles" on public.profiles;

create policy "users view shared workspace profiles" on public.profiles
for select to authenticated
using (id = auth.uid() or public.shares_workspace_with(id));

create or replace function public.get_workspace_member_profiles(target_workspace uuid)
returns table (
  user_id uuid,
  display_name text,
  avatar_url text,
  availability text,
  email text,
  role public.workspace_role
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_workspace_member(target_workspace) then
    raise exception 'Workspace access denied';
  end if;

  return query
  select
    membership.user_id,
    profile.display_name,
    profile.avatar_url,
    profile.availability,
    users.email::text,
    membership.role
  from public.workspace_members as membership
  join public.profiles as profile on profile.id = membership.user_id
  join auth.users as users on users.id = membership.user_id
  where membership.workspace_id = target_workspace
  order by
    case membership.role when 'owner' then 1 when 'admin' then 2 else 3 end,
    lower(profile.display_name),
    users.email;
end;
$$;

revoke all on function public.get_workspace_member_profiles(uuid) from public;
revoke all on function public.shares_workspace_with(uuid) from public;
grant execute on function public.get_workspace_member_profiles(uuid) to authenticated;
grant execute on function public.shares_workspace_with(uuid) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;
end;
$$;
