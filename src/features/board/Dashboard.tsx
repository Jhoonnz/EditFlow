import { DragEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel, User } from '@supabase/supabase-js';
import {
  Bell,
  CalendarDays,
  ChevronDown,
  CirclePlus,
  ExternalLink,
  LayoutDashboard,
  Link2,
  LoaderCircle,
  LogOut,
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
  Board,
  BoardColumn,
  Client,
  Task,
  TaskDraft,
  TaskLink,
  TaskLinkCategory,
  TaskPriority,
  WorkspaceSummary,
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
};

export function Dashboard({ user, workspace, workspaces, onWorkspaceChange, onWorkspacesChanged }: Props) {
  const [board, setBoard] = useState<Board | null>(null);
  const [columns, setColumns] = useState<BoardColumn[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [links, setLinks] = useState<TaskLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(navigator.onLine ? 'connecting' : 'offline');
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [dropColumnId, setDropColumnId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ mode: 'new' | 'edit'; task: Task | null; columnId?: string } | null>(null);
  const [view, setView] = useState<DashboardView>('board');
  const [columnMenuId, setColumnMenuId] = useState<string | null>(null);
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
    const [columnResult, taskResult, clientResult] = await Promise.all([
      supabase.from('columns').select('*').eq('board_id', currentBoard.id).order('position'),
      supabase.from('tasks').select('*').eq('board_id', currentBoard.id).order('position'),
      supabase.from('clients').select('*').eq('workspace_id', workspace.id).order('name'),
    ]);

    const firstError = columnResult.error ?? taskResult.error ?? clientResult.error;
    if (firstError) {
      setError(firstError.message);
      setLoading(false);
      return;
    }

    const nextTasks = (taskResult.data ?? []) as Task[];
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
    setLinks(nextLinks);
    setLoading(false);
  }, [workspace.id]);

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
  }, [scheduleReload, workspace.id]);

  const filteredTasks = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('pt-BR');
    if (!term) return tasks;
    return tasks.filter((task) => {
      const client = clients.find((item) => item.id === task.client_id);
      return `${task.title} ${task.description} ${client?.name ?? ''}`.toLocaleLowerCase('pt-BR').includes(term);
    });
  }, [clients, search, tasks]);

  const tasksByColumn = useMemo(() => {
    const grouped = new Map<string, Task[]>();
    columns.forEach((column) => grouped.set(column.id, []));
    filteredTasks.forEach((task) => grouped.get(task.column_id)?.push(task));
    return grouped;
  }, [columns, filteredTasks]);

  const moveTask = async (taskId: string, columnId: string) => {
    if (!supabase) return;
    const task = tasks.find((item) => item.id === taskId);
    if (!task || task.column_id === columnId) return;

    const columnTasks = tasks.filter((item) => item.column_id === columnId);
    const position = Math.max(0, ...columnTasks.map((item) => Number(item.position))) + 1000;
    setTasks((current) => current.map((item) => item.id === taskId ? { ...item, column_id: columnId, position } : item));

    const { error: updateError } = await supabase
      .from('tasks')
      .update({ column_id: columnId, position })
      .eq('id', taskId);
    if (updateError) {
      setError(updateError.message);
      await loadBoard(true);
    }
  };

  const handleDrop = (event: DragEvent, columnId: string) => {
    event.preventDefault();
    const taskId = event.dataTransfer.getData('text/editflow-task') || draggedTaskId;
    setDropColumnId(null);
    setDraggedTaskId(null);
    if (taskId) void moveTask(taskId, columnId);
  };

  const renameColumn = async (column: BoardColumn) => {
    if (!supabase) return;
    const nextName = window.prompt('Novo nome da coluna:', column.name)?.trim();
    if (!nextName || nextName === column.name) return;
    const { error: updateError } = await supabase.from('columns').update({ name: nextName }).eq('id', column.id);
    if (updateError) setError(updateError.message);
    else await loadBoard(true);
    setColumnMenuId(null);
  };

  const changeColumnColor = async (column: BoardColumn, color: string) => {
    if (!supabase) return;
    setColumns((current) => current.map((item) => item.id === column.id ? { ...item, color } : item));
    const { error: updateError } = await supabase.from('columns').update({ color }).eq('id', column.id);
    if (updateError) { setError(updateError.message); await loadBoard(true); }
  };

  const deleteColumn = async (column: BoardColumn) => {
    if (!supabase) return;
    const taskCount = tasks.filter((task) => task.column_id === column.id).length;
    if (taskCount) return setError(`Mova as ${taskCount} tarefas desta coluna antes de excluí-la.`);
    if (columns.length === 1) return setError('O quadro precisa ter pelo menos uma coluna.');
    if (!window.confirm(`Excluir a coluna “${column.name}”?`)) return;
    const { error: deleteError } = await supabase.from('columns').delete().eq('id', column.id);
    if (deleteError) setError(deleteError.message);
    else await loadBoard(true);
    setColumnMenuId(null);
  };

  const notifications = useMemo(() => tasks
    .filter((task) => task.due_at)
    .map((task) => ({ task, distance: new Date(task.due_at!).getTime() - Date.now() }))
    .filter(({ distance }) => distance < 7 * 24 * 60 * 60 * 1000)
    .sort((a, b) => a.distance - b.distance), [tasks]);

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
              <button className={`round-action ${notifications.length ? 'has-notifications' : ''}`} aria-label="Notificações" onClick={() => setShowNotifications((show) => !show)}><Bell size={19} />{notifications.length ? <i /> : null}</button>
              {showNotifications ? (
                <div className="notification-popover">
                  <strong>Prazos próximos</strong>
                  {notifications.map(({ task, distance }) => <button key={task.id} onClick={() => { setView('board'); setEditor({ mode: 'edit', task }); setShowNotifications(false); }}><span>{task.title}</span><small className={distance < 0 ? 'overdue' : ''}>{distance < 0 ? 'Atrasado' : formatDate(task.due_at!)}</small></button>)}
                  {!notifications.length ? <p>Nenhum prazo nos próximos 7 dias.</p> : null}
                </div>
              ) : null}
            </div>
            {view === 'board' ? <button className="new-task-button" onClick={() => setEditor({ mode: 'new', task: null, columnId: columns[0]?.id })}><Plus size={18} />Nova tarefa</button> : null}
          </div>
        </header>

        {view === 'board' ? <div className="board-toolbar">
          <label className="board-search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar trabalhos ou clientes..." /></label>
          <span className="task-total">{tasks.length} {tasks.length === 1 ? 'trabalho' : 'trabalhos'}</span>
        </div> : null}

        {error ? <div className="board-error"><span>{error}</span><button onClick={() => void loadBoard()}>Tentar novamente</button></div> : null}

        {view === 'board' ? <div className="kanban-board">
          {columns.map((column) => {
            const columnTasks = tasksByColumn.get(column.id) ?? [];
            return (
              <section
                className={`kanban-column ${dropColumnId === column.id ? 'drop-active' : ''}`}
                key={column.id}
                onDragOver={(event) => { event.preventDefault(); setDropColumnId(column.id); }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropColumnId(null); }}
                onDrop={(event) => handleDrop(event, column.id)}
              >
                <header className="column-header">
                  <span className="column-dot" style={{ background: column.color ?? '#8b8fa3' }} />
                  <h2>{column.name}</h2>
                  <span className="column-count">{columnTasks.length}</span>
                  <button aria-label={`Opções de ${column.name}`} onClick={() => setColumnMenuId((current) => current === column.id ? null : column.id)}><MoreHorizontal size={17} /></button>
                  {columnMenuId === column.id ? (
                    <div className="column-menu">
                      <button onClick={() => void renameColumn(column)}>Renomear</button>
                      <label><span>Cor</span><input type="color" value={column.color ?? '#8b8fa3'} onChange={(event) => void changeColumnColor(column, event.target.value)} /></label>
                      <button className="danger" onClick={() => void deleteColumn(column)}>Excluir coluna</button>
                    </div>
                  ) : null}
                </header>

                <div className="column-cards">
                  {columnTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      client={clients.find((client) => client.id === task.client_id)}
                      linkCount={links.filter((link) => link.task_id === task.id).length}
                      onOpen={() => setEditor({ mode: 'edit', task })}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/editflow-task', task.id);
                        setDraggedTaskId(task.id);
                      }}
                      dragging={draggedTaskId === task.id}
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
          links={editor.task ? links.filter((link) => link.task_id === editor.task?.id) : []}
          userId={user.id}
          onClose={() => setEditor(null)}
          onChanged={async () => { await loadBoard(true); setEditor(null); }}
          onLinksChanged={async () => { await loadBoard(true); }}
        />
      ) : null}
    </main>
  );
}

