import { DragEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel, User } from '@supabase/supabase-js';
import {
  Bell,
  CalendarDays,
  ChevronDown,
  CirclePlus,
  Columns3,
  ExternalLink,
  GripVertical,
  History,
  LayoutDashboard,
  Link2,
  LoaderCircle,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Sparkles,
  Trash2,
  UserRound,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { ClientsView, SettingsView } from '../workspace/WorkspaceViews';
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
} from '../workspace/types';

type Props = {
  user: User;
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  onWorkspaceChange: (id: string) => void;
  onWorkspacesChanged: () => Promise<void>;
};

type SyncStatus = 'connecting' | 'connected' | 'offline' | 'error';
type DashboardView = 'board' | 'clients' | 'settings';

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

export function Dashboard({ user, workspace, workspaces, onWorkspaceChange, onWorkspacesChanged }: Props) {
  const [board, setBoard] = useState<Board | null>(null);
  const [columns, setColumns] = useState<BoardColumn[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [links, setLinks] = useState<TaskLink[]>([]);
  const [inboxNotifications, setInboxNotifications] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(navigator.onLine ? 'connecting' : 'offline');
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
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadBoard = useCallback(async (quiet = false) => {
    if (!supabase) return;
    if (!quiet) setLoading(true);
    setError(null);

    const { data: boardRow, error: boardError } = await supabase
      .from('boards')
      .select('id, name, workspace_id')
      .eq('workspace_id', workspace.id)
      .order('created_at')
      .limit(1)
      .maybeSingle();

    if (boardError || !boardRow) {
      setError(boardError?.message ?? 'Nenhum quadro foi encontrado neste espaço.');
      setLoading(false);
      return;
    }

    const currentBoard = boardRow as Board;
    const [columnResult, taskResult, clientResult, membershipResult, notificationResult] = await Promise.all([
      supabase.from('columns').select('*').eq('board_id', currentBoard.id).order('position'),
      supabase.from('tasks').select('*').eq('board_id', currentBoard.id).order('position'),
      supabase.from('clients').select('*').eq('workspace_id', workspace.id).order('name'),
      supabase.from('workspace_members').select('user_id, role').eq('workspace_id', workspace.id),
      supabase.from('notifications').select('*').eq('workspace_id', workspace.id).eq('user_id', user.id).order('created_at', { ascending: false }).limit(30),
    ]);

    const firstError = columnResult.error ?? taskResult.error ?? clientResult.error ?? membershipResult.error ?? notificationResult.error;
    if (firstError) {
      setError(firstError.message);
      setLoading(false);
      return;
    }

    const nextTasks = (taskResult.data ?? []) as Task[];
    const memberIds = (membershipResult.data ?? []).map((membership) => membership.user_id as string);
    const profileResult = memberIds.length
      ? await supabase.from('profiles').select('id, display_name').in('id', memberIds)
      : { data: [], error: null };
    if (profileResult.error) {
      setError(profileResult.error.message);
      setLoading(false);
      return;
    }
    const memberNames = new Map((profileResult.data ?? []).map((profile) => [profile.id as string, profile.display_name as string]));
    const nextMembers = (membershipResult.data ?? []).map((membership) => ({
      user_id: membership.user_id as string,
      role: membership.role as WorkspaceMember['role'],
      display_name: memberNames.get(membership.user_id as string) || 'Membro',
    }));
    let nextLinks: TaskLink[] = [];
    if (nextTasks.length) {
      const linkResult = await supabase
        .from('task_links')
        .select('*')
        .in('task_id', nextTasks.map((task) => task.id))
        .order('created_at');
      if (!linkResult.error) nextLinks = (linkResult.data ?? []) as TaskLink[];
    }

    setBoard(currentBoard);
    setColumns((columnResult.data ?? []) as BoardColumn[]);
    setTasks(nextTasks);
    setClients((clientResult.data ?? []) as Client[]);
    setMembers(nextMembers);
    setLinks(nextLinks);
    setInboxNotifications((notificationResult.data ?? []) as AppNotification[]);
    setLoading(false);
  }, [user.id, workspace.id]);

  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => void loadBoard(true), 180);
  }, [loadBoard]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  useEffect(() => {
    if (!supabase) return;
    const realtimeClient = supabase;
    let channel: RealtimeChannel | null = null;

    const connect = () => {
      setSyncStatus(navigator.onLine ? 'connecting' : 'offline');
      if (channel) void realtimeClient.removeChannel(channel);
      channel = realtimeClient
        .channel(`editflow:${workspace.id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `workspace_id=eq.${workspace.id}` }, scheduleReload)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'clients', filter: `workspace_id=eq.${workspace.id}` }, scheduleReload)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'task_links' }, scheduleReload)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'columns' }, scheduleReload)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'workspace_members', filter: `workspace_id=eq.${workspace.id}` }, scheduleReload)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${user.id}` }, scheduleReload)
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') setSyncStatus('connected');
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setSyncStatus('error');
        });
    };

    const handleOnline = () => { connect(); scheduleReload(); };
    const handleOffline = () => setSyncStatus('offline');
    connect();
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (channel) void realtimeClient.removeChannel(channel);
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
    };
  }, [scheduleReload, user.id, workspace.id]);

  const filteredTasks = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('pt-BR');
    if (!term) return tasks;
    return tasks.filter((task) => {
      const client = clients.find((item) => item.id === task.client_id);
      const assignee = members.find((item) => item.user_id === task.assignee_id);
      return `${task.title} ${task.description} ${client?.name ?? ''} ${assignee?.display_name ?? ''}`.toLocaleLowerCase('pt-BR').includes(term);
    });
  }, [clients, members, search, tasks]);

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
    if (!supabase || !board || columnId === targetColumnId) return;
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
    .filter((task) => task.due_at)
    .map((task) => ({ task, distance: new Date(task.due_at!).getTime() - Date.now() }))
    .filter(({ distance }) => distance < 7 * 24 * 60 * 60 * 1000)
    .sort((a, b) => a.distance - b.distance), [tasks]);

  const unreadNotifications = inboxNotifications.filter((notification) => !notification.read_at);

  const openInboxNotification = async (notification: AppNotification) => {
    const notificationTask = tasks.find((task) => task.id === notification.task_id);
    if (notificationTask) {
      setView('board');
      setEditor({ mode: 'edit', task: notificationTask });
    }
    setShowNotifications(false);
    if (!supabase || notification.read_at) return;
    const readAt = new Date().toISOString();
    setInboxNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, read_at: readAt } : item));
    await supabase.from('notifications').update({ read_at: readAt }).eq('id', notification.id);
  };

  const markAllNotificationsRead = async () => {
    if (!supabase || !unreadNotifications.length) return;
    const readAt = new Date().toISOString();
    setInboxNotifications((current) => current.map((item) => ({ ...item, read_at: item.read_at ?? readAt })));
    await supabase.from('notifications').update({ read_at: readAt }).eq('workspace_id', workspace.id).eq('user_id', user.id).is('read_at', null);
  };

  if (loading) {
    return <main className="app-loading"><LoaderCircle className="spinner" size={26} /></main>;
  }

  return (
    <main className="dashboard-shell">
      <aside className="app-sidebar">
        <div className="sidebar-brand"><span className="sidebar-logo"><Sparkles size={18} /></span><span>EditFlow</span></div>

        <label className="workspace-select-wrap">
          <span className="workspace-avatar">{workspace.name.slice(0, 1).toUpperCase()}</span>
          <select value={workspace.id} onChange={(event) => onWorkspaceChange(event.target.value)}>
            {workspaces.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
          </select>
          <ChevronDown size={15} />
        </label>

        <nav className="sidebar-nav" aria-label="Navegação principal">
          <button className={`nav-item ${view === 'board' ? 'active' : ''}`} onClick={() => setView('board')}><LayoutDashboard size={18} /><span>Produção</span></button>
          <button className={`nav-item ${view === 'clients' ? 'active' : ''}`} onClick={() => setView('clients')}><Users size={18} /><span>Clientes</span><small>{clients.length}</small></button>
        </nav>

        <div className="sidebar-spacer" />
        <div className={`sync-pill ${syncStatus}`}>
          {syncStatus === 'offline' || syncStatus === 'error' ? <WifiOff size={14} /> : <Wifi size={14} />}
          <span>{syncLabel(syncStatus)}</span>
        </div>
        <button className={`nav-item ${view === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')}><Settings size={18} /><span>Configurações</span></button>
        <button className="account-row" onClick={() => void supabase?.auth.signOut()} title="Sair da conta">
          <span className="user-avatar">{(user.email?.[0] ?? 'U').toUpperCase()}</span>
          <span className="account-copy"><strong>{user.user_metadata.full_name || 'Minha conta'}</strong><small>{user.email}</small></span>
          <LogOut size={16} />
        </button>
      </aside>

      <section className="dashboard-main">
        <header className="dashboard-header">
          <div>
            <p>ESPAÇO DE TRABALHO</p>
            <h1>{view === 'board' ? board?.name ?? 'Produção' : view === 'clients' ? 'Clientes' : 'Configurações'}</h1>
          </div>
          <div className="header-actions">
            <div className="notification-wrap">
              <button className={`round-action ${unreadNotifications.length || deadlineNotifications.length ? 'has-notifications' : ''}`} aria-label="Notificações" onClick={() => setShowNotifications((show) => !show)}><Bell size={19} />{unreadNotifications.length ? <i /> : null}</button>
              {showNotifications ? (
                <div className="notification-popover">
                  <div className="notification-heading"><strong>Notificações</strong>{unreadNotifications.length ? <button onClick={() => void markAllNotificationsRead()}>Marcar como lidas</button> : null}</div>
                  {inboxNotifications.slice(0, 8).map((notification) => <button className={notification.read_at ? '' : 'unread'} key={notification.id} onClick={() => void openInboxNotification(notification)}><span>{notification.message}</span><small>{formatActivityDate(notification.created_at)}</small></button>)}
                  {!inboxNotifications.length ? <p>Nenhum comentário ou atribuição nova.</p> : null}
                  {deadlineNotifications.length ? <div className="notification-divider">PRAZOS PRÓXIMOS</div> : null}
                  {deadlineNotifications.map(({ task, distance }) => <button key={`deadline-${task.id}`} onClick={() => { setView('board'); setEditor({ mode: 'edit', task }); setShowNotifications(false); }}><span>{task.title}</span><small className={distance < 0 ? 'overdue' : ''}>{distance < 0 ? 'Atrasado' : formatDate(task.due_at!)}</small></button>)}
                </div>
              ) : null}
            </div>
            {view === 'board' ? <button className="new-task-button" onClick={() => setEditor({ mode: 'new', task: null, columnId: columns[0]?.id })}><Plus size={18} />Nova tarefa</button> : null}
          </div>
        </header>

        {view === 'board' ? <div className="board-toolbar">
          <label className="board-search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar trabalhos ou clientes..." /></label>
          <div className="board-toolbar-actions">
            <span className="task-total">{tasks.length} {tasks.length === 1 ? 'trabalho' : 'trabalhos'}</span>
            <button className="new-column-button" onClick={() => setCreatingColumn(true)}><Columns3 size={16} />Nova coluna</button>
          </div>
        </div> : null}

        {error ? <div className="board-error"><span>{error}</span><button onClick={() => void loadBoard()}>Tentar novamente</button></div> : null}

        {view === 'board' ? <div className="kanban-board">
          {columns.map((column) => {
            const columnTasks = tasksByColumn.get(column.id) ?? [];
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
                  <button
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
                  ><GripVertical size={15} /></button>
                  <span className="column-dot" style={{ background: column.color ?? '#8b8fa3' }} />
                  <h2>{column.name}</h2>
                  <span className="column-count">{columnTasks.length}</span>
                  <button aria-label={`Opções de ${column.name}`} onClick={() => setColumnMenuId((current) => current === column.id ? null : column.id)}><MoreHorizontal size={17} /></button>
                  {columnMenuId === column.id ? (
                    <div className="column-menu">
                      <button onClick={() => { setEditingColumn(column); setColumnMenuId(null); }}>Editar nome e cor</button>
                      <button className="danger" onClick={() => { setEditingColumn(column); setColumnMenuId(null); }}>Gerenciar coluna</button>
                    </div>
                  ) : null}
                </header>

                <div className="column-cards">
                  {columnTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      client={clients.find((client) => client.id === task.client_id)}
                      assignee={members.find((member) => member.user_id === task.assignee_id)}
                      linkCount={links.filter((link) => link.task_id === task.id).length}
                      onOpen={() => setEditor({ mode: 'edit', task })}
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

                <button className="column-add" onClick={() => setEditor({ mode: 'new', task: null, columnId: column.id })}><Plus size={16} />Adicionar tarefa</button>
              </section>
            );
          })}
        </div> : null}
        {view === 'clients' ? <ClientsView workspace={workspace} clients={clients} tasks={tasks} onChanged={() => loadBoard(true)} /> : null}
        {view === 'settings' ? <SettingsView user={user} workspace={workspace} onWorkspacesChanged={onWorkspacesChanged} /> : null}
      </section>

      {editor && board && columns[0] ? (
        <TaskEditor
          mode={editor.mode}
          task={editor.task}
          board={board}
          firstColumn={columns.find((column) => column.id === editor.columnId) ?? columns[0]}
          workspace={workspace}
          clients={clients}
          members={members}
          columns={columns}
          links={editor.task ? links.filter((link) => link.task_id === editor.task?.id) : []}
          userId={user.id}
          onClose={() => setEditor(null)}
          onChanged={async () => { await loadBoard(true); setEditor(null); }}
          onLinksChanged={async () => { await loadBoard(true); }}
        />
      ) : null}
      {editingColumn ? (
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
      {creatingColumn && board ? (
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
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="column-editor-modal" role="dialog" aria-modal="true" aria-label={column ? 'Editar coluna' : 'Criar coluna'}>
        <header><div><p>CONFIGURAÇÃO DA COLUNA</p><h2>{column ? 'Editar coluna' : 'Criar coluna'}</h2></div><button onClick={onClose} aria-label="Fechar"><X size={19} /></button></header>
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
  client,
  assignee,
  linkCount,
  onOpen,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  dragging,
  dropEdge,
  dragEnabled,
}: {
  task: Task;
  client?: Client;
  assignee?: WorkspaceMember;
  linkCount: number;
  onOpen: () => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLButtonElement>) => void;
  onDrop: (event: DragEvent<HTMLButtonElement>) => void;
  dragging: boolean;
  dropEdge: 'before' | 'after' | null;
  dragEnabled: boolean;
}) {
  return (
    <button
      className={`task-card ${dragging ? 'dragging' : ''} ${dropEdge ? `task-drop-${dropEdge}` : ''}`}
      draggable={dragEnabled}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={onOpen}
    >
      <div className="task-card-top"><div><span className={`priority-badge ${task.priority}`}>{priorityLabel(task.priority)}</span><span className="revision-badge">V{task.revision_round ?? 1}</span></div><MoreHorizontal size={16} /></div>
      <h3>{task.title}</h3>
      {task.description ? <p>{task.description}</p> : null}
      <div className="task-meta">
        {client ? <span><UserRound size={14} />{client.name}</span> : null}
        {assignee ? <span className="task-assignee"><i>{memberInitials(assignee.display_name)}</i>{assignee.display_name}</span> : null}
        {task.due_at ? <span className={isOverdue(task.due_at) ? 'overdue' : ''}><CalendarDays size={14} />{formatDate(task.due_at)}</span> : null}
        {linkCount ? <span><Link2 size={14} />{linkCount}</span> : null}
      </div>
    </button>
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
  onClose: () => void;
  onChanged: () => Promise<void>;
  onLinksChanged: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<TaskDraft>(() => task ? taskToDraft(task) : emptyDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newClientName, setNewClientName] = useState('');
  const [showClientForm, setShowClientForm] = useState(false);
  const [linkLabel, setLinkLabel] = useState('Arquivos para download');
  const [linkUrl, setLinkUrl] = useState('');
  const [linkCategory, setLinkCategory] = useState<TaskLinkCategory>('download');
  const [activities, setActivities] = useState<TaskActivity[]>([]);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [commentBody, setCommentBody] = useState('');
  const [commentKind, setCommentKind] = useState<TaskCommentKind>('change_request');
  const [commentSaving, setCommentSaving] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);

  const loadReviewData = useCallback(async () => {
    if (!supabase || !task) return;
    const [activityResult, commentResult] = await Promise.all([
      supabase.from('task_activities').select('*').eq('task_id', task.id).order('created_at', { ascending: false }).limit(60),
      supabase.from('task_comments').select('*').eq('task_id', task.id).order('created_at', { ascending: true }),
    ]);
    const loadError = activityResult.error ?? commentResult.error;
    if (loadError) {
      setActivityError(loadError.message);
      return;
    }
    setActivityError(null);
    setActivities((activityResult.data ?? []) as TaskActivity[]);
    setComments((commentResult.data ?? []) as TaskComment[]);
  }, [task]);

  useEffect(() => { void loadReviewData(); }, [loadReviewData]);

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
      : await supabase.from('tasks').update(payload).eq('id', task!.id);

    if (result.error) {
      setError(result.error.message);
      setSaving(false);
      return;
    }
    await onChanged();
  };

  const createClient = async () => {
    if (!supabase || newClientName.trim().length < 1) return;
    const { data, error: clientError } = await supabase
      .from('clients')
      .insert({ workspace_id: workspace.id, name: newClientName.trim() })
      .select('id')
      .single();
    if (clientError) { setError(clientError.message); return; }
    setDraft((current) => ({ ...current, client_id: data.id as string }));
    setNewClientName('');
    setShowClientForm(false);
    await onLinksChanged();
  };

  const addLink = async () => {
    if (!supabase || !task || !linkLabel.trim() || !linkUrl.trim()) return;
    let normalizedUrl = linkUrl.trim();
    if (!normalizedUrl.startsWith('https://')) normalizedUrl = `https://${normalizedUrl}`;
    const { error: linkError } = await supabase.from('task_links').insert({
      task_id: task.id,
      label: linkLabel.trim(),
      url: normalizedUrl,
      category: linkCategory,
      created_by: userId,
    });
    if (linkError) { setError(linkError.message); return; }
    setLinkUrl('');
    await onLinksChanged();
    await loadReviewData();
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
    if (!supabase) return;
    const nextResolved = !comment.is_resolved;
    const { error: commentError } = await supabase
      .from('task_comments')
      .update({
        is_resolved: nextResolved,
        resolved_by: nextResolved ? userId : null,
        resolved_at: nextResolved ? new Date().toISOString() : null,
      })
      .eq('id', comment.id);
    if (commentError) { setError(commentError.message); return; }
    await loadReviewData();
  };

  const deleteTask = async () => {
    if (!supabase || !task || !window.confirm(`Excluir “${task.title}”? Esta ação não pode ser desfeita.`)) return;
    const { error: deleteError } = await supabase.from('tasks').delete().eq('id', task.id);
    if (deleteError) setError(deleteError.message);
    else await onChanged();
  };

  return (
    <div className="editor-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="task-editor" aria-modal="true" role="dialog" aria-label={mode === 'new' ? 'Nova tarefa' : 'Editar tarefa'}>
        <header className="editor-header">
          <div><p>{mode === 'new' ? 'NOVO TRABALHO' : 'DETALHES DO TRABALHO'}</p><h2>{mode === 'new' ? 'Criar tarefa' : task?.title}</h2></div>
          <button onClick={onClose} aria-label="Fechar"><X size={20} /></button>
        </header>

        <form className="editor-form" onSubmit={saveTask}>
          <label><span>Título</span><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="Ex.: Vídeo da campanha de inverno" autoFocus /></label>
          <label><span>Descrição</span><textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="Briefing rápido, formato e observações..." rows={4} /></label>

          <div className="editor-grid">
            <label><span>Prioridade</span><select value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value as TaskPriority })}><option value="low">Baixa</option><option value="normal">Normal</option><option value="high">Alta</option><option value="urgent">Urgente</option></select></label>
            <label><span>Prazo</span><input type="date" value={draft.due_at} onChange={(event) => setDraft({ ...draft, due_at: event.target.value })} /></label>
          </div>

          <label>
            <span>Cliente</span>
            <div className="client-select-row">
              <select value={draft.client_id} onChange={(event) => setDraft({ ...draft, client_id: event.target.value })}><option value="">Sem cliente</option>{clients.map((client) => <option value={client.id} key={client.id}>{client.name}</option>)}</select>
              <button type="button" onClick={() => setShowClientForm((show) => !show)} aria-label="Adicionar cliente"><CirclePlus size={19} /></button>
            </div>
          </label>

          <div className="editor-grid">
            <label>
              <span>Editor responsável</span>
              <select value={draft.assignee_id} onChange={(event) => setDraft({ ...draft, assignee_id: event.target.value })}>
                <option value="">Sem responsável</option>
                {members.map((member) => <option value={member.user_id} key={member.user_id}>{member.display_name} · {roleLabel(member.role)}</option>)}
              </select>
            </label>
            <label>
              <span>Versão atual</span>
              <div className="revision-input"><strong>V</strong><input type="number" min="1" max="99" value={draft.revision_round} onChange={(event) => setDraft({ ...draft, revision_round: Math.max(1, Math.min(99, Number(event.target.value) || 1)) })} /></div>
            </label>
          </div>

          {showClientForm ? <div className="quick-client"><input value={newClientName} onChange={(event) => setNewClientName(event.target.value)} placeholder="Nome do novo cliente" /><button type="button" onClick={() => void createClient()}>Adicionar</button></div> : null}

          {mode === 'new' ? (
            <div className="initial-link-panel">
              <div><Link2 size={17} /><span><strong>Arquivos para download</strong><small>Opcional — você também poderá adicionar depois.</small></span></div>
              <input value={linkLabel} onChange={(event) => setLinkLabel(event.target.value)} placeholder="Nome do link" />
              <input value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} placeholder="https://drive.google.com/..." inputMode="url" />
            </div>
          ) : null}

          {error ? <div className="editor-error" role="alert">{error}</div> : null}

          <button className="editor-save" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spinner" size={18} /> : mode === 'new' ? 'Criar tarefa' : 'Salvar alterações'}</button>
        </form>

        {mode === 'edit' && task ? (
          <section className="links-section">
            <div className="section-title"><div><p>LINKS EXTERNOS</p><h3>Arquivos e entregas</h3></div><Link2 size={19} /></div>
            <div className="saved-links">
              {links.map((link) => (
                <div className="saved-link" key={link.id}>
                  <button className="link-open" onClick={() => void window.editflow.openExternal(link.url)}><span className={`link-kind ${link.category}`}>{linkCategoryLabel(link.category)}</span><strong>{link.label}</strong><small>{shortHost(link.url)}</small></button>
                  <button className="link-external" onClick={() => void window.editflow.openExternal(link.url)} aria-label="Abrir link"><ExternalLink size={16} /></button>
                  <button className="link-delete" onClick={() => void removeLink(link.id)} aria-label="Excluir link"><Trash2 size={16} /></button>
                </div>
              ))}
              {!links.length ? <p className="no-links">Nenhum link adicionado.</p> : null}
            </div>
            <div className="link-form">
              <select value={linkCategory} onChange={(event) => setLinkCategory(event.target.value as TaskLinkCategory)}><option value="download">Download</option><option value="briefing">Briefing</option><option value="reference">Referência</option><option value="review">Revisão</option><option value="delivery">Entrega</option></select>
              <input value={linkLabel} onChange={(event) => setLinkLabel(event.target.value)} placeholder="Nome do link" />
              <input value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} placeholder="https://drive.google.com/..." />
              <button type="button" onClick={() => void addLink()}><Plus size={16} />Adicionar link</button>
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
                    <footer><span>{comment.kind === 'change_request' ? 'Solicitado por' : 'Enviado por'} <strong>{author?.display_name || 'Membro'}</strong></span><button type="button" onClick={() => void toggleCommentResolved(comment)}>{comment.is_resolved ? 'Reabrir' : 'Marcar como resolvido'}</button></footer>
                  </article>
                );
              })}
              {!comments.length ? <p className="no-links">Nenhum comentário ou ajuste solicitado.</p> : null}
            </div>
          </section>
        ) : null}

        {mode === 'edit' && task ? (
          <section className="activity-section">
            <div className="section-title"><div><p>HISTÓRICO</p><h3>Atividade do trabalho</h3></div><History size={19} /></div>
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
          </section>
        ) : null}

        {mode === 'edit' ? <button className="delete-task" onClick={() => void deleteTask()}><Trash2 size={16} />Excluir tarefa</button> : null}
      </aside>
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

function formatDate(date: string) {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(new Date(date));
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
