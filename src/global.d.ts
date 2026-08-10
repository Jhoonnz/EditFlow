/// <reference types="vite/client" />

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

type EditFlowUpdateStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; version?: string; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'up-to-date'; version: string }
  | { state: 'error'; message: string };

type EditFlowNativeNotification = {
  notificationId: string;
  title: string;
  body: string;
  taskId: string | null;
  workspaceId: string;
};

type EditFlowNativeNotificationTarget = Pick<
  EditFlowNativeNotification,
  'notificationId' | 'taskId' | 'workspaceId'
>;

type EditFlowDesktopPreferences = {
  launchAtLogin: boolean;
  closeToTray: boolean;
  showWelcome: boolean;
  theme: 'light' | 'dark' | 'system';
};

interface Window {
  editflow: {
    platform: string;
    openExternal: (url: string) => Promise<boolean>;
    getVersion: () => Promise<string>;
    checkForUpdates: () => Promise<boolean>;
    installUpdate: () => Promise<void>;
    showUpdateLog: () => Promise<boolean>;
    getDesktopPreferences: () => Promise<EditFlowDesktopPreferences>;
    updateDesktopPreferences: (preferences: EditFlowDesktopPreferences) => Promise<EditFlowDesktopPreferences>;
    onDesktopPreferencesChanged: (callback: (preferences: EditFlowDesktopPreferences) => void) => () => void;
    showNativeNotification: (notification: EditFlowNativeNotification) => Promise<boolean>;
    onNativeNotificationClicked: (callback: (target: EditFlowNativeNotificationTarget) => void) => () => void;
    onUpdateStatus: (callback: (status: EditFlowUpdateStatus) => void) => () => void;
  };
}
