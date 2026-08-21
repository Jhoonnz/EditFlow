import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('editflow', {
  platform: process.platform,
  openExternal: (url: string) => ipcRenderer.invoke('system:open-external', url),
  getVersion: () => ipcRenderer.invoke('system:get-version'),
  getUsdBrlRate: () => ipcRenderer.invoke('system:get-usd-brl-rate'),
  exportFinancialReport: (report: EditFlowFinancialReport) => ipcRenderer.invoke('finance:export-pdf', report),
  getUserActivity: () => ipcRenderer.invoke('system:get-user-activity'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  showUpdateLog: () => ipcRenderer.invoke('updater:show-log'),
  getDesktopPreferences: () => ipcRenderer.invoke('desktop:get-preferences'),
  updateDesktopPreferences: (preferences: {
    launchAtLogin: boolean;
    closeToTray: boolean;
    showWelcome: boolean;
    nativeNotifications: boolean;
    theme: 'light' | 'dark' | 'system';
    startupPage: 'my-work' | 'board';
    lastSeenPatchNotesVersion: string;
  }) => ipcRenderer.invoke('desktop:update-preferences', preferences),
  onDesktopPreferencesChanged: (callback: (preferences: {
    launchAtLogin: boolean;
    closeToTray: boolean;
    showWelcome: boolean;
    nativeNotifications: boolean;
    theme: 'light' | 'dark' | 'system';
    startupPage: 'my-work' | 'board';
    lastSeenPatchNotesVersion: string;
  }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, preferences: {
      launchAtLogin: boolean;
      closeToTray: boolean;
      showWelcome: boolean;
      nativeNotifications: boolean;
      theme: 'light' | 'dark' | 'system';
      startupPage: 'my-work' | 'board';
      lastSeenPatchNotesVersion: string;
    }) => callback(preferences);
    ipcRenderer.on('desktop:preferences-changed', listener);
    return () => ipcRenderer.removeListener('desktop:preferences-changed', listener);
  },
  showNativeNotification: (notification: {
    notificationId: string;
    title: string;
    body: string;
    taskId: string | null;
    conversationId: string | null;
    workspaceId: string;
  }) => ipcRenderer.invoke('notifications:show', notification),
  onNativeNotificationClicked: (callback: (target: {
    notificationId: string;
    taskId: string | null;
    conversationId: string | null;
    workspaceId: string;
  }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, target: {
      notificationId: string;
      taskId: string | null;
      conversationId: string | null;
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
  getPendingAuthCallback: () => ipcRenderer.invoke('auth:get-pending-callback'),
  onAuthCallback: (callback: (url: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, url: string) => callback(url);
    ipcRenderer.on('auth:callback', listener);
    return () => ipcRenderer.removeListener('auth:callback', listener);
  },
});
