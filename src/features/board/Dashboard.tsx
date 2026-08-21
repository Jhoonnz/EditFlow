import { type CSSProperties, DragEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RealtimeChannel, User } from '@supabase/supabase-js';
import {
  AlertTriangle,
  Bell,
  CalendarClock,
  ChevronDown,
  CheckCircle2,
  Columns3,
  Download,
  ExternalLink,
  GripVertical,
  History,
  LayoutDashboard,
  Link2,
  LoaderCircle,
  LogOut,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
  WalletCards,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useLatestRequest } from '../../lib/asyncRequest';
import { fetchAllRows } from '../../lib/paginatedQuery';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { useAppDialog } from '../../components/AppDialog';
import { isVisibleDeadline, taskDeadlineDistance } from '../../lib/taskStatus';
import { ChatPanel, type ChatOpenRequest } from '../chat/ChatPanel';
import { FinanceView } from '../finance/FinanceView';
import { ClientsView, SettingsView, TeamView, type SettingsTab } from '../workspace/WorkspaceViews';
import { NotificationsMenu } from './NotificationsMenu';
import type {
  AppNotification,
  Board,
  BoardColumn,
  Client,
  Task,
  TaskActivity,
  TaskComment,
  TaskCommentKind,
  TaskDraft,
  TaskLink,
  TaskLinkCategory,
  TaskPriority,
  WorkspaceSummary,
  WorkspaceMember,
  MemberAvailability,
  WelcomeStartupAction,
} from '../workspace/types';

type Props = {
  user: User;
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  onWorkspaceChange: (id: string) => void;
  onWorkspacesChanged: () => Promise<void>;
  startupAction: WelcomeStartupAction | null;
  onStartupActionHandled: () => void;
};

type SyncStatus = 'connecting' | 'connected' | 'offline' | 'error';
type DashboardView = 'board' | 'clients' | 'team' | 'finance' | 'settings';

const emptyDraft: TaskDraft = {
  title: '',
  description: '',
  priority: 'normal',
  due_at: '',
  client_id: '',
  assignee_id: '',
  revision_round: 1,
};

const columnColors = ['#8b8fa3', '#a78bfa', '#60a5fa', '#f59e0b', '#f97316', '#fb7185', '#34d399', '#22c55e'];

function mergeRealtimeRow<T extends { id: string }>(
  current: T[],
  eventType: string,
  nextRow: Partial<T>,
  previousRow: Partial<T>,
  sort?: (first: T, second: T) => number,
) {
  const rowId = (eventType === 'DELETE' ? previousRow.id : nextRow.id) ?? previousRow.id;
  if (!rowId) return current;
  if (eventType === 'DELETE') return current.filter((row) => row.id !== rowId);

  const existing = current.find((row) => row.id === rowId);
  const merged = existing
    ? current.map((row) => row.id === rowId ? { ...row, ...nextRow } as T : row)
    : [...current, nextRow as T];
  return sort ? merged.slice().sort(sort) : merged;
}

