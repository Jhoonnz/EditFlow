import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('editflow', {
  platform: process.platform,
  openExternal: (url: string) => ipcRenderer.invoke('system:open-external', url),
  getVersion: () => ipcRenderer.invoke('system:get-version'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  showUpdateLog: () => ipcRenderer.invoke('updater:show-log'),
  showNativeNotification: (notification: {
    notificationId: string;
    title: string;
    body: string;
    taskId: string | null;
    workspaceId: string;
  }) => ipcRenderer.invoke('notifications:show', notification),
  onNativeNotificationClicked: (callback: (target: {
    notificationId: string;
    taskId: string | null;
    workspaceId: string;
  }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, target: {
      notificationId: string;
      taskId: string | null;
      workspaceId: string;
    }) => callback(target);
    ipcRenderer.on('notifications:clicked', listener);
    return () => ipcRenderer.removeListener('notifications:clicked', listener);
  },
  onUpdateStatus: (callback: (status: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
    ipcRenderer.on('updater:status', listener);
    return () => ipcRenderer.removeListener('updater:status', listener);
  },
});
