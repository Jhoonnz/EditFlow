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
  conversationId: string | null;
  workspaceId: string;
};

type EditFlowNativeNotificationTarget = Pick<
  EditFlowNativeNotification,
  'notificationId' | 'taskId' | 'conversationId' | 'workspaceId'
>;

type EditFlowDesktopPreferences = {
  launchAtLogin: boolean;
  closeToTray: boolean;
  showWelcome: boolean;
  nativeNotifications: boolean;
  theme: 'light' | 'dark' | 'system';
};

type EditFlowUsdBrlRate = {
  rate: number;
  fetchedAt: string;
  sourceUpdatedAt: string;
  source: 'AwesomeAPI';
  stale: boolean;
};

type EditFlowFinancialReportRow = {
  client: string;
  description: string;
  date: string;
  source: string;
  currency: 'USD' | 'BRL';
  gross: number;
  fees: number;
  net: number;
  netBrl: number | null;
  status: 'pending' | 'received';
};

type EditFlowFinancialReport = {
  workspaceName: string;
  month: string;
  monthLabel: string;
  generatedAt: string;
  usdBrlRate: number | null;
  totals: {
    grossBrl: number | null;
    feesBrl: number | null;
    netBrl: number | null;
    receivedBrl: number;
    pendingBrl: number | null;
    entries: number;
  };
  rows: EditFlowFinancialReportRow[];
};

type EditFlowFinancialReportResult = {
  cancelled: boolean;
  filePath?: string;
};

interface Window {
  editflow: {
    platform: string;
    openExternal: (url: string) => Promise<boolean>;
    getVersion: () => Promise<string>;
    getUsdBrlRate: () => Promise<EditFlowUsdBrlRate>;
    exportFinancialReport: (report: EditFlowFinancialReport) => Promise<EditFlowFinancialReportResult>;
    getUserActivity: () => Promise<'active' | 'away'>;
    checkForUpdates: () => Promise<boolean>;
    installUpdate: () => Promise<void>;
    showUpdateLog: () => Promise<boolean>;
    getDesktopPreferences: () => Promise<EditFlowDesktopPreferences>;
    updateDesktopPreferences: (preferences: EditFlowDesktopPreferences) => Promise<EditFlowDesktopPreferences>;
    onDesktopPreferencesChanged: (callback: (preferences: EditFlowDesktopPreferences) => void) => () => void;
    showNativeNotification: (notification: EditFlowNativeNotification) => Promise<boolean>;
    onNativeNotificationClicked: (callback: (target: EditFlowNativeNotificationTarget) => void) => () => void;
    onUpdateStatus: (callback: (status: EditFlowUpdateStatus) => void) => () => void;
    getPendingAuthCallback: () => Promise<string | null>;
    onAuthCallback: (callback: (url: string) => void) => () => void;
  };
}