export function Dashboard({ user, workspace, workspaces, onWorkspaceChange, onWorkspacesChanged, startupAction, onStartupActionHandled }: Props) {
  const canManagePlanning = workspace.role === 'owner' || workspace.role === 'admin';
  const [board, setBoard] = useState<Board | null>(null);
  const [columns, setColumns] = useState<BoardColumn[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [links, setLinks] = useState<TaskLink[]>([]);
  const [inboxNotifications, setInboxNotifications] = useState<AppNotification[]>([]);
  const [hasMoreNotifications, setHasMoreNotifications] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(navigator.onLine ? 'connecting' : 'offline');
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [settingsNavigation, setSettingsNavigation] = useState<{ tab: SettingsTab; token: number }>({ tab: 'general', token: 0 });
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [dropColumnId, setDropColumnId] = useState<string | null>(null);
  const [taskDropTarget, setTaskDropTarget] = useState<{ taskId: string; edge: 'before' | 'after' } | null>(null);
  const [draggedColumnId, setDraggedColumnId] = useState<string | null>(null);
  const [columnDropTarget, setColumnDropTarget] = useState<{ columnId: string; edge: 'before' | 'after' } | null>(null);
  const [editor, setEditor] = useState<{ mode: 'new' | 'edit'; task: Task | null; columnId?: string } | null>(null);
  const [view, setView] = useState<DashboardView>('board');
  const [columnMenuId, setColumnMenuId] = useState<string | null>(null);
  const [editingColumn, setEditingColumn] = useState<BoardColumn | null>(null);
  const [creatingColumn, setCreatingColumn] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showWorkspaceMenu, setShowWorkspaceMenu] = useState(false);
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [workspaceDraft, setWorkspaceDraft] = useState('');
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [workspaceDialogError, setWorkspaceDialogError] = useState<string | null>(null);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [showCompletedTasks, setShowCompletedTasks] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [liveNotification, setLiveNotification] = useState<AppNotification | null>(null);
  const [profileMemberId, setProfileMemberId] = useState<string | null>(null);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [chatRequest, setChatRequest] = useState<ChatOpenRequest | null>(null);
  const [presenceActivity, setPresenceActivity] = useState<Record<string, 'active' | 'away'>>({});
  const [presenceReady, setPresenceReady] = useState(false);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notificationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notificationRef = useRef<HTMLDivElement>(null);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  const notificationLimitRef = useRef(30);
  const notificationWorkspaceRef = useRef(workspace.id);
  const boardRef = useRef<Board | null>(null);
  const columnsRef = useRef<BoardColumn[]>([]);
  const tasksRef = useRef<Task[]>([]);
  const membersRef = useRef<WorkspaceMember[]>([]);
  const notificationsRef = useRef<AppNotification[]>([]);
  const { begin: beginBoardRequest, isLatest: isLatestBoardRequest, cancel: cancelBoardRequests } = useLatestRequest();
  const appDialog = useAppDialog();
  useDialogFocus<HTMLElement>(showCreateWorkspace, () => setShowCreateWorkspace(false), !creatingWorkspace, '.workspace-create-dialog');
  useDialogFocus<HTMLElement>(showLogoutConfirm, () => setShowLogoutConfirm(false), !signingOut, '.logout-dialog');
  const handleChatRequestHandled = useCallback(() => setChatRequest(null), []);

  useEffect(() => { boardRef.current = board; }, [board]);
  useEffect(() => { columnsRef.current = columns; }, [columns]);
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);
  useEffect(() => { membersRef.current = members; }, [members]);
  useEffect(() => { notificationsRef.current = inboxNotifications; }, [inboxNotifications]);
  const openSettings = (tab: SettingsTab) => {
    setSettingsNavigation((current) => ({ tab, token: current.token + 1 }));
    setView('settings');
  };
  const navigateTo = async (nextView: DashboardView) => {
    if (view === 'settings' && nextView !== 'settings' && settingsDirty) {
      const discard = await appDialog.confirm({
        title: 'Sair sem salvar?',
        description: 'Existem alterações nas configurações que ainda não foram salvas.',
        confirmLabel: 'Descartar e sair',
        tone: 'danger',
      });
      if (!discard) return;
    }
    setView(nextView);
  };

  useEffect(() => {
    if (!showNotifications) return;
    const closeNotificationsOnOutsidePointer = (event: PointerEvent) => {
      if (!notificationRef.current?.contains(event.target as Node)) setShowNotifications(false);
    };
    document.addEventListener('pointerdown', closeNotificationsOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeNotificationsOnOutsidePointer);
  }, [showNotifications]);

  useEffect(() => {
    if (!showWorkspaceMenu) return;
    const closeWorkspaceMenuOnOutsidePointer = (event: PointerEvent) => {
      if (!workspaceMenuRef.current?.contains(event.target as Node)) setShowWorkspaceMenu(false);
    };
    document.addEventListener('pointerdown', closeWorkspaceMenuOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeWorkspaceMenuOnOutsidePointer);
  }, [showWorkspaceMenu]);

  useEffect(() => {
    if (!columnMenuId) return;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target as Element).closest('.column-header')) setColumnMenuId(null);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setColumnMenuId(null);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [columnMenuId]);

  const createWorkspace = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase || creatingWorkspace) return;
    const workspaceName = workspaceDraft.trim();
    if (workspaceName.length < 2) return setWorkspaceDialogError('Digite um nome com pelo menos 2 caracteres.');
    setCreatingWorkspace(true);
    setWorkspaceDialogError(null);
    const { data: workspaceId, error: createError } = await supabase.rpc('create_workspace', { workspace_name: workspaceName });
    if (createError) {
      setWorkspaceDialogError(createError.message);
      setCreatingWorkspace(false);
      return;
    }
    await onWorkspacesChanged();
    if (workspaceId) onWorkspaceChange(workspaceId as string);
    setCreatingWorkspace(false);
    setShowCreateWorkspace(false);
    setWorkspaceDraft('');
  };

  const signOut = async () => {
    if (!supabase || signingOut) return;
    setSigningOut(true);
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) {
      setError(signOutError.message);
      setSigningOut(false);
      setShowLogoutConfirm(false);
    }
  };

  const loadBoard = useCallback(async (quiet = false) => {
    if (!supabase) return;
    const client = supabase;
    if (notificationWorkspaceRef.current !== workspace.id) {
      notificationWorkspaceRef.current = workspace.id;
      notificationLimitRef.current = 30;
      setHasMoreNotifications(false);
    }
    const requestId = beginBoardRequest();
    if (!quiet) setLoading(true);
    setError(null);

    const { data: boardRow, error: boardError } = await supabase
      .from('boards')
      .select('id, name, workspace_id')
      .eq('workspace_id', workspace.id)
      .order('created_at')
      .limit(1)
      .maybeSingle();

    if (!isLatestBoardRequest(requestId)) return;
    if (boardError || !boardRow) {
      setError(boardError?.message ?? 'Nenhum quadro foi encontrado neste espaço.');
      setSyncStatus(navigator.onLine ? 'error' : 'offline');
      setLoading(false);
      return;
    }

    const currentBoard = boardRow as Board;
    const [columnResult, taskResult, clientResult, membershipResult, notificationResult] = await Promise.all([
      fetchAllRows<BoardColumn>(async (from, to) => await client.from('columns').select('*').eq('board_id', currentBoard.id).order('position').range(from, to)),
      fetchAllRows<Task>(async (from, to) => await client.from('tasks').select('*').eq('board_id', currentBoard.id).order('position').range(from, to)),
      fetchAllRows<Client>(async (from, to) => await client.from('clients').select('*').eq('workspace_id', workspace.id).order('name').range(from, to)),
      supabase.from('workspace_members').select('user_id, role').eq('workspace_id', workspace.id),
      supabase.from('notifications').select('*').eq('workspace_id', workspace.id).eq('user_id', user.id).order('created_at', { ascending: false }).limit(notificationLimitRef.current + 1),
    ]);

    const firstError = columnResult.error ?? taskResult.error ?? clientResult.error ?? membershipResult.error ?? notificationResult.error;
    if (!isLatestBoardRequest(requestId)) return;
    if (firstError) {
      setError(firstError.message);
      setSyncStatus(navigator.onLine ? 'error' : 'offline');
      setLoading(false);
      return;
    }

    const nextTasks = (taskResult.data ?? []) as Task[];
    const memberIds = (membershipResult.data ?? []).map((membership) => membership.user_id as string);
    const memberProfileResult = memberIds.length
      ? await supabase.rpc('get_workspace_member_profiles', { target_workspace: workspace.id })
      : { data: [], error: null };
    let memberProfiles = (memberProfileResult.data ?? []) as Array<{
      user_id: string;
      display_name: string;
      email: string | null;
      avatar_url: string | null;
      availability: MemberAvailability;
      specialty?: string;
      bio?: string;
    }>;
    if (memberProfileResult.error && memberIds.length) {
      const fallbackProfiles = await supabase.from('profiles').select('id, display_name, avatar_url').in('id', memberIds);
      if (!isLatestBoardRequest(requestId)) return;
      if (fallbackProfiles.error) {
        setError(fallbackProfiles.error.message);
        setSyncStatus(navigator.onLine ? 'error' : 'offline');
        setLoading(false);
        return;
      }
      memberProfiles = (fallbackProfiles.data ?? []).map((profile) => ({
        user_id: profile.id as string,
        display_name: profile.display_name as string,
        email: null,
        avatar_url: profile.avatar_url as string | null,
        availability: 'available',
        specialty: '',
        bio: '',
      }));
    }
    const profilesById = new Map(memberProfiles.map((profile) => [profile.user_id, profile]));
    const nextMembers = (membershipResult.data ?? []).map((membership) => ({
      user_id: membership.user_id as string,
      role: membership.role as WorkspaceMember['role'],
      display_name: profilesById.get(membership.user_id as string)?.display_name || 'Membro',
      email: profilesById.get(membership.user_id as string)?.email ?? undefined,
      avatar_url: profilesById.get(membership.user_id as string)?.avatar_url ?? null,
      availability: profilesById.get(membership.user_id as string)?.availability ?? 'available',
      specialty: profilesById.get(membership.user_id as string)?.specialty ?? '',
      bio: profilesById.get(membership.user_id as string)?.bio ?? '',
    }));
    let nextLinks: TaskLink[] = [];
    if (nextTasks.length) {
      const taskIds = nextTasks.map((task) => task.id);
      for (let start = 0; start < taskIds.length; start += 100) {
        const taskIdBatch = taskIds.slice(start, start + 100);
        const linkResult = await fetchAllRows<TaskLink>(async (from, to) => await client
          .from('task_links')
          .select('*')
          .in('task_id', taskIdBatch)
          .order('created_at')
          .range(from, to));
        if (linkResult.error) {
          setError(linkResult.error.message);
          setSyncStatus(navigator.onLine ? 'error' : 'offline');
          setLoading(false);
          return;
        }
        nextLinks.push(...(linkResult.data ?? []));
      }
    }

    if (!isLatestBoardRequest(requestId)) return;

    setBoard(currentBoard);
    setColumns(columnResult.data ?? []);
    setTasks(nextTasks);
    setClients(clientResult.data ?? []);
    setMembers(nextMembers);
    setLinks(nextLinks);
    const nextNotifications = (notificationResult.data ?? []) as AppNotification[];
    setHasMoreNotifications(nextNotifications.length > notificationLimitRef.current);
    const visibleNotifications = nextNotifications.slice(0, notificationLimitRef.current);
    notificationsRef.current = visibleNotifications;
    setInboxNotifications(visibleNotifications);
    setLastSyncedAt(new Date().toISOString());
    if (navigator.onLine) setSyncStatus('connected');
    setLoading(false);
  }, [beginBoardRequest, isLatestBoardRequest, user.id, workspace.id]);

  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => void loadBoard(true), 180);
  }, [loadBoard]);

  const assignTask = useCallback(async (taskId: string, assigneeId: string | null) => {
    if (!supabase || !canManagePlanning) return false;
    setTasks((current) => current.map((task) => task.id === taskId ? { ...task, assignee_id: assigneeId } : task));
    const { error: assignmentError } = await supabase.from('tasks').update({ assignee_id: assigneeId }).eq('id', taskId);
    if (assignmentError) {
      setError(assignmentError.message);
      await loadBoard(true);
      return false;
    }
    await loadBoard(true);
    return true;
  }, [canManagePlanning, loadBoard]);

  useEffect(() => {
    void loadBoard();
    return cancelBoardRequests;
  }, [cancelBoardRequests, loadBoard]);

  useEffect(() => {
    setProfileMemberId(null);
  }, [workspace.id]);

  useEffect(() => {
    if (!canManagePlanning && view === 'clients') setView('board');
  }, [canManagePlanning, view]);

  useEffect(() => {
    if (workspace.role !== 'owner' && view === 'finance') setView('board');
  }, [view, workspace.role]);

  useEffect(() => {
    if (!supabase) return;
    const realtimeClient = supabase;
    let channels: RealtimeChannel[] = [];
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let generation = 0;
    let coreSubscribed = false;

    const removeChannels = () => {
      const previousChannels = channels;
      channels = [];
      previousChannels.forEach((channel) => void realtimeClient.removeChannel(channel));
    };

    const scheduleReconnect = () => {
      if (disposed || !navigator.onLine || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 2_000);
    };

    const noteRealtimeChange = () => {
      setLastSyncedAt(new Date().toISOString());
      setSyncStatus('connected');
    };

    const loadLinksForTask = async (taskId: string) => {
      const { data, error: linkError } = await realtimeClient
        .from('task_links')
        .select('*')
        .eq('task_id', taskId)
        .order('created_at');
      if (disposed || linkError) return;
      setLinks((current) => {
        const withoutTask = current.filter((link) => link.task_id !== taskId);
        return [...withoutTask, ...((data ?? []) as TaskLink[])];
      });
    };

    const connect = () => {
      if (disposed) return;
      generation += 1;
      const connectionGeneration = generation;
      coreSubscribed = false;
      setSyncStatus(navigator.onLine ? 'connecting' : 'offline');
      removeChannels();

      const channelName = (scope: string) => `editflow-${scope}:${workspace.id}:${user.id}:${generation}`;
      const subscribe = (channel: RealtimeChannel, core = false) => {
        channels.push(channel);
        channel.subscribe((status) => {
          if (disposed || connectionGeneration !== generation) return;
          if (core && status === 'SUBSCRIBED') {
            coreSubscribed = true;
            setSyncStatus('connected');
            scheduleReload();
          } else if (core && (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED')) {
            coreSubscribed = false;
            setSyncStatus(navigator.onLine ? 'error' : 'offline');
            scheduleReconnect();
          }
        });
      };

      subscribe(realtimeClient
        .channel(channelName('tasks'))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `workspace_id=eq.${workspace.id}` }, (payload) => {
          const nextTask = payload.new as Partial<Task>;
          const previousTask = payload.old as Partial<Task>;
          setTasks((current) => mergeRealtimeRow(current, payload.eventType, nextTask, previousTask, (first, second) => Number(first.position) - Number(second.position)));
          if (payload.eventType === 'DELETE' && previousTask.id) {
            setLinks((current) => current.filter((link) => link.task_id !== previousTask.id));
          } else if (payload.eventType === 'INSERT' && nextTask.id) {
            void loadLinksForTask(nextTask.id);
          }
          noteRealtimeChange();
        }), true);

      subscribe(realtimeClient
        .channel(channelName('clients'))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'clients', filter: `workspace_id=eq.${workspace.id}` }, (payload) => {
          setClients((current) => mergeRealtimeRow(current, payload.eventType, payload.new as Partial<Client>, payload.old as Partial<Client>, (first, second) => first.name.localeCompare(second.name, 'pt-BR')));
          noteRealtimeChange();
        }));

      subscribe(realtimeClient
        .channel(channelName('board-support'))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'task_links' }, (payload) => {
          const nextLink = payload.new as Partial<TaskLink>;
          const previousLink = payload.old as Partial<TaskLink>;
          const taskId = nextLink.task_id ?? previousLink.task_id;
          const belongsToBoard = taskId ? tasksRef.current.some((task) => task.id === taskId) : payload.eventType === 'DELETE';
          if (!belongsToBoard) return;
          setLinks((current) => mergeRealtimeRow(current, payload.eventType, nextLink, previousLink, (first, second) => first.created_at.localeCompare(second.created_at)));
          noteRealtimeChange();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'columns' }, (payload) => {
          const nextColumn = payload.new as Partial<BoardColumn>;
          const previousColumn = payload.old as Partial<BoardColumn>;
          const belongsToBoard = nextColumn.board_id === boardRef.current?.id
            || columnsRef.current.some((column) => column.id === (nextColumn.id ?? previousColumn.id));
          if (!belongsToBoard) return;
          setColumns((current) => mergeRealtimeRow(current, payload.eventType, nextColumn, previousColumn, (first, second) => Number(first.position) - Number(second.position)));
          noteRealtimeChange();
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, (payload) => {
          const profile = payload.new as { id?: string; display_name?: string; avatar_url?: string | null; specialty?: string; bio?: string };
          if (!profile.id || !membersRef.current.some((member) => member.user_id === profile.id)) return;
          setMembers((current) => current.map((member) => member.user_id === profile.id ? {
            ...member,
            display_name: profile.display_name ?? member.display_name,
            avatar_url: Object.prototype.hasOwnProperty.call(profile, 'avatar_url') ? profile.avatar_url ?? null : member.avatar_url,
            specialty: profile.specialty ?? member.specialty,
            bio: profile.bio ?? member.bio,
          } : member));
          noteRealtimeChange();
        }));

      subscribe(realtimeClient
        .channel(channelName('members'))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'workspace_members', filter: `workspace_id=eq.${workspace.id}` }, () => { scheduleReload(); void onWorkspacesChanged(); }));

      subscribe(realtimeClient
        .channel(channelName('notifications'))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${user.id}` }, (payload) => {
          const notification = payload.new as Partial<AppNotification>;
          const previousNotification = payload.old as Partial<AppNotification>;
          const targetWorkspace = notification.workspace_id ?? previousNotification.workspace_id;
          if (targetWorkspace === workspace.id) {
            const merged = mergeRealtimeRow(notificationsRef.current, payload.eventType, notification, previousNotification, (first, second) => second.created_at.localeCompare(first.created_at));
            setHasMoreNotifications((current) => current || merged.length > notificationLimitRef.current);
            const visibleNotifications = merged.slice(0, notificationLimitRef.current);
            notificationsRef.current = visibleNotifications;
            setInboxNotifications(visibleNotifications);
            noteRealtimeChange();
          }
          if (payload.eventType !== 'INSERT' || !notification.id || !notification.type || !notification.message || !notification.workspace_id) return;
          const insertedNotification = notification as AppNotification;
          void window.editflow.showNativeNotification({
            notificationId: insertedNotification.id,
            title: nativeNotificationTitle(insertedNotification.type),
            body: insertedNotification.message,
            taskId: insertedNotification.task_id,
            conversationId: insertedNotification.conversation_id,
            workspaceId: insertedNotification.workspace_id,
          });
          if (insertedNotification.workspace_id !== workspace.id) return;
          setLiveNotification(insertedNotification);
          if (notificationTimer.current) clearTimeout(notificationTimer.current);
          notificationTimer.current = setTimeout(() => setLiveNotification(null), 6500);
        }));
    };

    const handleOnline = () => { connect(); scheduleReload(); };
    const handleOffline = () => setSyncStatus('offline');
    const handleFocus = () => {
      scheduleReload();
      if (!coreSubscribed && navigator.onLine) connect();
    };
    connect();
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('focus', handleFocus);
    const reconciliationTimer = window.setInterval(() => {
      if (navigator.onLine && document.visibilityState === 'visible') scheduleReload();
    }, 45_000);

    return () => {
      disposed = true;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('focus', handleFocus);
      window.clearInterval(reconciliationTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      removeChannels();
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      if (notificationTimer.current) clearTimeout(notificationTimer.current);
    };
  }, [onWorkspacesChanged, scheduleReload, user.id, workspace.id]);

  useEffect(() => {
    if (!supabase) return;
    const realtimeClient = supabase;
    let lastActivity: 'active' | 'away' | null = null;
    let disposed = false;
    const presenceChannel = realtimeClient.channel(`editflow-presence:${workspace.id}`, {
      config: { presence: { key: user.id } },
    });

    const readPresence = () => {
      const presenceState = presenceChannel.presenceState() as unknown as Record<string, Array<{ activity?: string }>>;
      const nextPresence: Record<string, 'active' | 'away'> = {};
      for (const [memberId, sessions] of Object.entries(presenceState)) {
        if (sessions.some((session) => session.activity === 'active')) nextPresence[memberId] = 'active';
        else if (sessions.length) nextPresence[memberId] = 'away';
      }
      setPresenceActivity(nextPresence);
      setPresenceReady(true);
    };

    const publishActivity = async (force = false) => {
      if (disposed) return;
      const activity = await window.editflow.getUserActivity();
      if (!force && activity === lastActivity) return;
      lastActivity = activity;
      await presenceChannel.track({ user_id: user.id, activity, changed_at: new Date().toISOString() });
    };

    presenceChannel
      .on('presence', { event: 'sync' }, readPresence)
      .on('presence', { event: 'join' }, readPresence)
      .on('presence', { event: 'leave' }, readPresence)
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') void publishActivity(true);
      });

    const activityTimer = window.setInterval(() => void publishActivity(), 15_000);
    const handleVisibility = () => { if (document.visibilityState === 'visible') void publishActivity(); };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      disposed = true;
      window.clearInterval(activityTimer);
      document.removeEventListener('visibilitychange', handleVisibility);
      setPresenceActivity({});
      setPresenceReady(false);
      void presenceChannel.untrack().finally(() => realtimeClient.removeChannel(presenceChannel));
    };
  }, [user.id, workspace.id]);

  const liveMembers = useMemo(() => members.map((member) => {
    if (!presenceReady) return member;
    const activity = presenceActivity[member.user_id];
    const availability: MemberAvailability = !activity
      ? 'offline'
      : activity === 'away'
        ? 'away'
        : tasks.some((task) => task.assignee_id === member.user_id && !task.completed_at)
          ? 'busy'
          : 'available';
    return { ...member, availability };
  }), [members, presenceActivity, presenceReady, tasks]);
  const currentUserMember = liveMembers.find((member) => member.user_id === user.id);
  const completionColumn = columns.find((column) => column.is_completion) ?? columns.at(-1) ?? null;

  const filteredTasks = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('pt-BR');
    if (!term) return tasks;
    return tasks.filter((task) => {
      const client = clients.find((item) => item.id === task.client_id);
      const assignee = liveMembers.find((item) => item.user_id === task.assignee_id);
      return `${task.title} ${task.description} ${client?.name ?? ''} ${assignee?.display_name ?? ''}`.toLocaleLowerCase('pt-BR').includes(term);
    });
  }, [clients, liveMembers, search, tasks]);

  const tasksByColumn = useMemo(() => {
    const grouped = new Map<string, Task[]>();
    columns.forEach((column) => grouped.set(column.id, []));
    filteredTasks
      .slice()
      .sort((first, second) => Number(first.position) - Number(second.position))
      .forEach((task) => grouped.get(task.column_id)?.push(task));
    return grouped;
  }, [columns, filteredTasks]);

  const moveTask = async (taskId: string, targetColumnId: string, beforeTaskId: string | null) => {
    if (!supabase || !board) return;
    const originalTasks = tasks;
    const movingTask = originalTasks.find((item) => item.id === taskId);
    if (!movingTask || beforeTaskId === taskId) return;

    const grouped = new Map<string, Task[]>();
    columns.forEach((column) => grouped.set(column.id, []));
    originalTasks
      .filter((item) => item.id !== taskId)
      .slice()
      .sort((first, second) => Number(first.position) - Number(second.position))
      .forEach((item) => grouped.get(item.column_id)?.push(item));

    const targetTasks = grouped.get(targetColumnId);
    if (!targetTasks) return;
    const insertionIndex = beforeTaskId
      ? targetTasks.findIndex((item) => item.id === beforeTaskId)
      : targetTasks.length;
    targetTasks.splice(insertionIndex < 0 ? targetTasks.length : insertionIndex, 0, { ...movingTask, column_id: targetColumnId });

    const orderedById = new Map<string, Task>();
    grouped.forEach((columnTasks, columnId) => {
      columnTasks.forEach((item, index) => {
        orderedById.set(item.id, { ...item, column_id: columnId, position: (index + 1) * 1000 });
      });
    });
    const nextTasks = originalTasks.map((item) => orderedById.get(item.id) ?? item);
    const orderChanged = nextTasks.some((item, index) => (
      item.column_id !== originalTasks[index].column_id
      || Number(item.position) !== Number(originalTasks[index].position)
    ));
    if (!orderChanged) return;

    setTasks(nextTasks);
    setError(null);
    const { error: reorderError } = await supabase.rpc('reorder_tasks', {
      target_board: board.id,
      ordered_items: nextTasks.map((item) => ({ id: item.id, column_id: item.column_id, position: item.position })),
    });
    if (reorderError) {
      setTasks(originalTasks);
      setError(reorderError.message);
      await loadBoard(true);
    }
  };

  const finishTaskDrag = () => {
    setDropColumnId(null);
    setTaskDropTarget(null);
    setDraggedTaskId(null);
  };

  const handleColumnTaskDrop = (event: DragEvent, columnId: string) => {
    event.preventDefault();
    const taskId = event.dataTransfer.getData('text/editflow-task') || draggedTaskId;
    finishTaskDrag();
    if (taskId) void moveTask(taskId, columnId, null);
  };

  const handleTaskDrop = (event: DragEvent, targetTask: Task, edge: 'before' | 'after') => {
    event.preventDefault();
    event.stopPropagation();
    const taskId = event.dataTransfer.getData('text/editflow-task') || draggedTaskId;
    const columnTasks = tasks
      .filter((item) => item.column_id === targetTask.column_id && item.id !== taskId)
      .sort((first, second) => Number(first.position) - Number(second.position));
    const targetIndex = columnTasks.findIndex((item) => item.id === targetTask.id);
    const beforeTaskId = edge === 'before'
      ? targetTask.id
      : columnTasks[targetIndex + 1]?.id ?? null;
    finishTaskDrag();
    if (taskId) void moveTask(taskId, targetTask.column_id, beforeTaskId);
  };

  const reorderColumn = async (columnId: string, targetColumnId: string, edge: 'before' | 'after') => {
    if (!supabase || !board || !canManagePlanning || columnId === targetColumnId) return;
    const originalColumns = columns;
    const movingColumn = originalColumns.find((column) => column.id === columnId);
    if (!movingColumn) return;
    const nextColumns = originalColumns.filter((column) => column.id !== columnId);
    const targetIndex = nextColumns.findIndex((column) => column.id === targetColumnId);
    if (targetIndex < 0) return;
    nextColumns.splice(targetIndex + (edge === 'after' ? 1 : 0), 0, movingColumn);
    const positionedColumns = nextColumns.map((column, index) => ({ ...column, position: (index + 1) * 1000 }));
    setColumns(positionedColumns);
    setError(null);
    const { error: reorderError } = await supabase.rpc('reorder_columns', {
      target_board: board.id,
      ordered_column_ids: positionedColumns.map((column) => column.id),
    });
    if (reorderError) {
      setColumns(originalColumns);
      setError(reorderError.message);
      await loadBoard(true);
    }
  };

  const finishColumnDrag = () => {
    setDraggedColumnId(null);
    setColumnDropTarget(null);
  };

  const deadlineNotifications = useMemo(() => tasks
    .filter((task) => isVisibleDeadline(task))
    .map((task) => ({ task, distance: taskDeadlineDistance(task)! }))
    .sort((a, b) => a.distance - b.distance), [tasks]);

  const unreadNotifications = inboxNotifications.filter((notification) => !notification.read_at);

  const openInboxNotification = async (notification: AppNotification) => {
    if (notification.conversation_id) {
      setChatRequest({ token: Date.now(), conversationId: notification.conversation_id });
    }
    if (notification.type === 'invite_accepted') {
      setView('team');
    }
    const notificationTask = tasks.find((task) => task.id === notification.task_id);
    if (notificationTask) {
      setView('board');
      setEditor({ mode: 'edit', task: notificationTask });
    }
    setShowNotifications(false);
    if (!supabase || notification.read_at) return;
    const readAt = new Date().toISOString();
    setInboxNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, read_at: readAt } : item));
    const { error: readError } = await supabase.from('notifications').update({ read_at: readAt }).eq('id', notification.id);
    if (readError) {
      setInboxNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, read_at: null } : item));
      setError(readError.message);
    }
  };

  const markAllNotificationsRead = async () => {
    if (!supabase || !unreadNotifications.length) return;
    const readAt = new Date().toISOString();
    const previousNotifications = inboxNotifications;
    setInboxNotifications((current) => current.map((item) => ({ ...item, read_at: item.read_at ?? readAt })));
    const { error: readError } = await supabase.from('notifications').update({ read_at: readAt }).eq('workspace_id', workspace.id).eq('user_id', user.id).is('read_at', null);
    if (readError) {
      setInboxNotifications(previousNotifications);
      setError(readError.message);
    }
  };

  const loadMoreNotifications = async () => {
    notificationLimitRef.current += 30;
    await loadBoard(true);
  };

  useEffect(() => window.editflow.onNativeNotificationClicked((target) => {
    if (target.workspaceId !== workspace.id) {
      window.sessionStorage.setItem('editflow:pending-notification', JSON.stringify(target));
      onWorkspaceChange(target.workspaceId);
      return;
    }

    const notification = inboxNotifications.find((item) => item.id === target.notificationId);
    if (notification) {
      void openInboxNotification(notification);
      return;
    }

    if (target.conversationId) {
      setChatRequest({ token: Date.now(), conversationId: target.conversationId });
      return;
    }

    const notificationTask = tasks.find((task) => task.id === target.taskId);
    if (notificationTask) {
      setView('board');
      setEditor({ mode: 'edit', task: notificationTask });
    }
  }), [inboxNotifications, onWorkspaceChange, tasks, workspace.id]);

  useEffect(() => {
    const storedTarget = window.sessionStorage.getItem('editflow:pending-notification');
    if (!storedTarget) return;

    try {
      const target = JSON.parse(storedTarget) as EditFlowNativeNotificationTarget;
      if (target.workspaceId !== workspace.id) return;
      if (target.conversationId) {
        window.sessionStorage.removeItem('editflow:pending-notification');
        setChatRequest({ token: Date.now(), conversationId: target.conversationId });
        return;
      }
      const notificationTask = tasks.find((task) => task.id === target.taskId);
      if (!notificationTask) return;
      window.sessionStorage.removeItem('editflow:pending-notification');
      setView('board');
      setEditor({ mode: 'edit', task: notificationTask });
    } catch {
      window.sessionStorage.removeItem('editflow:pending-notification');
    }
  }, [tasks, workspace.id]);

  useEffect(() => {
    if (!startupAction || loading) return;
    if (startupAction.kind === 'notifications') {
      setShowNotifications(true);
      onStartupActionHandled();
      return;
    }
    if (startupAction.kind === 'task') {
      const targetTask = tasks.find((task) => task.id === startupAction.taskId);
      if (!targetTask) return;
      setView('board');
      setEditor({ mode: 'edit', task: targetTask });
    }
    onStartupActionHandled();
  }, [loading, onStartupActionHandled, startupAction, tasks]);

  if (loading) {
    return <main className="app-loading"><LoaderCircle className="spinner" size={26} /></main>;
  }

  return (
    <main className="dashboard-shell">
      <aside className="app-sidebar">
        <div className="sidebar-brand"><span className="sidebar-logo"><Sparkles size={18} /></span><span>EditFlow</span></div>

        <div className="workspace-switcher" ref={workspaceMenuRef}>
          <button type="button" className="workspace-switcher-trigger" aria-expanded={showWorkspaceMenu} onClick={() => setShowWorkspaceMenu((show) => !show)}>
            <span className="workspace-avatar">{workspace.name.slice(0, 1).toUpperCase()}</span>
            <span className="workspace-trigger-copy"><strong>{workspace.name}</strong><small>{roleLabel(workspace.role)}</small></span>
            <ChevronDown className={showWorkspaceMenu ? 'open' : ''} size={15} />
          </button>
          {showWorkspaceMenu ? <div className="workspace-switcher-menu">
            <strong>ESPAÇOS DE TRABALHO</strong>
            {workspaces.map((item) => <button type="button" className={item.id === workspace.id ? 'selected' : ''} key={item.id} onClick={() => { onWorkspaceChange(item.id); setShowWorkspaceMenu(false); }}><span className="workspace-menu-avatar">{item.name.slice(0,1).toUpperCase()}</span><span><b>{item.name}</b><small>{roleLabel(item.role)}</small></span>{item.id === workspace.id ? <CheckCircle2 size={14} /> : null}</button>)}
            <button type="button" className="workspace-create-button" onClick={() => { setShowWorkspaceMenu(false); setWorkspaceDialogError(null); setShowCreateWorkspace(true); }}><span><Plus size={15} /></span><span><b>Criar nova equipe</b><small>Configurar outro espaço</small></span></button>
          </div> : null}
        </div>

        <nav className="sidebar-nav" aria-label="Navegação principal">
          <button className={`nav-item ${view === 'board' ? 'active' : ''}`} onClick={() => void navigateTo('board')}><LayoutDashboard size={18} /><span>Produção</span></button>
          {canManagePlanning ? <button className={`nav-item ${view === 'clients' ? 'active' : ''}`} onClick={() => void navigateTo('clients')}><Users size={18} /><span>Clientes</span><small>{clients.length}</small></button> : null}
          <button className={`nav-item ${view === 'team' ? 'active' : ''}`} onClick={() => void navigateTo('team')}><Users size={18} /><span>Equipe</span><small>{liveMembers.length}</small></button>
          {workspace.role === 'owner' ? <button className={`nav-item ${view === 'finance' ? 'active' : ''}`} onClick={() => void navigateTo('finance')}><WalletCards size={18} /><span>Ganhos</span></button> : null}
        </nav>

        <div className="sidebar-spacer" />
        <button type="button" className={`sync-pill ${syncStatus}`} onClick={scheduleReload} title={syncStatusTitle(syncStatus, lastSyncedAt)}>
          {syncStatus === 'offline' || syncStatus === 'error' ? <WifiOff size={14} /> : <Wifi size={14} />}
          <span>{syncLabel(syncStatus)}</span>
        </button>
        <button className={`nav-item ${view === 'settings' ? 'active' : ''}`} onClick={() => openSettings('general')}><Settings size={18} /><span>Configurações</span></button>
        <div className="account-row">
          <button type="button" className="account-profile-button" onClick={() => openSettings('profile')} title="Abrir meu perfil">
            <span className="user-avatar">{currentUserMember?.avatar_url ? <img src={currentUserMember.avatar_url} alt="Sua foto de perfil" /> : (user.email?.[0] ?? 'U').toUpperCase()}</span>
            <span className="account-copy"><strong>{currentUserMember?.display_name || user.user_metadata.full_name || 'Minha conta'}</strong><small>{user.email}</small></span>
          </button>
          <button type="button" className="account-logout-button" onClick={() => setShowLogoutConfirm(true)} title="Sair da conta" aria-label="Sair da conta"><LogOut size={16} /></button>
        </div>
      </aside>

      <section className="dashboard-main">
        <header className="dashboard-header">
          <div>
            <p>ESPAÇO DE TRABALHO</p>
            <h1>{view === 'board' ? board?.name ?? 'Produção' : view === 'clients' ? 'Clientes' : view === 'team' ? 'Equipe' : view === 'finance' ? 'Ganhos' : 'Configurações'}</h1>
          </div>
          <div className="header-actions">
            <div className="notification-wrap" ref={notificationRef}>
              <button className={`round-action ${unreadNotifications.length || deadlineNotifications.length ? 'has-notifications' : ''}`} aria-label="Notificações" onClick={() => setShowNotifications((show) => !show)}><Bell size={19} />{unreadNotifications.length ? <i /> : null}</button>
              {showNotifications ? (
                <NotificationsMenu
                  notifications={inboxNotifications}
                  deadlines={deadlineNotifications}
                  members={members}
                  onOpenNotification={(notification) => void openInboxNotification(notification)}
                  onOpenDeadline={(task) => { setView('board'); setEditor({ mode: 'edit', task }); setShowNotifications(false); }}
                  onMarkAllRead={() => void markAllNotificationsRead()}
                  hasMore={hasMoreNotifications}
                  onLoadMore={() => void loadMoreNotifications()}
                  onOpenSettings={() => { setShowNotifications(false); openSettings('application'); }}
                />
              ) : null}
            </div>
            {view === 'board' && canManagePlanning ? <button className="new-task-button" onClick={() => setEditor({ mode: 'new', task: null, columnId: columns[0]?.id })}><Plus size={18} />Nova tarefa</button> : null}
          </div>
        </header>

        {view === 'board' ? <div className="board-toolbar">
          <label className="board-search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar trabalhos ou clientes..." /></label>
          <div className="board-toolbar-actions">
            <span className="task-total">{tasks.length} {tasks.length === 1 ? 'trabalho' : 'trabalhos'}</span>
            {canManagePlanning ? <button className="new-column-button" onClick={() => setCreatingColumn(true)}><Columns3 size={16} />Nova coluna</button> : <span className="editor-scope-label">Somente tarefas atribuídas a você</span>}
          </div>
        </div> : null}

        {error ? <div className="board-error"><span>{error}</span><button onClick={() => void loadBoard()}>Tentar novamente</button></div> : null}

        {view === 'board' ? <div className="kanban-board">
          {columns.map((column) => {
            const columnTasks = tasksByColumn.get(column.id) ?? [];
            const isCompletionColumn = column.id === completionColumn?.id;
            const visibleColumnTasks = isCompletionColumn
              ? columnTasks.slice().sort((first, second) => completedTaskTime(second) - completedTaskTime(first)).slice(0, 10)
              : columnTasks;
            return (
              <section
                className={`kanban-column ${dropColumnId === column.id ? 'drop-active' : ''} ${columnDropTarget?.columnId === column.id ? `column-drop-${columnDropTarget.edge}` : ''}`}
                key={column.id}
                onDragOver={(event) => {
                  event.preventDefault();
                  if (event.dataTransfer.types.includes('text/editflow-column')) {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setColumnDropTarget({ columnId: column.id, edge: event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after' });
                    setDropColumnId(null);
                  } else {
                    setDropColumnId(column.id);
                  }
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                    setDropColumnId(null);
                    setColumnDropTarget(null);
                  }
                }}
                onDrop={(event) => {
                  const sourceColumnId = event.dataTransfer.getData('text/editflow-column') || draggedColumnId;
                  if (sourceColumnId) {
                    event.preventDefault();
                    const bounds = event.currentTarget.getBoundingClientRect();
                    const edge = event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after';
                    finishColumnDrag();
                    void reorderColumn(sourceColumnId, column.id, edge);
                    return;
                  }
                  handleColumnTaskDrop(event, column.id);
                }}
              >
                <header className="column-header">
                  {canManagePlanning ? <button
                    className="column-drag-handle"
                    draggable
                    title="Arrastar coluna"
                    aria-label={`Reordenar ${column.name}`}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/editflow-column', column.id);
                      setDraggedColumnId(column.id);
                    }}
                    onDragEnd={finishColumnDrag}
                  ><GripVertical size={15} /></button> : null}
                  <span className="column-dot" style={{ background: column.color ?? '#8b8fa3' }} />
                  <h2>{column.name}</h2>
                  <span className="column-count">{columnTasks.length}</span>
                  {canManagePlanning ? <button aria-label={`Opções de ${column.name}`} onClick={() => setColumnMenuId((current) => current === column.id ? null : column.id)}><MoreHorizontal size={17} /></button> : null}
                  {canManagePlanning && columnMenuId === column.id ? (
                    <div className="column-menu">
                      <button onClick={() => { setEditingColumn(column); setColumnMenuId(null); }}>Editar e gerenciar</button>
                    </div>
                  ) : null}
                </header>

                <div className="column-cards">
                  {visibleColumnTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      column={column}
                      completedVariant={isCompletionColumn}
                      progressPercent={Math.round(((columns.findIndex((item) => item.id === column.id) + 1) / Math.max(columns.length, 1)) * 100)}
                      client={clients.find((client) => client.id === task.client_id)}
                      assignee={liveMembers.find((member) => member.user_id === task.assignee_id)}
                      members={liveMembers}
                      canAssign={canManagePlanning}
                      taskLinks={links.filter((link) => link.task_id === task.id)}
                      onOpen={() => setEditor({ mode: 'edit', task })}
                      onOpenProfile={(memberId) => setProfileMemberId(memberId)}
                      onAssign={(assigneeId) => assignTask(task.id, assigneeId)}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/editflow-task', task.id);
                        setDraggedTaskId(task.id);
                      }}
                      onDragEnd={finishTaskDrag}
                      onDragOver={(event) => {
                        if (!draggedTaskId && !event.dataTransfer.types.includes('text/editflow-task')) return;
                        event.preventDefault();
                        event.stopPropagation();
                        const bounds = event.currentTarget.getBoundingClientRect();
                        setTaskDropTarget({ taskId: task.id, edge: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after' });
                      }}
                      onDrop={(event) => {
                        const bounds = event.currentTarget.getBoundingClientRect();
                        handleTaskDrop(event, task, event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after');
                      }}
                      dragging={draggedTaskId === task.id}
                      dropEdge={taskDropTarget?.taskId === task.id ? taskDropTarget.edge : null}
                      dragEnabled={!search.trim()}
                    />
                  ))}
                  {!columnTasks.length ? <div className="empty-column">Arraste uma tarefa para cá</div> : null}
                </div>

                {isCompletionColumn && columnTasks.length ? (
                  <button className="column-add" type="button" onClick={() => setShowCompletedTasks(true)}>Ver todos os finalizados</button>
                ) : null}

                {canManagePlanning && column.id === columns[0]?.id ? <button className="column-add" onClick={() => setEditor({ mode: 'new', task: null, columnId: column.id })}><Plus size={16} />Adicionar tarefa</button> : null}
              </section>
            );
          })}
        </div> : null}
        {view === 'clients' && canManagePlanning ? <ClientsView workspace={workspace} clients={clients} tasks={tasks} onChanged={() => loadBoard(true)} /> : null}
        {view === 'team' ? <TeamView userId={user.id} workspace={workspace} members={liveMembers} tasks={tasks} onChanged={() => loadBoard(true)} onMemberProfile={setProfileMemberId} onMemberTasks={(member) => { setSearch(member.display_name); setView('board'); }} /> : null}
        {view === 'finance' && workspace.role === 'owner' ? <FinanceView workspace={workspace} clients={clients} tasks={tasks} /> : null}
        {view === 'settings' ? <SettingsView user={user} workspace={workspace} tasks={tasks} currentAvailability={currentUserMember?.availability ?? 'offline'} requestedTab={settingsNavigation.tab} requestedTabToken={settingsNavigation.token} onDirtyChange={setSettingsDirty} onWorkspacesChanged={onWorkspacesChanged} onProfileChanged={async (profile) => {
          if (profile) setMembers((current) => current.map((member) => member.user_id === user.id ? {
            ...member,
            ...('displayName' in profile ? { display_name: profile.displayName } : {}),
            ...('avatarUrl' in profile ? { avatar_url: profile.avatarUrl } : {}),
          } : member));
          await loadBoard(true);
        }} /> : null}
      </section>

      {editor && board && columns[0] ? (
        <TaskEditor
          key={`${editor.mode}:${editor.task?.id ?? editor.columnId ?? 'new'}`}
          mode={editor.mode}
          task={editor.task}
          board={board}
          firstColumn={columns.find((column) => column.id === editor.columnId) ?? columns[0]}
          workspace={workspace}
          clients={clients}
          members={liveMembers}
          columns={columns}
          links={editor.task ? links.filter((link) => link.task_id === editor.task?.id) : []}
          userId={user.id}
          canManagePlanning={canManagePlanning}
          onClose={() => setEditor(null)}
          onChanged={async () => { await loadBoard(true); setEditor(null); }}
          onLinksChanged={async () => { await loadBoard(true); }}
        />
      ) : null}
      {showCompletedTasks && completionColumn ? (
        <CompletedTasksModal
          tasks={tasks.filter((task) => task.column_id === completionColumn.id)}
          clients={clients}
          onClose={() => setShowCompletedTasks(false)}
          onOpenTask={(task) => { setShowCompletedTasks(false); setEditor({ mode: 'edit', task }); }}
        />
      ) : null}
      {profileMemberId && liveMembers.find((member) => member.user_id === profileMemberId) ? (
        <MemberProfilePanel
          member={liveMembers.find((member) => member.user_id === profileMemberId)!}
          currentUserId={user.id}
          workspace={workspace}
          tasks={tasks}
          columns={columns}
          clients={clients}
          canManage={canManagePlanning}
          onClose={() => setProfileMemberId(null)}
          onMessage={(memberId) => { setProfileMemberId(null); setChatRequest({ token: Date.now(), memberId }); }}
          onOpenTask={(task) => { setProfileMemberId(null); setView('board'); setEditor({ mode: 'edit', task }); }}
          onChanged={async () => { await loadBoard(true); await onWorkspacesChanged(); }}
          onRemoved={async () => { setProfileMemberId(null); await loadBoard(true); await onWorkspacesChanged(); }}
        />
      ) : null}
      {editingColumn && canManagePlanning ? (
        <ColumnEditor
          column={editingColumn}
          boardId={editingColumn.board_id}
          initialPosition={editingColumn.position}
          taskCount={tasks.filter((task) => task.column_id === editingColumn.id).length}
          totalColumns={columns.length}
          onClose={() => setEditingColumn(null)}
          onChanged={async () => { await loadBoard(true); setEditingColumn(null); }}
        />
      ) : null}
      {creatingColumn && board && canManagePlanning ? (
        <ColumnEditor
          column={null}
          boardId={board.id}
          initialPosition={Math.max(0, ...columns.map((column) => Number(column.position))) + 1000}
          taskCount={0}
          totalColumns={columns.length}
          onClose={() => setCreatingColumn(false)}
          onChanged={async () => { await loadBoard(true); setCreatingColumn(false); }}
        />
      ) : null}
      <ChatPanel
        workspace={workspace}
        currentUserId={user.id}
        members={liveMembers}
        request={chatRequest}
        onRequestHandled={handleChatRequestHandled}
        onOpenProfile={setProfileMemberId}
      />
      {liveNotification ? (
        <aside className="live-notification" role="status" aria-live="polite">
          <span className="live-notification-icon"><Bell size={18} /></span>
          <button className="live-notification-copy" onClick={() => { void openInboxNotification(liveNotification); setLiveNotification(null); }}>
            <strong>Nova notificação</strong>
            <small>{liveNotification.message}</small>
          </button>
          <button className="live-notification-close" aria-label="Fechar notificação" onClick={() => setLiveNotification(null)}><X size={16} /></button>
        </aside>
      ) : null}
      {showCreateWorkspace ? <div className="app-dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget && !creatingWorkspace) setShowCreateWorkspace(false); }}>
        <section className="app-dialog workspace-create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-workspace-title">
          <header><span className="app-dialog-icon"><Plus size={20} /></span><div><p>NOVO ESPAÇO</p><h2 id="create-workspace-title">Criar outra equipe</h2><small>Um novo quadro de produção será configurado automaticamente.</small></div></header>
          <form onSubmit={(event) => void createWorkspace(event)}>
            <label><span>Nome da equipe ou empresa</span><input autoFocus value={workspaceDraft} onChange={(event) => setWorkspaceDraft(event.target.value)} placeholder="Ex.: Novo estúdio" maxLength={80} disabled={creatingWorkspace} /></label>
            {workspaceDialogError ? <div className="app-dialog-error">{workspaceDialogError}</div> : null}
            <footer><button type="button" className="app-dialog-cancel" disabled={creatingWorkspace} onClick={() => setShowCreateWorkspace(false)}>Cancelar</button><button type="submit" className="app-dialog-confirm" disabled={creatingWorkspace || workspaceDraft.trim().length < 2}>{creatingWorkspace ? <LoaderCircle className="spinner" size={15} /> : <Plus size={15} />}Criar equipe</button></footer>
          </form>
        </section>
      </div> : null}
      {showLogoutConfirm ? <div className="app-dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget && !signingOut) setShowLogoutConfirm(false); }}>
        <section className="app-dialog logout-dialog" role="alertdialog" aria-modal="true" aria-labelledby="logout-title" aria-describedby="logout-description">
          <header><span className="app-dialog-icon danger"><LogOut size={20} /></span><div><p>CONFIRMAR SAÍDA</p><h2 id="logout-title">Sair do EditFlow?</h2><small id="logout-description">Você precisará entrar novamente para acessar suas equipes.</small></div></header>
          <footer><button type="button" className="app-dialog-cancel" autoFocus disabled={signingOut} onClick={() => setShowLogoutConfirm(false)}>Cancelar</button><button type="button" className="app-dialog-confirm danger" disabled={signingOut} onClick={() => void signOut()}>{signingOut ? <LoaderCircle className="spinner" size={15} /> : <LogOut size={15} />}Sim, sair</button></footer>
        </section>
      </div> : null}
      {appDialog.host}
    </main>
  );
}

function ColumnEditor({
  column,
  boardId,
  initialPosition,
  taskCount,
  totalColumns,
  onClose,
  onChanged,
}: {
  column: BoardColumn | null;
  boardId: string;
  initialPosition: number;
  taskCount: number;
  totalColumns: number;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [name, setName] = useState(column?.name ?? 'Nova etapa');
  const [color, setColor] = useState(column?.color ?? '#8b8fa3');
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDialogFocus<HTMLElement>(true, onClose, !saving);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase || !name.trim()) return setError('Digite um nome para a coluna.');
    setSaving(true);
    setError(null);
    const result = column
      ? await supabase.from('columns').update({ name: name.trim(), color }).eq('id', column.id)
      : await supabase.from('columns').insert({ board_id: boardId, name: name.trim(), color, position: initialPosition });
    setSaving(false);
    if (result.error) return setError(result.error.message);
    await onChanged();
  };

  const remove = async () => {
    if (!supabase || !column) return;
    if (taskCount) return setError(`Mova as ${taskCount} tarefas desta coluna antes de excluí-la.`);
    if (totalColumns === 1) return setError('O quadro precisa ter pelo menos uma coluna.');
    if (!confirmingDelete) return setConfirmingDelete(true);
    setSaving(true);
    const { error: deleteError } = await supabase.from('columns').delete().eq('id', column.id);
    setSaving(false);
    if (deleteError) return setError(deleteError.message);
    await onChanged();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <section ref={dialogRef} tabIndex={-1} className="column-editor-modal" role="dialog" aria-modal="true" aria-label={column ? 'Editar coluna' : 'Criar coluna'}>
        <header><div><p>CONFIGURAÇÃO DA COLUNA</p><h2>{column ? 'Editar coluna' : 'Criar coluna'}</h2></div><button disabled={saving} onClick={onClose} aria-label="Fechar"><X size={19} /></button></header>
        <form onSubmit={save}>
          <label><span>Nome</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoFocus /></label>
          <fieldset><legend>Cor</legend><div className="color-palette">{columnColors.map((option) => <button type="button" key={option} className={color === option ? 'selected' : ''} style={{ background: option }} onClick={() => setColor(option)} aria-label={`Usar cor ${option}`}>{color === option ? '✓' : ''}</button>)}</div></fieldset>
          <div className="column-preview"><i style={{ background: color }} /><span>{name || 'Nome da coluna'}</span></div>
          {error ? <div className="panel-error">{error}</div> : null}
          <button className="primary-button column-save" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spinner" size={16} /> : null}{column ? 'Salvar coluna' : 'Criar coluna'}</button>
        </form>
        {column ? <div className="column-danger-zone"><div><strong>Excluir coluna</strong><small>{taskCount ? `${taskCount} tarefas precisam ser movidas antes.` : 'Esta ação não pode ser desfeita.'}</small></div><button onClick={() => void remove()} disabled={saving || taskCount > 0}>{confirmingDelete ? 'Confirmar exclusão' : 'Excluir'}</button></div> : null}
      </section>
    </div>
  );
}

function TaskCard({
  task,
  column,
  completedVariant,
  progressPercent,
  client,
  assignee,
  members,
  canAssign,
  taskLinks,
  onOpen,
  onOpenProfile,
  onAssign,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  dragging,
  dropEdge,
  dragEnabled,
}: {
  task: Task;
  column: BoardColumn;
  completedVariant: boolean;
  progressPercent: number;
  client?: Client;
  assignee?: WorkspaceMember;
  members: WorkspaceMember[];
  canAssign: boolean;
  taskLinks: TaskLink[];
  onOpen: () => void;
  onOpenProfile: (memberId: string) => void;
  onAssign: (memberId: string | null) => Promise<boolean>;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  dragging: boolean;
  dropEdge: 'before' | 'after' | null;
  dragEnabled: boolean;
}) {
  const [showLinks, setShowLinks] = useState(false);
  const [showAssignees, setShowAssignees] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const assigneePickerRef = useRef<HTMLDivElement>(null);
  const assigneeButtonRef = useRef<HTMLButtonElement>(null);
  const assigneePopoverRef = useRef<HTMLElement>(null);
  const [assigneePopoverStyle, setAssigneePopoverStyle] = useState<CSSProperties | null>(null);
  const taskFinished = completedVariant || Boolean(task.completed_at);
  const countdown = taskCountdown(task.due_at, taskFinished);
  const subtitle = client?.name || task.description || priorityLabel(task.priority);
  const downloadLinks = taskLinks.filter((link) => link.category === 'download');
  const cardStyle = {
    '--task-accent': column.color ?? '#01c3a8',
    '--task-progress': `${Math.max(0, Math.min(100, progressPercent))}%`,
  } as CSSProperties;

  const handleMainClick = () => {
    setShowLinks(false);
    setShowAssignees(false);
    onOpen();
  };

  useEffect(() => {
    if (!showAssignees) return;
    const positionAssigneePopover = () => {
      const anchor = assigneeButtonRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const width = 210;
      const gap = 8;
      const viewportPadding = 12;
      const availableAbove = rect.top - gap - viewportPadding;
      const availableBelow = window.innerHeight - rect.bottom - gap - viewportPadding;
      const openAbove = availableAbove >= 150 || availableAbove >= availableBelow;
      const maxHeight = Math.max(110, Math.min(250, openAbove ? availableAbove : availableBelow));
      const left = Math.min(
        window.innerWidth - width - viewportPadding,
        Math.max(viewportPadding, rect.left - 68),
      );
      const top = openAbove
        ? Math.max(viewportPadding, rect.top - gap - maxHeight)
        : Math.min(window.innerHeight - viewportPadding - maxHeight, rect.bottom + gap);

      setAssigneePopoverStyle({ left, top, width, maxHeight });
    };
    const closeAssigneesOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!assigneePickerRef.current?.contains(target) && !assigneePopoverRef.current?.contains(target)) {
        setShowAssignees(false);
      }
    };
    positionAssigneePopover();
    document.addEventListener('pointerdown', closeAssigneesOnOutsidePointer);
    window.addEventListener('resize', positionAssigneePopover);
    window.addEventListener('scroll', positionAssigneePopover, true);
    return () => {
      document.removeEventListener('pointerdown', closeAssigneesOnOutsidePointer);
      window.removeEventListener('resize', positionAssigneePopover);
      window.removeEventListener('scroll', positionAssigneePopover, true);
    };
  }, [showAssignees]);

  const chooseAssignee = async (memberId: string | null) => {
    if (assigning) return;
    setAssigning(true);
    const saved = await onAssign(memberId);
    setAssigning(false);
    if (saved) setShowAssignees(false);
  };

  const handleLinksClick = async () => {
    setShowAssignees(false);
    if (taskLinks.length === 1) {
      await window.editflow.openExternal(taskLinks[0].url);
      return;
    }
    setShowLinks(true);
  };

  if (completedVariant) {
    return (
      <div
        className={`task-card completed-compact ${dragging ? 'dragging' : ''} ${dropEdge ? `task-drop-${dropEdge}` : ''}`}
        style={cardStyle}
        draggable={dragEnabled}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <button type="button" className="completed-card-open" onClick={handleMainClick} aria-label={`Abrir detalhes de ${task.title}`}>
          <span><strong>{task.title}</strong><small>{client?.name ?? 'Sem cliente'}</small></span>
          <CheckCircle2 size={18} />
        </button>
      </div>
    );
  }

  return <>
    <div
      className={`task-card compact ${dragging ? 'dragging' : ''} ${dropEdge ? `task-drop-${dropEdge}` : ''}`}
      style={cardStyle}
      draggable={dragEnabled}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <button
        type="button"
        className="task-card-open"
        onClick={handleMainClick}
        aria-label={`Abrir detalhes de ${task.title}`}
      >
        <span className="task-card-surface">
          <span className="task-card-top">
            <span className="task-card-date">{task.due_at ? formatCardDate(task.due_at) : 'SEM PRAZO'}</span>
          </span>
          <span className="task-card-title-block">
            <strong>{task.title}</strong>
            <small>{subtitle}</small>
          </span>
          <span className="task-progress-copy"><strong>Progresso</strong><small>{progressPercent}%</small></span>
          <span className="task-progress-track"><i /></span>
        </span>
      </button>
      <span className="task-card-footer">
        <span className="task-card-people">
          {assignee ? (
            <button
              type="button"
              className="task-card-avatar"
              title={`Ver perfil de ${assignee.display_name}`}
              aria-label={`Ver perfil de ${assignee.display_name}`}
              onClick={() => { setShowLinks(false); onOpenProfile(assignee.user_id); }}
            >{assignee.avatar_url ? <img src={assignee.avatar_url} alt="" /> : memberInitials(assignee.display_name)}</button>
          ) : <span className="task-card-avatar empty" title="Sem responsável">?</span>}
          {taskLinks.length ? (
            <button
              type="button"
              className="task-card-download"
              title={taskLinks.length === 1 ? `Abrir ${taskLinks[0].label}` : `Ver os ${taskLinks.length} links da tarefa`}
              aria-label={taskLinks.length === 1 ? `Abrir ${taskLinks[0].label}` : `Ver links da tarefa`}
              onClick={() => void handleLinksClick()}
            >{downloadLinks.length ? <Download size={11} /> : <Link2 size={11} />}{taskLinks.length > 1 ? taskLinks.length : null}</button>
          ) : null}
          {canAssign ? <div className="task-assignee-picker" ref={assigneePickerRef}>
            <button ref={assigneeButtonRef} type="button" className={`task-card-add-person ${showAssignees ? 'active' : ''}`} title={assignee ? 'Trocar responsável' : 'Definir responsável'} aria-label={assignee ? 'Trocar responsável' : 'Definir responsável'} onClick={() => { setShowLinks(false); setShowAssignees((show) => !show); }}><Plus size={11} /></button>
          </div> : null}
        </span>
        <span className={`task-card-countdown ${countdown.state}`}>{taskFinished ? <CheckCircle2 size={11} /> : null}{countdown.label}</span>
      </span>
    </div>
    {showLinks && taskLinks.length > 1 ? createPortal(
      <TaskLinksModal taskTitle={task.title} links={taskLinks} onClose={() => setShowLinks(false)} />,
      document.body,
    ) : null}
    {showAssignees && assigneePopoverStyle ? createPortal(
      <aside ref={assigneePopoverRef} className="task-assignee-popover task-assignee-popover-portal" style={assigneePopoverStyle} aria-label="Escolher responsável">
        <strong>RESPONSÁVEL</strong>
        <button type="button" className={!task.assignee_id ? 'selected' : ''} disabled={assigning} onClick={() => void chooseAssignee(null)}><span className="task-assignee-avatar empty">?</span><span><b>Sem responsável</b><small>Deixar a tarefa livre</small></span></button>
        {members.map((member) => <button type="button" className={task.assignee_id === member.user_id ? 'selected' : ''} disabled={assigning} key={member.user_id} onClick={() => void chooseAssignee(member.user_id)}><span className="task-assignee-avatar">{member.avatar_url ? <img src={member.avatar_url} alt="" /> : memberInitials(member.display_name)}</span><span><b>{member.display_name}</b><small>{availabilityLabel(member.availability)}</small></span></button>)}
      </aside>,
      document.body,
    ) : null}
  </>;
}

function TaskLinksModal({ taskTitle, links, onClose }: { taskTitle: string; links: TaskLink[]; onClose: () => void }) {
  const dialogRef = useDialogFocus<HTMLElement>(true, onClose);
  const categoryOrder: TaskLinkCategory[] = ['download', 'review', 'delivery', 'briefing', 'reference'];
  const groupedLinks = categoryOrder
    .map((category) => ({ category, links: links.filter((link) => link.category === category) }))
    .filter((group) => group.links.length);

  return (
    <div className="task-links-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} tabIndex={-1} className="task-links-modal" role="dialog" aria-modal="true" aria-labelledby="task-links-title">
        <header>
          <span><Link2 size={18} /></span>
          <div><p>LINKS DA TAREFA</p><h2 id="task-links-title">{taskTitle}</h2><small>{links.length} {links.length === 1 ? 'link disponível' : 'links disponíveis'}</small></div>
          <button type="button" onClick={onClose} aria-label="Fechar links"><X size={18} /></button>
        </header>
        <div className="task-links-groups">
          {groupedLinks.map((group) => (
            <section key={group.category}>
              <h3>{linkCategoryLabel(group.category)} <small>{group.links.length}</small></h3>
              <div>
                {group.links.map((link) => (
                  <button type="button" key={link.id} onClick={() => { onClose(); void window.editflow.openExternal(link.url); }}>
                    <span className={`task-link-modal-icon ${link.category}`}>{link.category === 'download' ? <Download size={14} /> : <Link2 size={14} />}</span>
                    <span><strong>{link.label}</strong><small>{shortHost(link.url)}</small></span>
                    <ExternalLink size={13} />
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </section>
    </div>
  );
}

function CompletedTasksModal({
  tasks,
  clients,
  onClose,
  onOpenTask,
}: {
  tasks: Task[];
  clients: Client[];
  onClose: () => void;
  onOpenTask: (task: Task) => void;
}) {
  const [searchTerm, setSearchTerm] = useState('');
  const [clientId, setClientId] = useState('');
  const [month, setMonth] = useState('');
  const dialogRef = useDialogFocus<HTMLElement>(true, onClose);
  const clientById = useMemo(() => new Map(clients.map((client) => [client.id, client])), [clients]);
  const availableClients = useMemo(() => clients
    .filter((client) => tasks.some((task) => task.client_id === client.id))
    .sort((first, second) => first.name.localeCompare(second.name, 'pt-BR')), [clients, tasks]);
  const availableMonths = useMemo(() => Array.from(new Set(tasks.map(completedTaskMonth))).sort().reverse(), [tasks]);
  const filteredCompletedTasks = useMemo(() => {
    const normalizedSearch = normalizeText(searchTerm.trim());
    return tasks
      .filter((task) => !clientId || task.client_id === clientId)
      .filter((task) => !month || completedTaskMonth(task) === month)
      .filter((task) => {
        if (!normalizedSearch) return true;
        const client = task.client_id ? clientById.get(task.client_id) : null;
        return normalizeText(`${task.title} ${client?.name ?? ''}`).includes(normalizedSearch);
      })
      .sort((first, second) => completedTaskTime(second) - completedTaskTime(first));
  }, [clientById, clientId, month, searchTerm, tasks]);
  const groupedTasks = useMemo(() => {
    const groups = new Map<string, Task[]>();
    filteredCompletedTasks.forEach((task) => {
      const key = completedTaskMonth(task);
      groups.set(key, [...(groups.get(key) ?? []), task]);
    });
    return Array.from(groups.entries());
  }, [filteredCompletedTasks]);

  return createPortal(
    <div className="completed-tasks-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} tabIndex={-1} className="completed-tasks-modal" role="dialog" aria-modal="true" aria-labelledby="completed-tasks-title">
        <header>
          <span><CheckCircle2 size={21} /></span>
          <div><p>HISTÓRICO DE PRODUÇÃO</p><h2 id="completed-tasks-title">Trabalhos finalizados</h2><small>{tasks.length} {tasks.length === 1 ? 'trabalho concluído' : 'trabalhos concluídos'}</small></div>
          <button type="button" onClick={onClose} aria-label="Fechar finalizados"><X size={19} /></button>
        </header>
        <div className="completed-tasks-filters">
          <label className="completed-search"><Search size={15} /><input autoFocus value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Buscar por título ou cliente..." /></label>
          <label><span>Cliente</span><select value={clientId} onChange={(event) => setClientId(event.target.value)}><option value="">Todos os clientes</option>{availableClients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
          <label><span>Mês</span><select value={month} onChange={(event) => setMonth(event.target.value)}><option value="">Todos os meses</option>{availableMonths.map((option) => <option key={option} value={option}>{formatCompletedMonth(option)}</option>)}</select></label>
        </div>
        <div className="completed-tasks-results">
          {groupedTasks.map(([monthKey, monthTasks]) => (
            <section className="completed-month-group" key={monthKey}>
              <header><h3>{formatCompletedMonth(monthKey)}</h3><span>{monthTasks.length}</span></header>
              <div>
                {monthTasks.map((task) => {
                  const client = task.client_id ? clientById.get(task.client_id) : null;
                  return <button type="button" key={task.id} onClick={() => onOpenTask(task)}><span className="completed-result-check"><CheckCircle2 size={16} /></span><span><strong>{task.title}</strong><small>{client?.name ?? 'Sem cliente'}</small></span><time>{formatCompletedDate(completedTaskDate(task))}</time></button>;
                })}
              </div>
            </section>
          ))}
          {!filteredCompletedTasks.length ? <div className="completed-tasks-empty"><Search size={22} /><strong>Nenhum finalizado encontrado</strong><small>Altere os filtros para visualizar outros trabalhos.</small></div> : null}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function MemberProfilePanel({
  member,
  currentUserId,
  workspace,
  tasks,
  columns,
  clients,
  canManage,
  onClose,
  onMessage,
  onOpenTask,
  onChanged,
  onRemoved,
}: {
  member: WorkspaceMember;
  currentUserId: string;
  workspace: WorkspaceSummary;
  tasks: Task[];
  columns: BoardColumn[];
  clients: Client[];
  canManage: boolean;
  onClose: () => void;
  onMessage: (memberId: string) => void;
  onOpenTask: (task: Task) => void;
  onChanged: () => Promise<void>;
  onRemoved: () => Promise<void>;
}) {
  const [saving, setSaving] = useState<'role' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const appDialog = useAppDialog();
  const dialogRef = useDialogFocus<HTMLElement>(!appDialog.open, onClose, saving === null);
  const isCurrentUser = member.user_id === currentUserId;
  const assignedTasks = useMemo(() => tasks
    .filter((task) => task.assignee_id === member.user_id)
    .sort((first, second) => taskSortValue(first) - taskSortValue(second)), [member.user_id, tasks]);
  const activeTasks = assignedTasks.filter((task) => !task.completed_at);
  const overdueTasks = activeTasks.filter((task) => task.due_at && isOverdue(task.due_at));
  const nextDeadline = activeTasks.find((task) => task.due_at && !isOverdue(task.due_at));
  const visibleTasks = activeTasks.slice(0, 6);

  const updateRole = async (role: Exclude<WorkspaceMember['role'], 'owner'>) => {
    if (!supabase || !canManage || member.role === 'owner' || isCurrentUser) return;
    setSaving('role');
    setError(null);
    const { error: roleError } = await supabase.rpc('change_workspace_member_role', {
      target_workspace: workspace.id,
      target_user: member.user_id,
      member_role: role,
    });
    setSaving(null);
    if (roleError) return setError(roleError.message);
    await onChanged();
  };

  const removeMember = async () => {
    if (!supabase || !canManage || member.role === 'owner' || isCurrentUser) return;
    const confirmed = await appDialog.confirm({
      title: `Remover ${member.display_name}?`,
      description: 'O membro perderá o acesso e as tarefas atribuídas ficarão sem responsável.',
      confirmLabel: 'Remover membro',
      tone: 'danger',
    });
    if (!confirmed) return;
    setSaving('remove');
    setError(null);
    const { error: removeError } = await supabase.rpc('remove_workspace_member', {
      target_workspace: workspace.id,
      target_user: member.user_id,
    });
    setSaving(null);
    if (removeError) return setError(removeError.message);
    await onRemoved();
  };

  return (
    <div className="member-profile-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && saving === null) onClose(); }}>
      <aside ref={dialogRef} tabIndex={-1} className="member-profile-panel" role="dialog" aria-modal="true" aria-label={`Perfil de ${member.display_name}`}>
        <div className="member-profile-glow" aria-hidden="true" />
        <header className="member-profile-header">
          <div><p>PERFIL DO COLABORADOR</p><span>Informações e carga de trabalho</span></div>
          <button type="button" disabled={saving !== null} onClick={onClose} aria-label="Fechar perfil"><X size={19} /></button>
        </header>

        <section className="member-profile-identity">
          <div className="member-profile-avatar">
            {member.avatar_url ? <img src={member.avatar_url} alt="" /> : <span>{memberInitials(member.display_name)}</span>}
            <i className={member.availability} title={availabilityLabel(member.availability)} />
          </div>
          <div className="member-profile-name">
            <span className={`member-availability-pill ${member.availability}`}>{availabilityLabel(member.availability)}</span>
            <h2>{member.display_name}</h2>
            <p><ShieldCheck size={14} />{member.specialty || roleLabel(member.role)}</p>
            {member.email ? <p><Mail size={14} />{member.email}</p> : null}
          </div>
        </section>

        {member.bio ? <p className="member-profile-bio">{member.bio}</p> : null}

        <div className="member-presence-explanation"><Wifi size={15} /><span><strong>{availabilityLabel(member.availability)}</strong><small>{availabilityDescription(member.availability, activeTasks.length)}</small></span></div>

        {!isCurrentUser ? <button type="button" className="member-profile-message-button" onClick={() => onMessage(member.user_id)}><MessageSquare size={15} />Enviar mensagem</button> : null}

        <section className="member-profile-stats" aria-label="Resumo de tarefas">
          <article><span><CheckCircle2 size={16} /></span><strong>{activeTasks.length}</strong><small>Em andamento</small></article>
          <article className={overdueTasks.length ? 'warning' : ''}><span><AlertTriangle size={16} /></span><strong>{overdueTasks.length}</strong><small>Atrasadas</small></article>
          <article><span><CalendarClock size={16} /></span><strong>{nextDeadline?.due_at ? formatDate(nextDeadline.due_at) : '—'}</strong><small>Próximo prazo</small></article>
        </section>

        <section className="member-profile-tasks">
          <div className="member-profile-section-heading"><div><p>TRABALHOS ATUAIS</p><h3>Tarefas atribuídas</h3></div><span>{activeTasks.length}</span></div>
          <div className="member-profile-task-list">
            {visibleTasks.map((task) => {
              const column = columns.find((item) => item.id === task.column_id);
              const client = clients.find((item) => item.id === task.client_id);
              const countdown = taskCountdown(task.due_at);
              return (
                <button type="button" key={task.id} onClick={() => onOpenTask(task)}>
                  <i style={{ background: column?.color ?? '#8b8fa3' }} />
                  <span><strong>{task.title}</strong><small>{client?.name || column?.name || 'Produção'}</small></span>
                  <em className={countdown.state}>{countdown.label}</em>
                </button>
              );
            })}
            {!visibleTasks.length ? <div className="member-profile-empty"><CheckCircle2 size={21} /><span>Nenhuma tarefa ativa no momento.</span></div> : null}
          </div>
          {activeTasks.length > visibleTasks.length ? <p className="member-profile-more">Mais {activeTasks.length - visibleTasks.length} tarefas no quadro</p> : null}
        </section>

        {canManage && member.role !== 'owner' && !isCurrentUser ? (
          <section className="member-profile-admin">
            <div className="member-profile-section-heading"><div><p>ADMINISTRAÇÃO</p><h3>Acesso à equipe</h3></div><Settings size={17} /></div>
            <label><span>Cargo</span><select value={member.role} disabled={saving !== null} onChange={(event) => void updateRole(event.target.value as 'admin' | 'editor')}><option value="editor">Editor</option><option value="admin">Administrador</option></select></label>
            <button type="button" className="danger-button" disabled={saving !== null} onClick={() => void removeMember()}>{saving === 'remove' ? <LoaderCircle className="spinner" size={15} /> : <Trash2 size={15} />}Remover da equipe</button>
          </section>
        ) : null}

        {error ? <div className="panel-error member-profile-error">{error}</div> : null}
      </aside>
      {appDialog.host}
    </div>
  );
}

function TaskEditor({
  mode,
  task,
  board,
  firstColumn,
  workspace,
  clients,
  members,
  columns,
  links,
  userId,
  canManagePlanning,
  onClose,
  onChanged,
  onLinksChanged,
}: {
  mode: 'new' | 'edit';
  task: Task | null;
  board: Board;
  firstColumn: BoardColumn;
  workspace: WorkspaceSummary;
  clients: Client[];
  members: WorkspaceMember[];
  columns: BoardColumn[];
  links: TaskLink[];
  userId: string;
  canManagePlanning: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onLinksChanged: () => Promise<void>;
}) {
  const initialDraft = useMemo<TaskDraft>(() => task ? taskToDraft(task) : emptyDraft, [task]);
  const [draft, setDraft] = useState<TaskDraft>(initialDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkLabel, setLinkLabel] = useState('Arquivos para download');
  const [linkUrl, setLinkUrl] = useState('');
  const [linkCategory, setLinkCategory] = useState<TaskLinkCategory>('download');
  const [activities, setActivities] = useState<TaskActivity[]>([]);
  const [activityLimit, setActivityLimit] = useState(40);
  const [hasMoreActivities, setHasMoreActivities] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [commentBody, setCommentBody] = useState('');
  const [commentKind, setCommentKind] = useState<TaskCommentKind>('change_request');
  const [commentSaving, setCommentSaving] = useState(false);
  const [linkSaving, setLinkSaving] = useState(false);
  const [resolvingCommentId, setResolvingCommentId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const appDialog = useAppDialog();
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initialDraft)
    || (mode === 'new' && Boolean(linkUrl.trim())), [draft, initialDraft, linkUrl, mode]);
  const busy = saving || linkSaving || commentSaving || resolvingCommentId !== null || deleting;

  const requestClose = async () => {
    if (busy) return;
    if (dirty) {
      const discard = await appDialog.confirm({
        title: 'Descartar alterações?',
        description: 'As informações que ainda não foram salvas serão perdidas.',
        confirmLabel: 'Descartar',
        tone: 'danger',
      });
      if (!discard) return;
    }
    onClose();
  };
  const dialogRef = useDialogFocus<HTMLElement>(!appDialog.open, () => void requestClose(), !busy);

  const loadReviewData = useCallback(async () => {
    if (!supabase || !task) return;
    const [activityResult, commentResult] = await Promise.all([
      supabase.from('task_activities').select('*').eq('task_id', task.id).order('created_at', { ascending: false }).limit(activityLimit + 1),
      supabase.from('task_comments').select('*').eq('task_id', task.id).order('created_at', { ascending: true }),
    ]);
    const loadError = activityResult.error ?? commentResult.error;
    if (loadError) {
      setActivityError(loadError.message);
      return;
    }
    setActivityError(null);
    const nextActivities = (activityResult.data ?? []) as TaskActivity[];
    setHasMoreActivities(nextActivities.length > activityLimit);
    setActivities(nextActivities.slice(0, activityLimit));
    setComments((commentResult.data ?? []) as TaskComment[]);
  }, [activityLimit, task]);

  useEffect(() => { void loadReviewData(); }, [loadReviewData]);
  useEffect(() => { setShowActivity(false); }, [task?.id]);

  useEffect(() => {
    if (!supabase || !task) return;
    const realtimeClient = supabase;
    const channel = realtimeClient
      .channel(`editflow-review:${task.id}:${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_comments', filter: `task_id=eq.${task.id}` }, () => void loadReviewData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_activities', filter: `task_id=eq.${task.id}` }, () => void loadReviewData())
      .subscribe();
    return () => { void realtimeClient.removeChannel(channel); };
  }, [loadReviewData, task, userId]);

  const saveTask = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase || !draft.title.trim()) {
      setError('Digite um título para a tarefa.');
      return;
    }
    setSaving(true);
    setError(null);

    const payload = {
      title: draft.title.trim(),
      description: draft.description.trim(),
      priority: draft.priority,
      due_at: draft.due_at ? new Date(`${draft.due_at}T12:00:00`).toISOString() : null,
      client_id: draft.client_id || null,
      assignee_id: draft.assignee_id || null,
      revision_round: Math.max(1, Math.min(99, draft.revision_round || 1)),
    };

    let normalizedUrl = linkUrl.trim();
    if (normalizedUrl && !normalizedUrl.startsWith('https://')) normalizedUrl = `https://${normalizedUrl}`;

    if (mode === 'new' && !canManagePlanning) {
      setSaving(false);
      setError('Somente proprietários e administradores podem criar tarefas.');
      return;
    }

    const result = mode === 'new'
      ? await supabase.rpc('create_task_with_download_link', {
          workspace_target: workspace.id,
          board_target: board.id,
          column_target: firstColumn.id,
          client_target: payload.client_id,
          assignee_target: payload.assignee_id,
          task_title: payload.title,
          task_description: payload.description,
          task_priority: payload.priority,
          task_position: Date.now(),
          task_due_at: payload.due_at,
          task_revision_round: payload.revision_round,
          download_label: normalizedUrl ? linkLabel.trim() || 'Arquivos para download' : null,
          download_url: normalizedUrl || null,
        })
      : await supabase.from('tasks').update(canManagePlanning ? payload : { revision_round: payload.revision_round }).eq('id', task!.id);

    if (result.error) {
      setError(result.error.message);
      setSaving(false);
      return;
    }
    await onChanged();
  };

  const addLink = async () => {
    if (!supabase || !task || !linkLabel.trim() || !linkUrl.trim() || linkSaving) return;
    setLinkSaving(true);
    let normalizedUrl = linkUrl.trim();
    if (!normalizedUrl.startsWith('https://')) normalizedUrl = `https://${normalizedUrl}`;
    const { error: linkError } = await supabase.from('task_links').insert({
      task_id: task.id,
      label: linkLabel.trim(),
      url: normalizedUrl,
      category: linkCategory,
      created_by: userId,
    });
    if (linkError) { setError(linkError.message); setLinkSaving(false); return; }
    setLinkUrl('');
    await onLinksChanged();
    await loadReviewData();
    setLinkSaving(false);
  };

  const removeLink = async (linkId: string) => {
    if (!supabase) return;
    const { error: removeError } = await supabase.from('task_links').delete().eq('id', linkId);
    if (removeError) setError(removeError.message);
    else {
      await onLinksChanged();
      await loadReviewData();
    }
  };

  const addComment = async () => {
    if (!supabase || !task || !commentBody.trim()) return;
    setCommentSaving(true);
    setError(null);
    const { error: commentError } = await supabase.from('task_comments').insert({
      task_id: task.id,
      workspace_id: workspace.id,
      author_id: userId,
      kind: commentKind,
      body: commentBody.trim(),
      revision_round: draft.revision_round,
    });
    setCommentSaving(false);
    if (commentError) { setError(commentError.message); return; }
    setCommentBody('');
    await loadReviewData();
  };

  const toggleCommentResolved = async (comment: TaskComment) => {
    if (!supabase || resolvingCommentId) return;
    setResolvingCommentId(comment.id);
    const nextResolved = !comment.is_resolved;
    const { error: commentError } = await supabase
      .from('task_comments')
      .update({
        is_resolved: nextResolved,
        resolved_by: nextResolved ? userId : null,
        resolved_at: nextResolved ? new Date().toISOString() : null,
      })
      .eq('id', comment.id);
    if (commentError) { setError(commentError.message); setResolvingCommentId(null); return; }
    await loadReviewData();
    setResolvingCommentId(null);
  };

  const deleteTask = async () => {
    if (!supabase || !task || deleting) return;
    const confirmed = await appDialog.confirm({
      title: `Excluir “${task.title}”?`,
      description: 'A tarefa, seus links, comentários e histórico serão removidos permanentemente.',
      confirmLabel: 'Excluir tarefa',
      tone: 'danger',
    });
    if (!confirmed) return;
    setDeleting(true);
    const { error: deleteError } = await supabase.from('tasks').delete().eq('id', task.id);
    if (deleteError) { setError(deleteError.message); setDeleting(false); }
    else await onChanged();
  };

  return (
    <div className="editor-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) void requestClose(); }}>
      <aside ref={dialogRef} tabIndex={-1} className="task-editor" aria-modal="true" role="dialog" aria-label={mode === 'new' ? 'Nova tarefa' : 'Editar tarefa'}>
        <header className="editor-header">
          <div><p>{mode === 'new' ? 'NOVO TRABALHO' : 'DETALHES DO TRABALHO'}</p><h2>{mode === 'new' ? 'Criar tarefa' : task?.title}</h2></div>
          <button type="button" disabled={busy} onClick={() => void requestClose()} aria-label="Fechar"><X size={20} /></button>
        </header>

        <form className="editor-form" onSubmit={saveTask}>
          {!canManagePlanning ? <div className="editor-permission-note">Como editor, você pode mover esta tarefa, atualizar a versão, adicionar links e responder aos ajustes. O planejamento é controlado pelos administradores.</div> : null}
          <label><span>Título</span><input value={draft.title} disabled={!canManagePlanning} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="Ex.: Vídeo da campanha de inverno" autoFocus /></label>
          <label><span>Descrição</span><textarea value={draft.description} disabled={!canManagePlanning} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="Briefing rápido, formato e observações..." rows={4} /></label>

          <div className="editor-grid">
            <label><span>Prioridade</span><select value={draft.priority} disabled={!canManagePlanning} onChange={(event) => setDraft({ ...draft, priority: event.target.value as TaskPriority })}><option value="low">Baixa</option><option value="normal">Normal</option><option value="high">Alta</option><option value="urgent">Urgente</option></select></label>
            <label><span>Prazo</span><input type="date" value={draft.due_at} disabled={!canManagePlanning} onChange={(event) => setDraft({ ...draft, due_at: event.target.value })} /></label>
          </div>

          <label>
            <span>Cliente</span>
            <select value={draft.client_id} disabled={!canManagePlanning} onChange={(event) => setDraft({ ...draft, client_id: event.target.value })}><option value="">Sem cliente</option>{clients.map((client) => <option value={client.id} key={client.id}>{client.name}</option>)}</select>
          </label>

          <div className="editor-grid">
            <label>
              <span>Editor responsável</span>
              <select value={draft.assignee_id} disabled={!canManagePlanning} onChange={(event) => setDraft({ ...draft, assignee_id: event.target.value })}>
                <option value="">Sem responsável</option>
                {members.map((member) => <option value={member.user_id} key={member.user_id}>{member.display_name} · {roleLabel(member.role)}</option>)}
              </select>
            </label>
            <label>
              <span>Versão atual</span>
              <div className="revision-input"><strong>V</strong><input type="number" min="1" max="99" value={draft.revision_round} onChange={(event) => setDraft({ ...draft, revision_round: Math.max(1, Math.min(99, Number(event.target.value) || 1)) })} /></div>
            </label>
          </div>

          {mode === 'new' && canManagePlanning ? (
            <div className="initial-link-panel">
              <div><Link2 size={17} /><span><strong>Arquivos para download</strong><small>Opcional — você também poderá adicionar depois.</small></span></div>
              <input value={linkLabel} onChange={(event) => setLinkLabel(event.target.value)} placeholder="Nome do link" />
              <input value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} placeholder="https://drive.google.com/..." inputMode="url" />
            </div>
          ) : null}

          {error ? <div className="editor-error" role="alert">{error}</div> : null}

          <button className="editor-save" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spinner" size={18} /> : mode === 'new' ? 'Criar tarefa' : canManagePlanning ? 'Salvar alterações' : 'Salvar versão'}</button>
        </form>

        {mode === 'edit' && task ? (
          <section className="links-section">
            <div className="section-title"><div><p>LINKS EXTERNOS</p><h3>Arquivos e entregas</h3></div><Link2 size={19} /></div>
            <div className="saved-links">
              {links.map((link) => (
                <div className="saved-link" key={link.id}>
                  <button className="link-open" onClick={() => void window.editflow.openExternal(link.url)}><span className={`link-kind ${link.category}`}>{linkCategoryLabel(link.category)}</span><strong>{link.label}</strong><small>{shortHost(link.url)}</small></button>
                  <button className="link-external" onClick={() => void window.editflow.openExternal(link.url)} aria-label="Abrir link"><ExternalLink size={16} /></button>
                  {canManagePlanning || link.created_by === userId ? <button className="link-delete" onClick={() => void removeLink(link.id)} aria-label="Excluir link"><Trash2 size={16} /></button> : <span />}
                </div>
              ))}
              {!links.length ? <p className="no-links">Nenhum link adicionado.</p> : null}
            </div>
            <div className="link-form">
              <select value={linkCategory} onChange={(event) => setLinkCategory(event.target.value as TaskLinkCategory)}><option value="download">Download</option><option value="briefing">Briefing</option><option value="reference">Referência</option><option value="review">Revisão</option><option value="delivery">Entrega</option></select>
              <input value={linkLabel} onChange={(event) => setLinkLabel(event.target.value)} placeholder="Nome do link" />
              <input value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} placeholder="https://drive.google.com/..." />
              <button type="button" disabled={linkSaving || !linkLabel.trim() || !linkUrl.trim()} onClick={() => void addLink()}>{linkSaving ? <LoaderCircle className="spinner" size={16} /> : <Plus size={16} />}Adicionar link</button>
            </div>
          </section>
        ) : null}

        {mode === 'edit' && task ? (
          <section className="review-section">
            <div className="section-title"><div><p>REVISÃO E FEEDBACK</p><h3>Comentários da V{draft.revision_round}</h3></div><MessageSquare size={19} /></div>
            <div className="comment-form">
              <select value={commentKind} onChange={(event) => setCommentKind(event.target.value as TaskCommentKind)}>
                <option value="change_request">Solicitação de ajuste</option>
                <option value="comment">Comentário</option>
              </select>
              <textarea value={commentBody} onChange={(event) => setCommentBody(event.target.value)} rows={3} placeholder="Descreva o ajuste ou deixe um comentário..." />
              <button type="button" disabled={commentSaving || !commentBody.trim()} onClick={() => void addComment()}>{commentSaving ? <LoaderCircle className="spinner" size={16} /> : <MessageSquare size={15} />}Adicionar feedback na V{draft.revision_round}</button>
            </div>
            <div className="comment-list">
              {comments.map((comment) => {
                const author = members.find((member) => member.user_id === comment.author_id);
                return (
                  <article className={`comment-item ${comment.is_resolved ? 'resolved' : ''}`} key={comment.id}>
                    <header><span className={`comment-kind ${comment.kind}`}>{comment.kind === 'change_request' ? 'Ajuste' : 'Comentário'}</span><b>V{comment.revision_round}</b><small>{formatActivityDate(comment.created_at)}</small></header>
                    <p>{comment.body}</p>
                    <footer><span>{comment.kind === 'change_request' ? 'Solicitado por' : 'Enviado por'} <strong>{author?.display_name || 'Membro'}</strong></span><button type="button" disabled={resolvingCommentId !== null} onClick={() => void toggleCommentResolved(comment)}>{resolvingCommentId === comment.id ? 'Salvando...' : comment.is_resolved ? 'Reabrir' : 'Marcar como resolvido'}</button></footer>
                  </article>
                );
              })}
              {!comments.length ? <p className="no-links">Nenhum comentário ou ajuste solicitado.</p> : null}
            </div>
          </section>
        ) : null}

        {mode === 'edit' && task ? (
          <section className={`activity-section ${showActivity ? 'expanded' : ''}`}>
            <button type="button" className="activity-toggle" aria-expanded={showActivity} onClick={() => setShowActivity((current) => !current)}>
              <span className="activity-toggle-icon"><History size={18} /></span>
              <span><small>HISTÓRICO</small><strong>Atividade do trabalho</strong></span>
              <em>{activities.length}{hasMoreActivities ? '+' : ''} {activities.length === 1 && !hasMoreActivities ? 'evento' : 'eventos'}</em>
              <ChevronDown size={17} />
            </button>
            {showActivity ? (
              <div className="activity-collapsible">
                {activityError ? <div className="editor-error" role="alert">{activityError}</div> : null}
                <div className="activity-list">
                  {activities.map((activity) => {
                    const actor = members.find((member) => member.user_id === activity.actor_id);
                    return (
                      <article className="activity-item" key={activity.id}>
                        <span className="activity-avatar">{memberInitials(actor?.display_name ?? 'Sistema')}</span>
                        <div><strong>{actor?.display_name || 'Sistema'}</strong><p>{activityDescription(activity, columns, members)}</p><small>{formatActivityDate(activity.created_at)}</small></div>
                      </article>
                    );
                  })}
                  {!activities.length && !activityError ? <p className="no-links">Nenhuma atividade registrada ainda.</p> : null}
                </div>
                {hasMoreActivities ? <button type="button" className="activity-load-more" onClick={() => setActivityLimit((current) => current + 40)}>Carregar atividades anteriores</button> : null}
              </div>
            ) : null}
          </section>
        ) : null}

        {mode === 'edit' && canManagePlanning ? <button type="button" className="delete-task" disabled={deleting} onClick={() => void deleteTask()}>{deleting ? <LoaderCircle className="spinner" size={16} /> : <Trash2 size={16} />}Excluir tarefa</button> : null}
      </aside>
      {appDialog.host}
    </div>
  );
}