function TaskCard({
  task,
  client,
  linkCount,
  onOpen,
  onDragStart,
  dragging,
}: {
  task: Task;
  client?: Client;
  linkCount: number;
  onOpen: () => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
  dragging: boolean;
}) {
  return (
    <button
      className={`task-card ${dragging ? 'dragging' : ''}`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={() => undefined}
      onClick={onOpen}
    >
      <div className="task-card-top"><span className={`priority-badge ${task.priority}`}>{priorityLabel(task.priority)}</span><MoreHorizontal size={16} /></div>
      <h3>{task.title}</h3>
      {task.description ? <p>{task.description}</p> : null}
      <div className="task-meta">
        {client ? <span><UserRound size={14} />{client.name}</span> : null}
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
    };

    const result = mode === 'new'
      ? await supabase.from('tasks').insert({
          ...payload,
          workspace_id: workspace.id,
          board_id: board.id,
          column_id: firstColumn.id,
          created_by: userId,
          position: Date.now(),
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
  };

  const removeLink = async (linkId: string) => {
    if (!supabase) return;
    const { error: removeError } = await supabase.from('task_links').delete().eq('id', linkId);
    if (removeError) setError(removeError.message);
    else await onLinksChanged();
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

          {showClientForm ? <div className="quick-client"><input value={newClientName} onChange={(event) => setNewClientName(event.target.value)} placeholder="Nome do novo cliente" /><button type="button" onClick={() => void createClient()}>Adicionar</button></div> : null}

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
  };
}

function priorityLabel(priority: TaskPriority) {
  return ({ low: 'Baixa', normal: 'Normal', high: 'Alta', urgent: 'Urgente' })[priority];
}

function linkCategoryLabel(category: TaskLinkCategory) {
  return ({ download: 'Download', briefing: 'Briefing', reference: 'Referência', review: 'Revisão', delivery: 'Entrega' })[category];
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(new Date(date));
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
