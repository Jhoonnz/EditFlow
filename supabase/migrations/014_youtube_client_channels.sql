-- Store public YouTube channel information for each client. The data is
-- refreshed by the authenticated sync-youtube-channel Edge Function.

alter table public.clients
add column if not exists youtube_channel_url text,
add column if not exists youtube_channel_id text,
add column if not exists youtube_channel_title text,
add column if not exists youtube_thumbnail_url text,
add column if not exists youtube_subscriber_count bigint,
add column if not exists youtube_average_views bigint,
add column if not exists youtube_uploads_per_month numeric(10, 2),
add column if not exists youtube_video_count bigint,
add column if not exists youtube_last_synced_at timestamptz;

alter table public.clients
drop constraint if exists clients_youtube_channel_url_check;

alter table public.clients
add constraint clients_youtube_channel_url_check check (
  youtube_channel_url is null
  or youtube_channel_url ~* '^https://([a-z0-9-]+[.])?youtube[.]com/'
);

alter table public.clients
drop constraint if exists clients_youtube_counts_check;

alter table public.clients
add constraint clients_youtube_counts_check check (
  coalesce(youtube_subscriber_count, 0) >= 0
  and coalesce(youtube_average_views, 0) >= 0
  and coalesce(youtube_uploads_per_month, 0) >= 0
  and coalesce(youtube_video_count, 0) >= 0
);

create index if not exists clients_youtube_channel_id_idx
on public.clients(youtube_channel_id)
where youtube_channel_id is not null;