function taskToDraft(task: Task): TaskDraft {
  return {
    title: task.title,
    description: task.description,
    priority: task.priority,
    due_at: task.due_at ? task.due_at.slice(0, 10) : '',
    client_id: task.client_id ?? '',
    assignee_id: task.assignee_id ?? '',
    revision_round: task.revision_round ?? 1,
  };
}

function priorityLabel(priority: TaskPriority) {
  return ({ low: 'Baixa', normal: 'Normal', high: 'Alta', urgent: 'Urgente' })[priority];
}

function linkCategoryLabel(category: TaskLinkCategory) {
  return ({ download: 'Download', briefing: 'Briefing', reference: 'Referência', review: 'Revisão', delivery: 'Entrega' })[category];
}

function activityDescription(activity: TaskActivity, columns: BoardColumn[], members: WorkspaceMember[]) {
  if (activity.action === 'created') return 'criou esta tarefa.';
  if (activity.action === 'updated') return 'atualizou os detalhes da tarefa.';
  if (activity.action === 'moved') {
    const from = columns.find((column) => column.id === activity.details.from_column_id)?.name ?? 'outra coluna';
    const to = columns.find((column) => column.id === activity.details.to_column_id)?.name ?? 'outra coluna';
    return `moveu a tarefa de ${from} para ${to}.`;
  }
  if (activity.action === 'assigned') {
    const assigneeId = activity.details.to_user_id;
    if (!assigneeId) return 'removeu o responsável pela tarefa.';
    const assignee = members.find((member) => member.user_id === assigneeId)?.display_name ?? 'um membro';
    return `atribuiu a tarefa para ${assignee}.`;
  }
  if (activity.action === 'link_added') return `adicionou o link “${activity.details.label ?? 'sem nome'}”.`;
  if (activity.action === 'link_removed') return `removeu o link “${activity.details.label ?? 'sem nome'}”.`;
  if (activity.action === 'revision_changed') return `alterou a revisão para V${activity.details.to_revision ?? '?'}.`;
  if (activity.action === 'comment_added') return `comentou na revisão V${activity.details.revision_round ?? '?'}.`;
  if (activity.action === 'adjustment_requested') return `solicitou um ajuste na revisão V${activity.details.revision_round ?? '?'}.`;
  if (activity.action === 'comment_resolved') return `marcou um feedback da V${activity.details.revision_round ?? '?'} como resolvido.`;
  return `reabriu um feedback da V${activity.details.revision_round ?? '?'}.`;
}

