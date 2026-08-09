export type WorkspaceRole = 'owner' | 'admin' | 'editor';

export type WorkspaceSummary = {
  id: string;
  name: string;
  role: WorkspaceRole;
};

export type WorkspaceMember = {
  user_id: string;
  role: WorkspaceRole;
  display_name: string;
  email?: string;
};

export type Board = {
  id: string;
  name: string;
  workspace_id: string;
};

export type BoardColumn = {
  id: string;
  board_id: string;
  name: string;
  position: number;
  color: string | null;
};

export type Client = {
  id: string;
  workspace_id: string;
  name: string;
  email: string | null;
};

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export type Task = {
  id: string;
  workspace_id: string;
  board_id: string;
  column_id: string;
  client_id: string | null;
  assignee_id: string | null;
  title: string;
  description: string;
  priority: TaskPriority;
  position: number;
  due_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type TaskLinkCategory = 'download' | 'briefing' | 'reference' | 'review' | 'delivery';

export type TaskLink = {
  id: string;
  task_id: string;
  label: string;
  url: string;
  category: TaskLinkCategory;
  expires_at: string | null;
  created_by: string;
  created_at: string;
};

export type TaskDraft = {
  title: string;
  description: string;
  priority: TaskPriority;
  due_at: string;
  client_id: string;
  assignee_id: string;
};

export type TaskActivityAction = 'created' | 'updated' | 'moved' | 'assigned' | 'link_added' | 'link_removed';

export type TaskActivity = {
  id: string;
  task_id: string;
  workspace_id: string;
  actor_id: string | null;
  action: TaskActivityAction;
  details: Record<string, string | null>;
  created_at: string;
};
