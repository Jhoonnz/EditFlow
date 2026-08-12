# Funções do EditFlow

## Sincronização de canais do YouTube

Depois de executar a migration `014_youtube_client_channels.sql`:

1. Ative a YouTube Data API v3 em um projeto do Google Cloud e crie uma API key.
2. No Supabase, abra **Edge Functions > Secrets** e crie `YOUTUBE_API_KEY`.
3. Publique a função:

```powershell
npx supabase login
npx supabase link --project-ref bcnozabyyerugfehdxpx
npx supabase functions deploy sync-youtube-channel
```

A chave do YouTube deve existir somente nos secrets do Supabase. Nunca coloque
essa chave no `.env` do Electron ou nos secrets usados durante o build público.
