const escapeHtml = (value: string) => value
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

const shortText = (value: unknown, maxLength: number) => typeof value === 'string' && value.length <= maxLength;
const count = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 10_000;

export function isProductionReport(value: unknown): value is EditFlowProductionReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<EditFlowProductionReport>;
  if (!shortText(report.workspaceName, 120) || !shortText(report.periodLabel, 100)
    || !shortText(report.generatedAt, 100) || !shortText(report.clientFilter, 120)
    || !shortText(report.editorFilter, 120) || !shortText(report.searchFilter, 120)
    || !(['week', 'fortnight', 'month', 'cycle'] as const).includes(report.periodKind as EditFlowProductionReport['periodKind'])
    || !(report.periodKind === 'week' || report.periodKind === 'fortnight'
      ? /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(report.periodKey ?? '')
      : /^\d{4}-(0[1-9]|1[0-2])$/.test(report.periodKey ?? ''))
    || !count(report.total) || !count(report.clientCount) || !count(report.editorCount)
    || !Array.isArray(report.byClient) || !Array.isArray(report.rows)
    || report.byClient.length > 1_000 || report.rows.length !== report.total) return false;
  if (!report.byClient.every((row) => row && shortText(row.name, 160) && count(row.count))) return false;
  if (report.byClient.reduce((sum, row) => sum + row.count, 0) !== report.total) return false;
  return report.rows.every((row) => row && shortText(row.title, 300) && shortText(row.client, 160)
    && shortText(row.editor, 160) && shortText(row.completedAt, 80) && typeof row.archived === 'boolean');
}

export function productionReportHtml(report: EditFlowProductionReport) {
  const clientRows = report.byClient.map((client) => `<div class="client"><strong>${escapeHtml(client.name)}</strong><span>${client.count} ${client.count === 1 ? 'vídeo' : 'vídeos'}</span></div>`).join('');
  const videoRows = report.rows.map((row) => `<tr><td><strong>${escapeHtml(row.title)}</strong>${row.archived ? '<small>Arquivado</small>' : ''}</td><td>${escapeHtml(row.client)}</td><td>${escapeHtml(row.editor)}</td><td>${escapeHtml(row.completedAt)}</td></tr>`).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>
    @page { size: A4 landscape; margin: 13mm 12mm; }
    * { box-sizing: border-box; }
    body { margin: 0; background: white; color: #2d2b38; font: 10px "Segoe UI", Arial, sans-serif; }
    header { display: flex; align-items: flex-end; justify-content: space-between; padding-bottom: 13px; border-bottom: 2px solid #6859d3; }
    h1 { margin: 0 0 3px; font-size: 19px; letter-spacing: -.4px; }
    h2 { margin: 20px 0 10px; font-size: 13px; }
    p { margin: 2px 0; color: #77727f; }
    .period { text-align: right; }.period strong { display: block; color: #5d50bb; font-size: 13px; }
    .summary { display: flex; gap: 10px; margin: 16px 0; }
    .summary article { flex: 1; padding: 12px; border: 1px solid #e3dfef; border-radius: 9px; background: #f6f4fd; }
    .summary span { display: block; margin-bottom: 5px; color: #77717f; font-size: 8px; text-transform: uppercase; letter-spacing: .5px; }
    .summary strong { color: #5144b2; font-size: 20px; }
    .filters { margin: 10px 0 18px; color: #77717f; }
    .clients { display: grid; grid-template-columns: repeat(3,1fr); gap: 7px; }
    .client { display: flex; justify-content: space-between; gap: 10px; padding: 9px 10px; border: 1px solid #e9e6f0; border-radius: 7px; break-inside: avoid; }
    .client span { flex: 0 0 auto; color: #5d50bb; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    thead { display: table-header-group; }
    th { padding: 8px; background: #efedf8; color: #706a82; font-size: 8px; text-align: left; text-transform: uppercase; }
    th:first-child { width: 44%; } th:nth-child(2), th:nth-child(3) { width: 21%; } th:last-child { width: 14%; }
    td { padding: 8px; border-bottom: 1px solid #eceaf0; vertical-align: top; overflow-wrap: anywhere; }
    tbody tr { break-inside: avoid; } td strong { font-weight: 700; } td small { display: block; margin-top: 3px; color: #99939d; }
    .empty { padding: 18px; border: 1px dashed #ddd8e7; border-radius: 8px; color: #817b89; }
    footer { margin-top: 16px; padding-top: 8px; border-top: 1px solid #e9e6f0; color: #8c8795; font-size: 8px; }
  </style></head><body>
    <header><div><h1>EditFlow</h1><p>${escapeHtml(report.workspaceName)} · Relatório de produção</p></div><div class="period"><strong>${escapeHtml(report.periodLabel)}</strong><p>${periodKindLabel(report.periodKind)}</p><p>Gerado em ${escapeHtml(report.generatedAt)}</p></div></header>
    <section class="summary"><article><span>Vídeos concluídos</span><strong>${report.total}</strong></article><article><span>Clientes atendidos</span><strong>${report.clientCount}</strong></article><article><span>Responsáveis atuais</span><strong>${report.editorCount}</strong></article></section>
    <p class="filters">Cliente: ${escapeHtml(report.clientFilter)} · Responsável: ${escapeHtml(report.editorFilter)}${report.searchFilter ? ` · Busca: ${escapeHtml(report.searchFilter)}` : ''}</p>
    <h2>Produção por cliente</h2>${report.byClient.length ? `<div class="clients">${clientRows}</div>` : '<div class="empty">Nenhum vídeo concluído no período.</div>'}
    <h2>Vídeos concluídos</h2>${report.rows.length ? `<table><thead><tr><th>Vídeo</th><th>Cliente</th><th>Responsável</th><th>Conclusão</th></tr></thead><tbody>${videoRows}</tbody></table>` : '<div class="empty">Nenhum vídeo para listar.</div>'}
    <footer>Contagem baseada nas tarefas atualmente concluídas, inclusive arquivadas. O responsável reflete a atribuição atual da tarefa.</footer>
  </body></html>`;
}

function periodKindLabel(kind: EditFlowProductionReport['periodKind']) {
  switch (kind) {
    case 'week': return 'Semana';
    case 'fortnight': return '15 dias';
    case 'cycle': return 'Ciclo da equipe';
    case 'month': return 'Mês calendário';
  }
}
