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

interface Window {
  editflow: {
    platform: string;
    openExternal: (url: string) => Promise<boolean>;
    getVersion: () => Promise<string>;
    checkForUpdates: () => Promise<boolean>;
    installUpdate: () => Promise<void>;
    onUpdateStatus: (callback: (status: EditFlowUpdateStatus) => void) => () => void;
  };
}
