-- Enrich internal member profiles and provide a dedicated, user-owned bucket
-- for avatar images. Professional links intentionally remain out of scope.

alter table public.profiles
add column if not exists specialty text not null default ''
check (char_length(specialty) <= 80),
add column if not exists bio text not null default ''
check (char_length(bio) <= 500);

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'profile-avatars',
  'profile-avatars',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "users upload own profile avatars" on storage.objects;
create policy "users upload own profile avatars" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'profile-avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "users update own profile avatars" on storage.objects;
create policy "users update own profile avatars" on storage.objects
for update to authenticated
using (
  bucket_id = 'profile-avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'profile-avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "users delete own profile avatars" on storage.objects;
create policy "users delete own profile avatars" on storage.objects
for delete to authenticated
using (
  bucket_id = 'profile-avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop function if exists public.get_workspace_member_profiles(uuid);

create function public.get_workspace_member_profiles(target_workspace uuid)
returns table (
  user_id uuid,
  display_name text,
  avatar_url text,
  availability text,
  specialty text,
  bio text,
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
    profile.specialty,
    profile.bio,
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
grant execute on function public.get_workspace_member_profiles(uuid) to authenticated;
