import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification as ElectronNotification, powerMonitor, shell, Tray } from 'electron';
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
};

const defaultDesktopPreferences: DesktopPreferences = {
  launchAtLogin: false,
  closeToTray: true,
  showWelcome: true,
  nativeNotifications: true,
  theme: 'light',
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
  [string]$TargetVersion = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Width="390" Height="168" WindowStyle="None" AllowsTransparency="True"
        Background="Transparent" ResizeMode="NoResize" ShowInTaskbar="False"
        Topmost="True" WindowStartupLocation="CenterScreen">
  <Border Margin="8" Padding="23" CornerRadius="24" BorderThickness="1"
          BorderBrush="#35FFFFFF" Background="#F6232148">
    <Border.Effect>
      <DropShadowEffect BlurRadius="34" ShadowDepth="12" Opacity="0.40" Color="#17152F" />
    </Border.Effect>
    <Grid>
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="58" />
        <ColumnDefinition Width="17" />
        <ColumnDefinition Width="*" />
      </Grid.ColumnDefinitions>
      <Border Grid.Column="0" Width="58" Height="58" CornerRadius="18" Background="#675DCE">
        <Ellipse Width="28" Height="28" Stroke="#55FFFFFF" StrokeThickness="3"
                 StrokeDashArray="5 3" RenderTransformOrigin="0.5,0.5">
          <Ellipse.RenderTransform>
            <RotateTransform x:Name="SpinnerRotation" Angle="0" />
          </Ellipse.RenderTransform>
        </Ellipse>
      </Border>
      <StackPanel Grid.Column="2" VerticalAlignment="Center">
        <TextBlock Foreground="White" FontFamily="Segoe UI" FontSize="16" FontWeight="SemiBold"
                   Text="Aplicando atualização" />
        <TextBlock x:Name="StatusText" Margin="0,7,0,0" Foreground="#C0BFD3" FontFamily="Segoe UI"
                   FontSize="11" LineHeight="16" TextWrapping="Wrap"
                   Text="O EditFlow será reiniciado automaticamente. Não desligue o computador." />
        <StackPanel Margin="0,8,0,0" Orientation="Horizontal">
          <Ellipse x:Name="DotOne" Width="5" Height="5" Margin="0,0,5,0" Fill="#9E95EF" />
          <Ellipse x:Name="DotTwo" Width="5" Height="5" Margin="0,0,5,0" Fill="#9E95EF" Opacity="0.55" />
          <Ellipse x:Name="DotThree" Width="5" Height="5" Fill="#9E95EF" Opacity="0.30" />
        </StackPanel>
      </StackPanel>
    </Grid>
  </Border>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)
$rotation = $window.FindName('SpinnerRotation')
$statusText = $window.FindName('StatusText')
$dotOne = $window.FindName('DotOne')
$dotTwo = $window.FindName('DotTwo')
$dotThree = $window.FindName('DotThree')
$startedAt = Get-Date
$state = @{ Angle = 0; Tick = 0 }

if (-not [string]::IsNullOrWhiteSpace($TargetVersion)) {
  $statusText.Text = "Instalando a versão $TargetVersion. O EditFlow abrirá novamente em instantes."
}

$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(45)
$timer.Add_Tick({
  $state.Angle = ($state.Angle + 11) % 360
  $state.Tick = ($state.Tick + 1) % 60
  $rotation.Angle = $state.Angle
  $phase = [Math]::Floor($state.Tick / 10) % 3
  $dotOne.Opacity = if ($phase -eq 0) { 1 } else { 0.3 }
  $dotTwo.Opacity = if ($phase -eq 1) { 1 } else { 0.3 }
  $dotThree.Opacity = if ($phase -eq 2) { 1 } else { 0.3 }

  if (-not (Test-Path -LiteralPath $MarkerPath) -or ((Get-Date) - $startedAt).TotalMinutes -ge 3) {
    $timer.Stop()
    $window.Close()
  }
})

$window.Add_ContentRendered({ $timer.Start() })
[void]$window.ShowDialog()
`;

const launchExternalUpdateHelper = async () => {
  if (process.platform !== 'win32') return false;

  try {
    const helperPath = updateHelperPath();
    // Windows PowerShell 5.1 requires the UTF-8 BOM to preserve Portuguese
    // text correctly when a script is launched through -File.
    await writeFile(helperPath, `\uFEFF${updateHelperScript}`, 'utf8');
    const helper = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-STA',
      '-WindowStyle',
      'Hidden',
      '-File',
      helperPath,
      updateMarkerPath(),
      updateVersion ?? '',
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    helper.once('error', (error) => {
      void writeUpdateLog('Falha ao iniciar tela externa da atualização', error.message);
    });
    helper.unref();
    return true;
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
  (autoUpdater as NsisUpdater).disableDifferentialDownload = true;

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
    createUpdateSplash('installing');
    const externalHelperStarted = await launchExternalUpdateHelper();
    await writeUpdateLog(
      'Tela contínua da atualização',
      externalHelperStarted ? 'iniciada' : 'usando tela interna de fallback',
    );
    for (const window of currentWindows) window.hide();

    setTimeout(() => {
      // /S keeps the NSIS installer invisible; force-run reopens the updated app.
      autoUpdater.quitAndInstall(true, true);
    }, 900);
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
  return {
    launchAtLogin: typeof saved.launchAtLogin === 'boolean' ? saved.launchAtLogin : defaultDesktopPreferences.launchAtLogin,
    closeToTray: typeof saved.closeToTray === 'boolean' ? saved.closeToTray : defaultDesktopPreferences.closeToTray,
    showWelcome: typeof saved.showWelcome === 'boolean' ? saved.showWelcome : defaultDesktopPreferences.showWelcome,
    nativeNotifications: typeof saved.nativeNotifications === 'boolean' ? saved.nativeNotifications : defaultDesktopPreferences.nativeNotifications,
    theme,
  };
}