function roleLabel(role: WorkspaceMember['role']) {
  if (role === 'owner') return 'Proprietário';
  if (role === 'admin') return 'Administrador';
  return 'Editor';
}

function memberInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return `${parts[0]?.[0] ?? 'M'}${parts.length > 1 ? parts.at(-1)?.[0] ?? '' : ''}`.toUpperCase();
}

function availabilityLabel(availability: MemberAvailability) {
  if (availability === 'busy') return 'Ocupado';
  if (availability === 'away') return 'Ausente';
  if (availability === 'offline') return 'Offline';
  return 'Disponível';
}

function availabilityDescription(availability: MemberAvailability, activeTasks: number) {
  if (availability === 'offline') return 'O EditFlow está fechado ou sem conexão.';
  if (availability === 'away') return 'Computador inativo ou bloqueado há pelo menos 5 minutos.';
  if (availability === 'busy') return `Online com ${activeTasks} ${activeTasks === 1 ? 'trabalho ativo' : 'trabalhos ativos'}.`;
  return 'Online e sem trabalhos ativos.';
}

function normalizeText(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
}

function taskSortValue(task: Task) {
  return task.due_at ? new Date(task.due_at).getTime() : Number.MAX_SAFE_INTEGER;
}

function completedTaskDate(task: Task) {
  return task.completed_at ?? task.updated_at;
}

