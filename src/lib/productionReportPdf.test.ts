import { describe, expect, it } from 'vitest';
import { isProductionReport, productionReportHtml } from './productionReportPdf';

const report: EditFlowProductionReport = {
  workspaceName: 'Equipe',
  periodKey: '2026-09',
  periodLabel: 'setembro de 2026',
  periodKind: 'month',
  generatedAt: '28/09/2026',
  clientFilter: 'Todos os clientes',
  editorFilter: 'Todos os responsáveis',
  searchFilter: '',
  total: 1,
  clientCount: 1,
  editorCount: 1,
  byClient: [{ name: 'Canal A', count: 1 }],
  rows: [{ title: 'Vídeo A', client: 'Canal A', editor: 'Ana', completedAt: '28/09/2026', archived: false }],
};

describe('production report PDF', () => {
  it('validates matching summary and detail totals', () => {
    expect(isProductionReport(report)).toBe(true);
    expect(isProductionReport({ ...report, periodKind: 'week', periodKey: '2026-09-14' })).toBe(true);
    expect(isProductionReport({ ...report, periodKind: 'fortnight', periodKey: '2026-09-16' })).toBe(true);
    expect(isProductionReport({ ...report, periodKind: 'week', periodKey: '2026-09' })).toBe(false);
    expect(isProductionReport({ ...report, total: 2 })).toBe(false);
    expect(isProductionReport({ ...report, periodKey: '../other' })).toBe(false);
  });

  it('escapes user-generated content in the printable document', () => {
    const html = productionReportHtml({ ...report, rows: [{ ...report.rows[0], title: '<img src=x onerror=alert(1)>' }] });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('table-header-group');
  });

  it('labels short periods in the printable report', () => {
    expect(productionReportHtml({ ...report, periodKind: 'week', periodKey: '2026-09-14' })).toContain('<p>Semana</p>');
    expect(productionReportHtml({ ...report, periodKind: 'fortnight', periodKey: '2026-09-16' })).toContain('<p>15 dias</p>');
  });
});
