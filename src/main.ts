import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification as ElectronNotification, powerMonitor, shell, Tray } from 'electron';
import { autoUpdater, type NsisUpdater } from 'electron-updater';
import { spawn } from 'node:child_process';
import { access, appendFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

type UpdateStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; version?: string; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'up-to-date'; version: string }
  | { state: 'error'; message: string };

let updateVersion: string | undefined;
let manualUpdateCheck = false;
let updateDownloadStarted = false;
let installingUpdate = false;
let updateSplashWindow: BrowserWindow | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let trayExplanationShown = false;
let pendingAuthCallback: string | null = null;
const activeNativeNotifications = new Set<ElectronNotification>();
const authProtocol = 'editflow';

type DesktopPreferences = {
  launchAtLogin: boolean;
  closeToTray: boolean;
  showWelcome: boolean;
  nativeNotifications: boolean;
  theme: 'light' | 'dark' | 'system';
  startupPage: 'my-work' | 'board';
  lastSeenPatchNotesVersion: string;
};

const defaultDesktopPreferences: DesktopPreferences = {
  launchAtLogin: false,
  closeToTray: true,
  showWelcome: true,
  nativeNotifications: true,
  theme: 'light',
  startupPage: 'my-work',
  lastSeenPatchNotesVersion: '',
};

let desktopPreferences = defaultDesktopPreferences;

type NativeNotificationPayload = {
  notificationId: string;
  title: string;
  body: string;
  taskId: string | null;
  conversationId: string | null;
  workspaceId: string;
};

type UsdBrlRate = {
  rate: number;
  fetchedAt: string;
  sourceUpdatedAt: string;
  source: 'AwesomeAPI';
  stale: boolean;
};

if (process.platform === 'win32') {
  app.setAppUserModelId('com.editflow.desktop');
}