function completedTaskTime(task: Task) {
  return new Date(completedTaskDate(task)).getTime();
}

function completedTaskMonth(task: Task) {
  const date = new Date(completedTaskDate(task));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function formatCompletedMonth(month: string) {
  const [year, monthNumber] = month.split('-').map(Number);
  if (!year || !monthNumber) return month;
  const formatted = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(new Date(year, monthNumber - 1, 1));
  return formatted.charAt(0).toLocaleUpperCase('pt-BR') + formatted.slice(1);
}

function formatCompletedDate(date: string) {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(date));
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(new Date(date));
}

function formatCardDate(date: string) {
  const parsed = new Date(date);
  const day = String(parsed.getDate()).padStart(2, '0');
  const month = new Intl.DateTimeFormat('pt-BR', { month: 'short' }).format(parsed).replace('.', '').toUpperCase();
  return `${day} ${month} ${parsed.getFullYear()}`;
}

function taskCountdown(date: string | null, completed = false): { label: string; state: 'neutral' | 'soon' | 'overdue' | 'completed' } {
  if (completed) return { label: 'Finalizado', state: 'completed' };
  if (!date) return { label: 'Sem prazo', state: 'neutral' };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(date);
  due.setHours(0, 0, 0, 0);
  const distance = Math.round((due.getTime() - today.getTime()) / 86_400_000);

  if (distance < 0) return { label: `${Math.abs(distance)}d atrasado`, state: 'overdue' };
  if (distance === 0) return { label: 'Entrega hoje', state: 'soon' };
  if (distance === 1) return { label: '1 dia restante', state: 'soon' };
  return { label: `${distance} dias restantes`, state: 'neutral' };
}

