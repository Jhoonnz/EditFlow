# Kanban — correções e validação

## Implantação

1. Fechar as instâncias do EditFlow durante a troca de versão.
2. Executar `supabase/migrations/029_kanban_reliability.sql` no SQL Editor.
3. Executar `031_client_review_deadlines.sql` e instalar o app 0.1.59. Clientes antigos não podem mais enviar a ordenação inteira do quadro: a RPC antiga recusa a operação com uma mensagem de atualização obrigatória.
4. Para alertas de inatividade mesmo com o app fechado, habilitar Supabase Cron e executar `supabase/migrations/030_schedule_board_alerts.sql`.
5. Conferir o job `editflow-board-inactivity` e seu histórico de execução. A agenda usa intervalo de 10 minutos. Sem a 030, a verificação com o aplicativo visível continua funcionando.
6. A migration 031 depende da 029, mas não do Cron (030).

Referência do agendamento: https://supabase.com/docs/guides/cron/quickstart

O usuário informou a aplicação no Supabase antes de autorizar a publicação da 0.1.59. Esta validação automatizada usa banco local em memória, não verifica o estado do banco de produção.

## Mudanças

- Movimento individual com bloqueio por quadro e comparação de versão da tarefa; desfazer disponível por 15 segundos, também sujeito a conflito e requisitos de links.
- A RPC de ordenação antiga recusa snapshots completos, evitando sobrescrita por versões antigas do desktop.
- Coluna final preservada: novas colunas entram antes dela, e reorganizações que a tirem do fim são recusadas. O histórico consulta tarefas concluídas ou arquivadas, não somente a coluna atual.
- Custo de edição observa mudanças reais de conclusão, inclusive as feitas por outro trigger.
- Exclusão de tarefa com ganhos/custos associados é bloqueada. Arquivamento continua disponível.
- Edição envia apenas campos modificados, usando a versão original como condição de atualização; o rascunho é mantido quando há conflito.
- Arquivos de tarefas arquivadas são buscados ao abrir a tarefa. O histórico é buscado ao abri-lo ou quando uma tela de resumo precisa dos dados. Cards ativos e histórico usam carregamento visual progressivo.
- Filtros de atrasadas, hoje, sem responsável, urgentes e bloqueadas; busca sem distinção de acentos; arrastar permitido com filtros.
- Duplicação com links opcionais, sem copiar prazo, conclusão, ganhos ou histórico. A nova tarefa passa pelas automações normais da etapa inicial.
- Impedimento opcional e limite sugerido por etapa (somente proprietário), sem bloquear movimentação por lotação.
- Títulos maiores, áreas clicáveis maiores, prioridade alta/urgente e identificação do fluxo sem porcentagem de trabalho fictícia.
- Proteção de rascunhos de feedback, link e modelo; confirmação para remoção de link; endereços HTTP normalizados para HTTPS.
- Alertas usam atividade real, não simples reordenação. Execução no servidor usa função interna sem acesso REST de usuários.
- Troca de equipe recria o painel, evitando reuso de estado da equipe anterior.

## Verificado automaticamente

- TypeScript.
- 52 testes em 12 arquivos, incluindo 15 testes com PostgreSQL em memória (PGlite).
- Todas as migrations 001–029 e 031 são aplicadas pelo teste; somente os schemas de autenticação/storage do provedor são simulados, e a extensão pgcrypto é dispensada por gen_random_uuid ser nativa.
- Criação de equipe, movimento, versão antiga, edição concorrente via comparação de versão, conclusão/reabertura, custos/ganhos, arquivamento/restauração, preservação da última coluna, exclusão financeira, duplicação com/sem links, permissões, requisitos de links, início único, limite, configuração atômica e alertas sem duplicação.
- Build de produção da interface.

## Ainda conferir em ambiente de teste antes da publicação

- Layout claro/escuro e escala de 125%/150%, especialmente cabeçalho com limite e cards com título longo.
- Duas instâncias desktop simultâneas, atraso de rede e reconexão; o PGlite testa rejeição de versão antiga, mas não reproduz conexões PostgreSQL concorrentes nem transporte Realtime.
- ESC/Tab, clique fora, confirmação de rascunhos e seleção de responsável com mouse/teclado.
- Instalação do Cron e execução real do job no Supabase (não disponível no PostgreSQL em memória).
- O build emite aviso sobre tamanho de bundle. A instalação da dependência de teste também sinalizou vulnerabilidades na árvore npm; não foi executado `npm audit fix` automaticamente.

## Envio para revisão do cliente

Após autorização, foi adicionada a opção “Envio para revisão do cliente” às automações de qualquer coluna não final. Somente o proprietário pode configurá-la. O primeiro envio guarda data, prazo original e pontualidade (dias inteiros no horário de Brasília); editar o prazo depois não reescreve esse resultado.

Enquanto nessa coluna, o card mostra “Aguardando cliente”, com a pontualidade no tooltip e nos detalhes/histórico. Em alterações, mantém “Enviado no prazo”, “Enviado com atraso” ou “Enviado sem prazo”, sem reiniciar atraso e sem exigir nova data. Reenvios são registrados no histórico; o primeiro envio é imutável. Desativar a opção não apaga registros.

Tarefas enviadas deixam os contadores/filtros de atraso ativo e alertas de prazo no Kanban, Meu trabalho, perfil, boas-vindas e notificações. Atraso no primeiro envio continua documentado; conclusão, ganhos e custos só ocorrem na etapa final. Alertas de inatividade continuam independentes, conforme a configuração da coluna.

Não há backfill de envio: ativar a opção não marca tarefas já na coluna como enviadas hoje. A próxima entrada real registra o envio. Duplicação não copia esse registro. Testes cobrem ida/volta/reenvio/conclusão, data original, ausência de prazo, permissões, falsificação do snapshot e configuração sem retroatividade. Ainda conferir visualmente nos dois temas e em duas instâncias desktop antes de publicar.
