import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type ChannelItem = {
  id: string;
  snippet?: {
    title?: string;
    customUrl?: string;
    thumbnails?: Record<string, { url?: string }>;
  };
  statistics?: {
    subscriberCount?: string;
    hiddenSubscriberCount?: boolean;
    videoCount?: string;
  };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
};

type PlaylistItem = {
  contentDetails?: { videoId?: string; videoPublishedAt?: string };
  snippet?: { publishedAt?: string };
};

type VideoItem = {
  id: string;
  statistics?: { viewCount?: string };
  snippet?: { publishedAt?: string };
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
});

const youtubeRequest = async <T>(path: string, params: URLSearchParams, apiKey: string) => {
  params.set('key', apiKey);
  const response = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${params.toString()}`);
  const payload = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || `YouTube retornou o status ${response.status}.`);
  return payload;
};

const channelFilter = (rawUrl: string) => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Informe um link válido do canal do YouTube.');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^(www|m|music)[.]/, '');
  if (parsed.protocol !== 'https:' || hostname !== 'youtube.com') {
    throw new Error('Use um link HTTPS do youtube.com.');
  }

  const segments = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments[0]?.startsWith('@')) return { name: 'forHandle', value: segments[0] };
  if (segments[0] === 'channel' && segments[1]) return { name: 'id', value: segments[1] };
  if (segments[0] === 'user' && segments[1]) return { name: 'forUsername', value: segments[1] };
  throw new Error('Use o link no formato youtube.com/@canal ou youtube.com/channel/UC...');
};

const safeInteger = (value?: string) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Método não permitido.' }, 405);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const legacyPublishableKey = Deno.env.get('SUPABASE_ANON_KEY');
    const publishableKeys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}') as Record<string, string>;
    const publishableKey = publishableKeys.default || legacyPublishableKey;
    const youtubeApiKey = Deno.env.get('YOUTUBE_API_KEY');
    const authorization = request.headers.get('Authorization');

    if (!supabaseUrl || !publishableKey) return json({ error: 'O ambiente do Supabase não está configurado.' }, 500);
    if (!youtubeApiKey) return json({ error: 'O segredo YOUTUBE_API_KEY ainda não foi configurado no Supabase.' }, 503);
    if (!authorization) return json({ error: 'Faça login novamente para atualizar o canal.' }, 401);

    const caller = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userResult, error: userError } = await caller.auth.getUser();
    if (userError || !userResult.user) return json({ error: 'Sessão inválida ou expirada.' }, 401);

    const body = await request.json() as { clientId?: string };
    if (!body.clientId) return json({ error: 'Cliente não informado.' }, 400);

    const { data: client, error: clientError } = await caller
      .from('clients')
      .select('id, workspace_id, youtube_channel_url')
      .eq('id', body.clientId)
      .single();
    if (clientError || !client) return json({ error: 'Cliente não encontrado ou sem acesso.' }, 404);

    const { data: membership } = await caller
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', client.workspace_id)
      .eq('user_id', userResult.user.id)
      .maybeSingle();
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      return json({ error: 'Somente proprietários e administradores podem atualizar o canal.' }, 403);
    }
    if (!client.youtube_channel_url) return json({ error: 'Adicione primeiro o link do canal.' }, 400);

    const filter = channelFilter(client.youtube_channel_url);
    const channelParams = new URLSearchParams({ part: 'snippet,statistics,contentDetails' });
    channelParams.set(filter.name, filter.value);
    const channelPayload = await youtubeRequest<{ items?: ChannelItem[] }>('channels', channelParams, youtubeApiKey);
    const channel = channelPayload.items?.[0];
    if (!channel) return json({ error: 'Nenhum canal foi encontrado nesse link.' }, 404);

    const uploadsPlaylist = channel.contentDetails?.relatedPlaylists?.uploads;
    let videos: VideoItem[] = [];
    if (uploadsPlaylist) {
      const playlistPayload = await youtubeRequest<{ items?: PlaylistItem[] }>('playlistItems', new URLSearchParams({
        part: 'contentDetails,snippet',
        playlistId: uploadsPlaylist,
        maxResults: '12',
      }), youtubeApiKey);
      const videoIds = (playlistPayload.items ?? []).map((item) => item.contentDetails?.videoId).filter((id): id is string => Boolean(id));
      if (videoIds.length) {
        const videoPayload = await youtubeRequest<{ items?: VideoItem[] }>('videos', new URLSearchParams({
          part: 'snippet,statistics',
          id: videoIds.join(','),
        }), youtubeApiKey);
        videos = videoPayload.items ?? [];
      }
    }

    const viewCounts = videos.map((video) => safeInteger(video.statistics?.viewCount)).filter((views): views is number => views !== null);
    const averageViews = viewCounts.length ? Math.round(viewCounts.reduce((sum, views) => sum + views, 0) / viewCounts.length) : null;
    const publishTimes = videos
      .map((video) => new Date(video.snippet?.publishedAt || '').getTime())
      .filter(Number.isFinite)
      .sort((a, b) => b - a);
    const spanDays = publishTimes.length > 1 ? (publishTimes[0] - publishTimes[publishTimes.length - 1]) / 86_400_000 : 0;
    const uploadsPerMonth = spanDays > 0 ? Math.round((((publishTimes.length - 1) * 30.4375) / spanDays) * 100) / 100 : null;
    const subscriberCount = channel.statistics?.hiddenSubscriberCount ? null : safeInteger(channel.statistics?.subscriberCount);
    const customUrl = channel.snippet?.customUrl;
    const canonicalUrl = customUrl?.startsWith('@')
      ? `https://www.youtube.com/${customUrl}`
      : `https://www.youtube.com/channel/${channel.id}`;
    const thumbnails = channel.snippet?.thumbnails;
    const thumbnailUrl = thumbnails?.high?.url || thumbnails?.medium?.url || thumbnails?.default?.url || null;

    const channelData = {
      youtube_channel_url: canonicalUrl,
      youtube_channel_id: channel.id,
      youtube_channel_title: channel.snippet?.title || null,
      youtube_thumbnail_url: thumbnailUrl,
      youtube_subscriber_count: subscriberCount,
      youtube_average_views: averageViews,
      youtube_uploads_per_month: uploadsPerMonth,
      youtube_video_count: safeInteger(channel.statistics?.videoCount),
      youtube_last_synced_at: new Date().toISOString(),
    };
    const { error: updateError } = await caller.from('clients').update(channelData).eq('id', client.id);
    if (updateError) throw new Error(updateError.message);

    return json({ channel: channelData, sampledVideos: viewCounts.length });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : 'Não foi possível atualizar o canal.' }, 400);
  }
});