function formatActivityDate(date: string) {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));
}

function isOverdue(date: string) {
  return new Date(date).getTime() < new Date().setHours(0, 0, 0, 0);
}

function shortHost(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function syncLabel(status: SyncStatus) {
  if (status === 'connected') return 'Sincronizado';
  if (status === 'offline') return 'Sem conexão';
  if (status === 'error') return 'Falha na sincronização';
  return 'Conectando...';
}

function syncStatusTitle(status: SyncStatus, lastSyncedAt: string | null) {
  if (status === 'offline') return 'Sem conexão com a internet. Clique para tentar novamente.';
  if (status === 'error') return 'O canal em tempo real falhou. Clique para sincronizar os dados agora.';
  if (!lastSyncedAt) return 'Conectando ao Supabase Realtime...';
  const time = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(lastSyncedAt));
  return `Última sincronização às ${time}. Clique para atualizar agora.`;
}

function nativeNotificationTitle(type: AppNotification['type']) {
  if (type === 'chat_mention') return 'Você foi mencionado';
  if (type === 'chat_message') return 'Nova mensagem';
  if (type === 'assignment') return 'Nova tarefa atribuída';
  if (type === 'comment') return 'Novo comentário';
  if (type === 'change_request') return 'Novo ajuste solicitado';
  if (type === 'task_moved') return 'Tarefa movimentada';
  if (type === 'invite_accepted') return 'Convite aceito';
  return 'Tarefa atualizada';
}