if (app.isPackaged) {
  app.setAsDefaultProtocolClient(authProtocol);
} else if (process.platform === 'win32' && process.argv[1]) {
  app.setAsDefaultProtocolClient(authProtocol, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(authProtocol);
}

const authCallbackFromArguments = (argumentsList: string[]) => argumentsList.find((argument) => argument.startsWith(`${authProtocol}://`)) ?? null;

const queueAuthCallback = (url: string | null) => {
  if (!url) return;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${authProtocol}:`) return;
  } catch {
    return;
  }
  pendingAuthCallback = url;
  showMainWindow();
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('auth:callback', url);
  }
};

pendingAuthCallback = authCallbackFromArguments(process.argv);

const sendUpdateStatus = (status: UpdateStatus) => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('updater:status', status);
  }
};

const updateLogPath = () => path.join(app.getPath('userData'), 'logs', 'updater.log');
const updateMarkerPath = () => path.join(app.getPath('userData'), 'pending-update.json');
const updateHelperPath = () => path.join(app.getPath('userData'), 'update-progress.ps1');
const updateHelperExecutablePath = () => path.join(process.resourcesPath, 'EditFlowUpdateHelper.exe');
const updateHelperReadyPath = () => path.join(app.getPath('userData'), 'update-progress.ready');
const updateHelperErrorPath = () => path.join(app.getPath('userData'), 'logs', 'update-progress-error.log');
const desktopPreferencesPath = () => path.join(app.getPath('userData'), 'desktop-preferences.json');
const currencyRateCachePath = () => path.join(app.getPath('userData'), 'usd-brl-rate.json');

const readCachedUsdBrlRate = async (): Promise<UsdBrlRate | null> => {
  try {
    const cached = JSON.parse(await readFile(currencyRateCachePath(), 'utf8')) as Partial<UsdBrlRate>;
    if (typeof cached.rate !== 'number' || !Number.isFinite(cached.rate) || cached.rate <= 0 || typeof cached.fetchedAt !== 'string') return null;
    return {
      rate: cached.rate,
      fetchedAt: cached.fetchedAt,
      sourceUpdatedAt: typeof cached.sourceUpdatedAt === 'string' ? cached.sourceUpdatedAt : cached.fetchedAt,
      source: 'AwesomeAPI',
      stale: false,
    };
  } catch {
    return null;
  }
};

const getUsdBrlRate = async (): Promise<UsdBrlRate> => {
  const cached = await readCachedUsdBrlRate();
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < 15 * 60 * 1000) return cached;

  try {
    const response = await fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL', {
      headers: { 'User-Agent': `EditFlow/${app.getVersion()}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Currency service returned ${response.status}`);
    const payload = await response.json() as { USDBRL?: { bid?: string; timestamp?: string; create_date?: string } };
    const rate = Number(payload.USDBRL?.bid);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('Currency service returned an invalid rate');
    const timestamp = Number(payload.USDBRL?.timestamp);
    const freshRate: UsdBrlRate = {
      rate,
      fetchedAt: new Date().toISOString(),
      sourceUpdatedAt: Number.isFinite(timestamp) && timestamp > 0
        ? new Date(timestamp * 1000).toISOString()
        : (payload.USDBRL?.create_date ?? new Date().toISOString()),
      source: 'AwesomeAPI',
      stale: false,
    };
    await writeFile(currencyRateCachePath(), JSON.stringify(freshRate, null, 2), 'utf8');
    return freshRate;
  } catch (error) {
    if (cached) return { ...cached, stale: true };
    throw error;
  }
};

const escapeReportHtml = (value: string) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const reportCurrency = (value: number, currency: 'USD' | 'BRL') => new Intl.NumberFormat(
  currency === 'BRL' ? 'pt-BR' : 'en-US',
  { style: 'currency', currency },
).format(value);

const reportBrl = (value: number | null) => value === null
  ? 'Indisponível'
  : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);

const validReportNumber = (value: unknown, nullable = false) => (
  (nullable && value === null)
  || (typeof value === 'number' && Number.isFinite(value))
);

const isFinancialReport = (value: unknown): value is EditFlowFinancialReport => {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<EditFlowFinancialReport>;
  if (typeof report.workspaceName !== 'string'
    || typeof report.month !== 'string'
    || !/^\d{4}-\d{2}$/.test(report.month)
    || typeof report.monthLabel !== 'string'
    || typeof report.generatedAt !== 'string'
    || !validReportNumber(report.usdBrlRate, true)
    || !report.totals
    || !Array.isArray(report.rows)
    || report.rows.length > 10_000) return false;
  const totals = report.totals;
  if (!validReportNumber(totals.grossBrl, true)
    || !validReportNumber(totals.feesBrl, true)
    || !validReportNumber(totals.netBrl, true)
    || !validReportNumber(totals.receivedBrl)
    || !validReportNumber(totals.pendingBrl, true)
    || !validReportNumber(totals.entries)) return false;
  return report.rows.every((row) => row
    && typeof row.client === 'string'
    && typeof row.description === 'string'
    && typeof row.date === 'string'
    && typeof row.source === 'string'
    && (row.currency === 'USD' || row.currency === 'BRL')
    && validReportNumber(row.gross)
    && validReportNumber(row.fees)
    && validReportNumber(row.net)
    && validReportNumber(row.netBrl, true)
    && (row.status === 'pending' || row.status === 'received'));
};

const financialReportHtml = (report: EditFlowFinancialReport) => {
  const rows = report.rows.map((row) => `
    <tr>
      <td><strong>${escapeReportHtml(row.client)}</strong><small>${escapeReportHtml(row.description)} · ${escapeReportHtml(row.source)}</small></td>
      <td>${escapeReportHtml(row.date)}</td>
      <td><span class="currency">${row.currency}</span>${escapeReportHtml(reportCurrency(row.gross, row.currency))}</td>
      <td>${escapeReportHtml(reportCurrency(row.fees, row.currency))}</td>
      <td><strong>${escapeReportHtml(reportBrl(row.netBrl))}</strong><small>${escapeReportHtml(reportCurrency(row.net, row.currency))} líquido</small></td>
      <td><span class="status ${row.status}">${row.status === 'received' ? 'Recebido' : 'Pendente'}</span></td>
    </tr>`).join('');
  return `<!doctype html>
  <html lang="pt-BR"><head><meta charset="utf-8"><style>
    @page { size: A4 landscape; margin: 12mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #2d2b38; background: #fff; font-family: "Segoe UI", Arial, sans-serif; font-size: 9.5px; }
    header { display: flex; align-items: flex-end; justify-content: space-between; padding: 4px 2px 16px; border-bottom: 2px solid #6557cb; }
    .brand { display: flex; align-items: center; gap: 11px; }
    .logo { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 11px; background: linear-gradient(145deg,#6d5ee1,#2d247d); color: #fff; font-size: 17px; font-weight: 800; }
    h1 { margin: 0 0 2px; font-size: 18px; letter-spacing: -.4px; }
    header p, header small { margin: 0; color: #807c8d; }
    .period { text-align: right; }
    .period strong { display: block; margin-bottom: 3px; color: #5e52bd; font-size: 13px; text-transform: capitalize; }
    .summary { display: grid; grid-template-columns: repeat(5,1fr); gap: 8px; margin: 15px 0; }
    .summary article { min-height: 62px; padding: 10px; border: 1px solid #e7e3ef; border-radius: 10px; background: linear-gradient(145deg,#faf9ff,#f5f4fa); }
    .summary span { display: block; margin-bottom: 7px; color: #8b8796; font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; }
    .summary strong { color: #35323f; font-size: 13px; }
    .summary article.net { border-color: #d8d1ff; background: linear-gradient(145deg,#f2efff,#eae7ff); }
    .summary article.net strong { color: #5546b6; }
    table { width: 100%; border-collapse: separate; border-spacing: 0; overflow: hidden; border: 1px solid #e4e1e9; border-radius: 10px; }
    thead { display: table-header-group; }
    th { padding: 8px 9px; background: #f1eff5; color: #777280; font-size: 7.5px; text-align: left; text-transform: uppercase; letter-spacing: .45px; }
    td { padding: 8px 9px; border-top: 1px solid #ece9f0; vertical-align: middle; }
    tbody tr { break-inside: avoid; }
    td:first-child { width: 31%; }
    td strong, td small { display: block; }
    td small { margin-top: 2px; color: #8d8995; font-size: 7.8px; }
    .currency { display: inline-block; margin-right: 5px; padding: 2px 4px; border-radius: 4px; background: #ece9fb; color: #6257b5; font-size: 7px; font-weight: 800; }
    .status { display: inline-block; padding: 4px 7px; border-radius: 99px; font-size: 7.5px; font-weight: 700; }
    .status.received { background: #e6f7ee; color: #33835a; }
    .status.pending { background: #fff1dc; color: #a36a17; }
    .empty { padding: 34px; border: 1px dashed #d9d5df; border-radius: 10px; color: #918d99; text-align: center; }
    footer { display: flex; justify-content: space-between; margin-top: 12px; padding: 8px 2px 0; border-top: 1px solid #ece9f0; color: #8c8894; font-size: 7.5px; }
  </style></head><body>
    <header><div class="brand"><div class="logo">E</div><div><h1>EditFlow</h1><p>${escapeReportHtml(report.workspaceName)} · Relatório financeiro mensal</p></div></div><div class="period"><strong>${escapeReportHtml(report.monthLabel)}</strong><small>Gerado em ${escapeReportHtml(report.generatedAt)}</small></div></header>
    <section class="summary">
      <article><span>Faturamento bruto</span><strong>${escapeReportHtml(reportBrl(report.totals.grossBrl))}</strong></article>
      <article><span>Taxas estimadas</span><strong>${escapeReportHtml(reportBrl(report.totals.feesBrl))}</strong></article>
      <article class="net"><span>Líquido do mês</span><strong>${escapeReportHtml(reportBrl(report.totals.netBrl))}</strong></article>
      <article><span>Já recebido</span><strong>${escapeReportHtml(reportBrl(report.totals.receivedBrl))}</strong></article>
      <article><span>Pendente</span><strong>${escapeReportHtml(reportBrl(report.totals.pendingBrl))}</strong></article>
    </section>
    ${report.rows.length ? `<table><thead><tr><th>Cliente / lançamento</th><th>Data</th><th>Bruto original</th><th>Taxas</th><th>Líquido</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">Nenhum lançamento registrado no período.</div>'}
    <footer><span>${report.totals.entries} lançamento(s) no período</span><span>${report.usdBrlRate ? `Cotação de referência: USD 1 = ${reportBrl(report.usdBrlRate)}` : 'Sem conversão USD/BRL disponível'} · Valores recebidos usam o valor real registrado.</span></footer>
  </body></html>`;
};

const readDesktopPreferences = async () => {
  try {
    const saved = JSON.parse(await readFile(desktopPreferencesPath(), 'utf8')) as Partial<DesktopPreferences>;
    return sanitizeDesktopPreferences(saved);
  } catch {
    return defaultDesktopPreferences;
  }
};

const saveDesktopPreferences = async () => {
  await writeFile(desktopPreferencesPath(), JSON.stringify(desktopPreferences, null, 2), 'utf8');
};

const applyLaunchAtLogin = () => {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: desktopPreferences.launchAtLogin,
    path: app.getPath('exe'),
  });
};

const showMainWindow = () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
};

const createTrayImage = () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#211b70"/><path d="M16 6.5l1.7 5.8 5.8 1.7-5.8 1.7L16 21.5l-1.7-5.8L8.5 14l5.8-1.7L16 6.5z" fill="white"/><circle cx="23.5" cy="23.5" r="2.5" fill="#a99fff"/></svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`).resize({ width: 16, height: 16 });
};

const createTray = () => {
  if (tray || !desktopPreferences.closeToTray) return;
  tray = new Tray(createTrayImage());
  tray.setToolTip('EditFlow');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir EditFlow', click: showMainWindow },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on('double-click', showMainWindow);
};

const syncTrayWithPreferences = () => {
  if (desktopPreferences.closeToTray) {
    createTray();
  } else if (tray) {
    tray.destroy();
    tray = null;
  }
};

const hasUpdateMarker = async () => {
  try {
    await access(updateMarkerPath());
    return true;
  } catch {
    return false;
  }
};

const clearUpdateMarker = async () => {
  try {
    await unlink(updateMarkerPath());
  } catch {
    // A missing marker simply means this is a regular startup.
  }
};

const removeFileIfPresent = async (targetPath: string) => {
  try {
    await unlink(targetPath);
  } catch {
    // Cleanup is best effort because the file may not exist yet.
  }
};

const waitForWindowToShow = (window: BrowserWindow, timeoutMs = 2500) => new Promise<boolean>((resolve) => {
  if (window.isVisible()) {
    resolve(true);
    return;
  }

  let settled = false;
  const finish = (visible: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    window.removeListener('show', onShow);
    resolve(visible);
  };
  const onShow = () => finish(true);
  const timeout = setTimeout(() => finish(window.isVisible()), timeoutMs);
  window.once('show', onShow);
});

const createUpdateSplash = (phase: 'installing' | 'finishing') => {
  if (updateSplashWindow && !updateSplashWindow.isDestroyed()) updateSplashWindow.close();

  const finishing = phase === 'finishing';
  const splash = new BrowserWindow({
    width: 390,
    height: 168,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const html = `<!doctype html>
    <html lang="pt-BR">
      <head>
        <meta charset="UTF-8" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'" />
        <style>
          * { box-sizing: border-box; }
          html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; font-family: Inter, "Segoe UI", sans-serif; }
          body { display: grid; place-items: center; padding: 8px; }
          .card { -webkit-app-region: drag; display: flex; align-items: center; gap: 17px; width: 100%; height: 100%; padding: 23px; border: 1px solid rgba(255,255,255,.13); border-radius: 24px; background: linear-gradient(145deg, rgba(35,33,72,.98), rgba(18,19,35,.98)); color: #fff; box-shadow: 0 22px 60px rgba(14,13,35,.38); }
          .mark { position: relative; display: grid; place-items: center; flex: 0 0 58px; height: 58px; border-radius: 18px; background: linear-gradient(145deg, #7d72ec, #5147aa); box-shadow: 0 10px 28px rgba(82,70,177,.38); }
          .ring { width: 27px; height: 27px; border: 3px solid rgba(255,255,255,.28); border-top-color: #fff; border-radius: 50%; animation: spin .8s linear infinite; }
          .copy { display: grid; gap: 7px; min-width: 0; }
          strong { font-size: 16px; letter-spacing: -.02em; }
          span { color: #c0bfd3; font-size: 11px; line-height: 1.45; }
          .dots { display: flex; gap: 5px; margin-top: 3px; }
          .dots i { width: 5px; height: 5px; border-radius: 50%; background: #9e95ef; animation: pulse 1.2s ease-in-out infinite; }
          .dots i:nth-child(2) { animation-delay: .16s; }
          .dots i:nth-child(3) { animation-delay: .32s; }
          @keyframes spin { to { transform: rotate(360deg); } }
          @keyframes pulse { 0%, 70%, 100% { opacity: .3; transform: scale(.8); } 35% { opacity: 1; transform: scale(1.15); } }
        </style>
      </head>
      <body>
        <main class="card">
          <div class="mark"><div class="ring"></div></div>
          <div class="copy">
            <strong>Aplicando atualização</strong>
            <span>${finishing ? 'Finalizando os últimos ajustes. O EditFlow abrirá em instantes.' : 'O aplicativo será reiniciado automaticamente. Não desligue o computador.'}</span>
            <div class="dots"><i></i><i></i><i></i></div>
          </div>
        </main>
      </body>
    </html>`;

  splash.once('ready-to-show', () => splash.show());
  splash.on('closed', () => {
    if (updateSplashWindow === splash) updateSplashWindow = null;
  });
  void splash.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
  updateSplashWindow = splash;
  return splash;
};

// A separate Windows process keeps this progress window visible while
// Electron exits and NSIS replaces the application files. The restarted app
// removes the marker below, which tells the helper that it can close.
const updateHelperScript = String.raw`param(
  [Parameter(Mandatory = $true)][string]$MarkerPath,
  [Parameter(Mandatory = $true)][string]$ReadyPath,
  [Parameter(Mandatory = $true)][string]$ErrorPath,
  [string]$TargetVersion = ''
)

$ErrorActionPreference = 'Stop'
trap {
  try {
    $errorDirectory = [System.IO.Path]::GetDirectoryName($ErrorPath)
    if (-not [string]::IsNullOrWhiteSpace($errorDirectory)) {
      [System.IO.Directory]::CreateDirectory($errorDirectory) | Out-Null
    }
    $details = ($_ | Out-String)
    $innerError = $_.Exception.InnerException
    while ($null -ne $innerError) {
      $details += [Environment]::NewLine + $innerError.Message
      $innerError = $innerError.InnerException
    }
    $details | Set-Content -LiteralPath $ErrorPath -Encoding UTF8
  } catch {}
  exit 1
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Convert-HexColor([string]$value) {
  return [System.Drawing.ColorTranslator]::FromHtml($value)
}

function Set-RoundedRegion($control, [int]$radius) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $radius * 2
  $width = $control.Width - 1
  $height = $control.Height - 1
  $path.AddArc(0, 0, $diameter, $diameter, 180, 90)
  $path.AddArc($width - $diameter, 0, $diameter, $diameter, 270, 90)
  $path.AddArc($width - $diameter, $height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc(0, $height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  $control.Region = New-Object System.Drawing.Region($path)
  $path.Dispose()
}

$window = New-Object System.Windows.Forms.Form
$window.Text = 'EditFlow'
$window.ClientSize = New-Object System.Drawing.Size(390, 168)
$window.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$window.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$window.ShowInTaskbar = $false
$window.TopMost = $true
$window.BackColor = Convert-HexColor '#171623'
$window.Opacity = 0.98
Set-RoundedRegion $window 24

$iconPanel = New-Object System.Windows.Forms.Panel
$iconPanel.Location = New-Object System.Drawing.Point(24, 55)
$iconPanel.Size = New-Object System.Drawing.Size(58, 58)
$iconPanel.BackColor = Convert-HexColor '#675DCE'
Set-RoundedRegion $iconPanel 18

$spinner = New-Object System.Windows.Forms.Panel
$spinner.Location = New-Object System.Drawing.Point(14, 14)
$spinner.Size = New-Object System.Drawing.Size(30, 30)
$spinner.BackColor = [System.Drawing.Color]::Transparent
$iconPanel.Controls.Add($spinner)

$title = New-Object System.Windows.Forms.Label
$title.AutoSize = $false
$title.Location = New-Object System.Drawing.Point(100, 45)
$title.Size = New-Object System.Drawing.Size(260, 25)
$title.Font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
$title.ForeColor = [System.Drawing.Color]::White
$title.Text = 'Aplicando atualização'

$statusText = New-Object System.Windows.Forms.Label
$statusText.AutoSize = $false
$statusText.Location = New-Object System.Drawing.Point(100, 73)
$statusText.Size = New-Object System.Drawing.Size(260, 38)
$statusText.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
$statusText.ForeColor = Convert-HexColor '#C0BFD3'
$statusText.Text = 'O EditFlow será reiniciado automaticamente. Não desligue o computador.'

$dotOne = New-Object System.Windows.Forms.Panel
$dotTwo = New-Object System.Windows.Forms.Panel
$dotThree = New-Object System.Windows.Forms.Panel
$dots = @($dotOne, $dotTwo, $dotThree)
for ($index = 0; $index -lt $dots.Count; $index++) {
  $dots[$index].Location = New-Object System.Drawing.Point((100 + ($index * 11)), 119)
  $dots[$index].Size = New-Object System.Drawing.Size(5, 5)
  $dots[$index].BackColor = Convert-HexColor '#9E95EF'
  Set-RoundedRegion $dots[$index] 2
  $window.Controls.Add($dots[$index])
}

$window.Controls.Add($iconPanel)
$window.Controls.Add($title)
$window.Controls.Add($statusText)
$startedAt = Get-Date
$state = @{ Angle = 0; Tick = 0 }

if (-not [string]::IsNullOrWhiteSpace($TargetVersion)) {
  $statusText.Text = "Instalando a versão $TargetVersion. O EditFlow abrirá novamente em instantes."
}

$spinner.Add_Paint({
  param($sender, $paintEvent)
  $paintEvent.Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $trackPen = New-Object System.Drawing.Pen((Convert-HexColor '#665F79'), 3)
  $accentPen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 3)
  $paintEvent.Graphics.DrawArc($trackPen, 4, 4, 21, 21, 0, 360)
  $paintEvent.Graphics.DrawArc($accentPen, 4, 4, 21, 21, $state.Angle, 255)
  $trackPen.Dispose()
  $accentPen.Dispose()
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 45
$timer.Add_Tick({
  $state.Angle = ($state.Angle + 11) % 360
  $state.Tick = ($state.Tick + 1) % 60
  $spinner.Invalidate()
  $phase = [Math]::Floor($state.Tick / 10) % 3
  $dotOne.BackColor = Convert-HexColor $(if ($phase -eq 0) { '#BDB6FF' } else { '#554F73' })
  $dotTwo.BackColor = Convert-HexColor $(if ($phase -eq 1) { '#BDB6FF' } else { '#554F73' })
  $dotThree.BackColor = Convert-HexColor $(if ($phase -eq 2) { '#BDB6FF' } else { '#554F73' })

  if (-not (Test-Path -LiteralPath $MarkerPath) -or ((Get-Date) - $startedAt).TotalMinutes -ge 3) {
    $timer.Stop()
    $window.Close()
  }
})

$window.Add_Shown({
  [System.IO.File]::WriteAllText($ReadyPath, (Get-Date).ToString('O'))
  $timer.Start()
})
[void]$window.ShowDialog()
$timer.Dispose()
$window.Dispose()
`;

const launchExternalUpdateHelper = async () => {
  if (process.platform !== 'win32') return false;

  try {
    const helperPath = updateHelperExecutablePath();
    const readyPath = updateHelperReadyPath();
    const errorPath = updateHelperErrorPath();
    await mkdir(path.dirname(errorPath), { recursive: true });
    await Promise.all([removeFileIfPresent(readyPath), removeFileIfPresent(errorPath)]);
    await access(helperPath);
    const helper = spawn(helperPath, [
      updateMarkerPath(),
      readyPath,
      errorPath,
      updateVersion ?? '',
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    const processState: { error: Error | null; exited: boolean } = { error: null, exited: false };
    helper.once('error', (error) => { processState.error = error; });
    helper.once('exit', () => { processState.exited = true; });
    helper.unref();

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        await access(readyPath);
        await writeUpdateLog('Tela externa renderizada', updateVersion ?? 'versão baixada');
        return true;
      } catch {
        // WPF is still loading.
      }

      if (processState.error || processState.exited) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    let helperDetails = processState.error?.message ?? 'A janela externa não confirmou que foi exibida.';
    try {
      helperDetails = (await readFile(errorPath, 'utf8')).trim() || helperDetails;
    } catch {
      // Keep the generic diagnostic when the helper could not write its log.
    }
    await writeUpdateLog('Falha ao exibir tela externa da atualização', helperDetails);
    if (!processState.exited) helper.kill();
    return false;
  } catch (error) {
    await writeUpdateLog(
      'Falha ao preparar tela externa da atualização',
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
};

const writeUpdateLog = async (event: string, details = '') => {
  try {
    const logPath = updateLogPath();
    await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(logPath, `[${new Date().toISOString()}] ${event}${details ? `: ${details}` : ''}\n`, 'utf8');
  } catch {
    // Logging must never interrupt the update itself.
  }
};

const createWindow = () => {
  const createdWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: '#080b13',
    title: 'EditFlow',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  mainWindow = createdWindow;
  createdWindow.once('ready-to-show', () => createdWindow.show());
  createdWindow.on('close', (event) => {
    if (isQuitting || installingUpdate || !desktopPreferences.closeToTray) return;
    event.preventDefault();
    createdWindow.hide();
    createTray();
    if (!trayExplanationShown && ElectronNotification.isSupported()) {
      trayExplanationShown = true;
      const explanation = new ElectronNotification({
        title: 'EditFlow continua ativo',
        body: 'O app foi minimizado para os ícones ocultos e continuará recebendo notificações.',
      });
      activeNativeNotifications.add(explanation);
      explanation.on('click', showMainWindow);
      explanation.on('close', () => activeNativeNotifications.delete(explanation));
      explanation.show();
    }
  });
  createdWindow.on('closed', () => {
    if (mainWindow === createdWindow) mainWindow = null;
  });

  createdWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openSafeExternal(url);
    return { action: 'deny' };
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void createdWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void createdWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  return createdWindow;
};

const openSafeExternal = async (rawUrl: string) => {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return false;
    await shell.openExternal(url.toString());
    return true;
  } catch {
    return false;
  }
};

ipcMain.handle('system:open-external', (_event, url: unknown) => {
  if (typeof url !== 'string') return false;
  return openSafeExternal(url);
});

ipcMain.handle('system:get-version', () => app.getVersion());
ipcMain.handle('auth:get-pending-callback', () => {
  const callback = pendingAuthCallback;
  pendingAuthCallback = null;
  return callback;
});
ipcMain.handle('system:get-usd-brl-rate', () => getUsdBrlRate());
ipcMain.handle('finance:export-pdf', async (_event, value: unknown) => {
  if (!isFinancialReport(value)) throw new Error('Os dados do relatório financeiro são inválidos.');

  const defaultName = `EditFlow-Relatorio-${value.month}.pdf`;
  const saveOptions = {
    title: 'Exportar relatório financeiro',
    defaultPath: path.join(app.getPath('documents'), defaultName),
    filters: [{ name: 'Documento PDF', extensions: ['pdf'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'] as Array<'createDirectory' | 'showOverwriteConfirmation'>,
  };
  const selection = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showSaveDialog(mainWindow, saveOptions)
    : await dialog.showSaveDialog(saveOptions);
  if (selection.canceled || !selection.filePath) return { cancelled: true };

  const reportWindow = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: { sandbox: true },
  });
  try {
    const html = financialReportHtml(value);
    await reportWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
    const pdf = await reportWindow.webContents.printToPDF({
      pageSize: 'A4',
      landscape: true,
      printBackground: true,
      preferCSSPageSize: true,
    });
    await writeFile(selection.filePath, pdf);
    return { cancelled: false, filePath: selection.filePath };
  } finally {
    if (!reportWindow.isDestroyed()) reportWindow.destroy();
  }
});
ipcMain.handle('system:get-user-activity', () => {
  const state = powerMonitor.getSystemIdleState(300);
  return state === 'idle' || state === 'locked' ? 'away' : 'active';
});
ipcMain.handle('desktop:get-preferences', () => desktopPreferences);
ipcMain.handle('desktop:update-preferences', async (_event, value: unknown) => {
  desktopPreferences = sanitizeDesktopPreferences(value);
  await saveDesktopPreferences();
  applyLaunchAtLogin();
  syncTrayWithPreferences();
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('desktop:preferences-changed', desktopPreferences);
  }
  return desktopPreferences;
});
ipcMain.handle('notifications:show', (event, value: unknown) => {
  if (!desktopPreferences.nativeNotifications || !ElectronNotification.isSupported() || !isNativeNotificationPayload(value)) return false;

  const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
  const notification = new ElectronNotification({
    title: value.title.slice(0, 120),
    body: value.body.slice(0, 500),
  });
  activeNativeNotifications.add(notification);

  notification.on('click', () => {
    if (targetWindow && !targetWindow.isDestroyed()) {
      if (targetWindow.isMinimized()) targetWindow.restore();
      targetWindow.show();
      targetWindow.focus();
      targetWindow.webContents.send('notifications:clicked', {
        notificationId: value.notificationId,
        taskId: value.taskId,
        conversationId: value.conversationId,
        workspaceId: value.workspaceId,
      });
    }
  });
  notification.on('close', () => activeNativeNotifications.delete(notification));

  notification.show();
  return true;
});
ipcMain.handle('updater:show-log', async () => {
  const logPath = updateLogPath();
  await mkdir(path.dirname(logPath), { recursive: true });
  try {
    await appendFile(logPath, '', 'utf8');
  } catch {
    await writeFile(logPath, '', 'utf8');
  }
  shell.showItemInFolder(logPath);
  return true;
});

const configureAutoUpdater = () => {
  if (!app.isPackaged) return;

  // The installer is created from a prepackaged Forge build, so the feed is
  // declared here as well as in electron-builder's publish configuration.
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'Jhoonnz',
    repo: 'EditFlow',
  });
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // Prefer blockmap-based differential downloads. electron-updater falls back
  // to the complete installer when the previous package cannot be reused.
  (autoUpdater as NsisUpdater).disableDifferentialDownload = false;

  // Automatic checks stay silent unless an update is actually found.
  autoUpdater.on('checking-for-update', () => {
    void writeUpdateLog('Verificando atualizações', `versão atual ${app.getVersion()}`);
    if (manualUpdateCheck) sendUpdateStatus({ state: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
    void writeUpdateLog('Atualização encontrada', info.version);
    updateVersion = info.version;
    sendUpdateStatus({ state: 'available', version: info.version });
    if (!updateDownloadStarted) {
      updateDownloadStarted = true;
      void autoUpdater.downloadUpdate().catch((error: Error) => {
        void writeUpdateLog('Falha ao baixar atualização', error.stack ?? error.message);
        updateDownloadStarted = false;
        sendUpdateStatus({ state: 'error', message: error.message });
      });
    }
  });
  autoUpdater.on('download-progress', (progress) => {
    if (Math.round(progress.percent) % 10 === 0) void writeUpdateLog('Progresso do download', `${Math.round(progress.percent)}%`);
    sendUpdateStatus({
      state: 'downloading',
      version: updateVersion,
      percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    void writeUpdateLog('Atualização pronta', info.version);
    updateDownloadStarted = false;
    updateVersion = info.version;
    sendUpdateStatus({ state: 'downloaded', version: info.version });
  });
  autoUpdater.on('update-not-available', () => {
    void writeUpdateLog('Nenhuma atualização disponível', app.getVersion());
    updateDownloadStarted = false;
    if (manualUpdateCheck) {
      sendUpdateStatus({ state: 'up-to-date', version: app.getVersion() });
    }
    manualUpdateCheck = false;
  });
  autoUpdater.on('error', (error) => {
    void writeUpdateLog('Erro do atualizador', error.stack ?? error.message);
    updateDownloadStarted = false;
    if (installingUpdate) {
      installingUpdate = false;
      void clearUpdateMarker();
      if (updateSplashWindow && !updateSplashWindow.isDestroyed()) updateSplashWindow.close();
      for (const window of BrowserWindow.getAllWindows()) window.show();
    }
    sendUpdateStatus({ state: 'error', message: error.message });
    manualUpdateCheck = false;
  });

  ipcMain.handle('updater:check', async () => {
    manualUpdateCheck = true;
    await autoUpdater.checkForUpdates();
    return true;
  });
  ipcMain.handle('updater:install', async () => {
    if (installingUpdate) return true;
    installingUpdate = true;
    await writeUpdateLog('Aplicando atualização', updateVersion ?? 'versão baixada');
    await writeFile(updateMarkerPath(), JSON.stringify({ version: updateVersion, startedAt: new Date().toISOString() }), 'utf8');

    const currentWindows = BrowserWindow.getAllWindows();
    const splash = createUpdateSplash('installing');
    await waitForWindowToShow(splash);
    for (const window of currentWindows) window.hide();

    const externalHelperStarted = await launchExternalUpdateHelper();
    await writeUpdateLog(
      'Tela contínua da atualização',
      externalHelperStarted ? 'renderizada e pronta' : 'falhou; instalação cancelada',
    );

    if (!externalHelperStarted) {
      installingUpdate = false;
      await clearUpdateMarker();
      if (!splash.isDestroyed()) splash.close();
      for (const window of currentWindows) {
        if (!window.isDestroyed()) window.show();
      }
      sendUpdateStatus({
        state: 'error',
        message: 'Não foi possível abrir a tela de atualização. O aplicativo permaneceu aberto; tente novamente.',
      });
      return false;
    }

    setTimeout(() => {
      // /S keeps the NSIS installer invisible; force-run reopens the updated app.
      autoUpdater.quitAndInstall(true, true);
    }, 350);
    return true;
  });

  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch(() => undefined);
  }, 4000);
};

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    queueAuthCallback(authCallbackFromArguments(argv));
    showMainWindow();
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    queueAuthCallback(url);
  });
  app.on('before-quit', () => { isQuitting = true; });

  void app.whenReady().then(async () => {
  desktopPreferences = await readDesktopPreferences();
  applyLaunchAtLogin();
  const isFinishingUpdate = app.isPackaged && await hasUpdateMarker();

  if (isFinishingUpdate) {
    const splash = createUpdateSplash('finishing');
    void writeUpdateLog('Atualização aplicada', `versão atual ${app.getVersion()}`);
    setTimeout(() => {
      createWindow();
      syncTrayWithPreferences();
      if (!splash.isDestroyed()) splash.close();
      void clearUpdateMarker();
      void removeFileIfPresent(updateHelperReadyPath());
      configureAutoUpdater();
    }, 1800);
  } else {
    createWindow();
    syncTrayWithPreferences();
    configureAutoUpdater();
  }

  app.on('activate', () => {
    showMainWindow();
  });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function isNativeNotificationPayload(value: unknown): value is NativeNotificationPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.notificationId === 'string'
    && typeof payload.title === 'string'
    && typeof payload.body === 'string'
    && (typeof payload.taskId === 'string' || payload.taskId === null)
    && (typeof payload.conversationId === 'string' || payload.conversationId === null)
    && typeof payload.workspaceId === 'string';
}

function sanitizeDesktopPreferences(value: unknown): DesktopPreferences {
  const saved = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const theme = saved.theme === 'dark' || saved.theme === 'system' || saved.theme === 'light'
    ? saved.theme
    : defaultDesktopPreferences.theme;
  const startupPage = saved.startupPage === 'board' || saved.startupPage === 'my-work'
    ? saved.startupPage
    : defaultDesktopPreferences.startupPage;
  const lastSeenPatchNotesVersion = typeof saved.lastSeenPatchNotesVersion === 'string'
    && saved.lastSeenPatchNotesVersion.length <= 32
    && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(saved.lastSeenPatchNotesVersion)
    ? saved.lastSeenPatchNotesVersion
    : defaultDesktopPreferences.lastSeenPatchNotesVersion;
  return {
    launchAtLogin: typeof saved.launchAtLogin === 'boolean' ? saved.launchAtLogin : defaultDesktopPreferences.launchAtLogin,
    closeToTray: typeof saved.closeToTray === 'boolean' ? saved.closeToTray : defaultDesktopPreferences.closeToTray,
    showWelcome: typeof saved.showWelcome === 'boolean' ? saved.showWelcome : defaultDesktopPreferences.showWelcome,
    nativeNotifications: typeof saved.nativeNotifications === 'boolean' ? saved.nativeNotifications : defaultDesktopPreferences.nativeNotifications,
    theme,
    startupPage,
    lastSeenPatchNotesVersion,
  };
}
