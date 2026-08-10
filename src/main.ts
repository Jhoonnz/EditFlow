import { app, BrowserWindow, ipcMain, Notification as ElectronNotification, shell } from 'electron';
import { autoUpdater, type NsisUpdater } from 'electron-updater';
import { access, appendFile, mkdir, unlink, writeFile } from 'node:fs/promises';
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
const activeNativeNotifications = new Set<ElectronNotification>();

type NativeNotificationPayload = {
  notificationId: string;
  title: string;
  body: string;
  taskId: string | null;
  workspaceId: string;
};

if (process.platform === 'win32') {
  app.setAppUserModelId('com.editflow.desktop');
}

const sendUpdateStatus = (status: UpdateStatus) => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('updater:status', status);
  }
};

const updateLogPath = () => path.join(app.getPath('userData'), 'logs', 'updater.log');
const updateMarkerPath = () => path.join(app.getPath('userData'), 'pending-update.json');

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
    },
  });

  mainWindow = createdWindow;
  createdWindow.once('ready-to-show', () => createdWindow.show());
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
ipcMain.handle('notifications:show', (event, value: unknown) => {
  if (!ElectronNotification.isSupported() || !isNativeNotificationPayload(value)) return false;

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

app.whenReady().then(async () => {
  const isFinishingUpdate = app.isPackaged && await hasUpdateMarker();

  if (isFinishingUpdate) {
    const splash = createUpdateSplash('finishing');
    void writeUpdateLog('Atualização aplicada', `versão atual ${app.getVersion()}`);
    setTimeout(() => {
      createWindow();
      if (!splash.isDestroyed()) splash.close();
      void clearUpdateMarker();
      configureAutoUpdater();
    }, 1800);
  } else {
    createWindow();
    configureAutoUpdater();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

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
    && typeof payload.workspaceId === 'string';
}
