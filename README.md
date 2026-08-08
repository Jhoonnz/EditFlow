# EditFlow

Aplicativo desktop para organizar o fluxo de produção de equipes de edição.

## Recursos atuais

- Login por e-mail com Supabase Auth
- Criação do workspace e quadro padrão no primeiro acesso
- Kanban com drag-and-drop entre etapas
- Cadastro de clientes, prioridades e prazos
- Links externos para download, briefing, revisão e entrega
- Sincronização em tempo real entre computadores

## Stack

- Electron + Electron Forge para desenvolvimento
- electron-builder + NSIS para o instalador do Windows
- React + TypeScript + Vite
- Supabase Auth, PostgreSQL e Realtime

## Configuração local

1. Instale o Node.js LTS.
2. Copie `.env.example` para `.env`.
3. Preencha a URL e a chave pública do seu projeto Supabase.
4. Execute a migration `supabase/migrations/001_initial.sql` no SQL Editor do Supabase.
5. Instale e rode o app:

```powershell
npm install
npm start
```

## Comandos

```powershell
npm run typecheck
npm run package
npm run make
```

O comando `npm run make` gera o instalador assistido do Windows dentro da pasta `release`.

O instalador NSIS permite escolher o local de instalação, mostra o progresso, cria atalhos e oferece a opção de executar o EditFlow ao terminar.

## Segurança

- Nunca coloque a chave `service_role` no `.env` do aplicativo.
- Use somente a chave pública/publishable do Supabase.
- O Electron mantém `nodeIntegration` desabilitado, `contextIsolation` e sandbox habilitados.
- Links externos são limitados ao protocolo HTTPS.
