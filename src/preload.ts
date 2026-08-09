import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('editflow', {
  platform: process.platform,
  openExternal: (url: string) => ipcRenderer.invoke('system:open-external', url),
  getVersion: () => ipcRenderer.invoke('system:get-version'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  showUpdateLog: () => ipcRenderer.invoke('updater:show-log'),
  onUpdateStatus: (callback: (status: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
    ipcRenderer.on('updater:status', listener);
    return () => ipcRenderer.removeListener('updater:status', listener);
  },
});
