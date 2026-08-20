export type WorkspaceRole = 'owner' | 'admin' | 'editor';
export type MemberAvailability = 'available' | 'busy' | 'away' | 'offline';

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
  avatar_url?: string | null;
  availability: MemberAvailability;
  specialty?: string;
  bio?: string;
};

export type WorkspaceInvitation = {
  id: string;
  workspace_id: string;
  workspace_name: string;
  email: string;
  role: Exclude<WorkspaceRole, 'owner'>;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled';
  expires_at: string;
  created_at: string;
};

export type EditFlowAccountSearchResult = {
  user_id: string;
  display_name: string;
  email: string;
  avatar_url: string | null;
};

export type WelcomeStartupAction =
  | { kind: 'board' }
  | { kind: 'notifications'; workspaceId?: string }
  | { kind: 'task'; taskId: string; workspaceId: string };

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
  is_completion: boolean;
};

export type Client = {
  id: string;
  workspace_id: string;
  name: string;
  email: string | null;
  youtube_channel_url: string | null;
  youtube_channel_id: string | null;
  youtube_channel_title: string | null;
  youtube_thumbnail_url: string | null;
  youtube_subscriber_count: number | null;
  youtube_average_views: number | null;
  youtube_uploads_per_month: number | null;
  youtube_video_count: number | null;
  youtube_last_synced_at: string | null;
};

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export type Task = {
  id: string;
  workspace_id: string;
  board_id: string;
  column_id: string;
  client_id: string | null;
  assignee_id: string | null;
  revision_round: number;
  title: string;
  description: string;
  priority: TaskPriority;
  position: number;
  due_at: string | null;
  completed_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type BillingPricingModel = 'per_video' | 'bundle';
export type BillingCurrency = 'USD' | 'BRL';
export type PaymentMethod = 'none' | 'paypal_international' | 'wise_ach' | 'wise_wire' | 'custom';

export type ClientBillingSetting = {
  client_id: string;
  workspace_id: string;
  currency: BillingCurrency;
  pricing_model: BillingPricingModel;
  amount_usd: number;
  bundle_size: number;
  payment_method: PaymentMethod;
  fee_percent: number;
  fee_fixed_usd: number;
  conversion_spread_percent: number;
  created_at: string;
  updated_at: string;
};

export type EarningStatus = 'pending' | 'received';

export type Earning = {
  id: string;
  workspace_id: string;
  client_id: string | null;
  source_type: BillingPricingModel | 'manual';
  description: string;
  item_count: number;
  currency: BillingCurrency;
  amount_usd: number;
  net_amount_usd: number;
  payment_method: PaymentMethod;
  fee_percent: number;
  fee_fixed_usd: number;
  conversion_spread_percent: number;
  status: EarningStatus;
  earned_at: string;
  received_at: string | null;
  exchange_rate_brl: number | null;
  amount_brl: number | null;
  created_at: string;
  updated_at: string;
};

export type EarningEvent = {
  id: string;
  workspace_id: string;
  client_id: string;
  task_id: string | null;
  task_title: string;
  completed_at: string;
  pricing_model: BillingPricingModel;
  currency: BillingCurrency;
  amount_usd: number;
  bundle_size: number;
  payment_method: PaymentMethod;
  fee_percent: number;
  fee_fixed_usd: number;
  conversion_spread_percent: number;
  earning_id: string | null;
  created_at: string;
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
  revision_round: number;
};

export type TaskActivityAction =
  | 'created'
  | 'updated'
  | 'moved'
  | 'assigned'
  | 'link_added'
  | 'link_removed'
  | 'revision_changed'
  | 'comment_added'
  | 'adjustment_requested'
  | 'comment_resolved'
  | 'comment_reopened';

export type TaskActivity = {
  id: string;
  task_id: string;
  workspace_id: string;
  actor_id: string | null;
  action: TaskActivityAction;
  details: Record<string, string | null>;
  created_at: string;
};

export type TaskCommentKind = 'comment' | 'change_request';

export type TaskComment = {
  id: string;
  task_id: string;
  workspace_id: string;
  author_id: string;
  kind: TaskCommentKind;
  body: string;
  revision_round: number;
  is_resolved: boolean;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AppNotification = {
  id: string;
  workspace_id: string;
  user_id: string;
  task_id: string | null;
  actor_id: string | null;
  type: 'assignment' | 'comment' | 'change_request' | 'task_updated' | 'task_moved' | 'invite_accepted' | 'chat_message';
  conversation_id: string | null;
  message: string;
  read_at: string | null;
  created_at: string;
};

export type ChatConversation = {
  id: string;
  workspace_id: string;
  kind: 'general' | 'direct';
  title: string | null;
  direct_key: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type ChatConversationMember = {
  conversation_id: string;
  workspace_id: string;
  user_id: string;
  last_read_at: string | null;
  joined_at: string;
};

export type ChatMessage = {
  id: string;
  conversation_id: string;
  workspace_id: string;
  sender_id: string;
  body: string;
  edited_at: string | null;
  created_at: string;
};
