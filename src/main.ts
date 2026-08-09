import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { autoUpdater, type NsisUpdater } from 'electron-updater';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
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

const sendUpdateStatus = (status: UpdateStatus) => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('updater:status', status);
  }
};

const updateLogPath = () => path.join(app.getPath('userData'), 'logs', 'updater.log');

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
  const mainWindow = new BrowserWindow({
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

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openSafeExternal(url);
    return { action: 'deny' };
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
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
    sendUpdateStatus({ state: 'error', message: error.message });
    manualUpdateCheck = false;
  });

  ipcMain.handle('updater:check', async () => {
    manualUpdateCheck = true;
    await autoUpdater.checkForUpdates();
    return true;
  });
  ipcMain.handle('updater:install', () => {
    autoUpdater.quitAndInstall(false, true);
  });

  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch(() => undefined);
  }, 4000);
};

app.whenReady().then(() => {
  createWindow();
  configureAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
