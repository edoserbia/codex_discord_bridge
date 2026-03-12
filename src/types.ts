export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export type ApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';

export interface BindingCodexOptions {
  model?: string | undefined;
  profile?: string | undefined;
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  search: boolean;
  skipGitRepoCheck: boolean;
  addDirs: string[];
  extraConfig: string[];
}

export interface ChannelBinding {
  channelId: string;
  guildId: string;
  projectName: string;
  workspacePath: string;
  codex: BindingCodexOptions;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSessionState {
  conversationId: string;
  bindingChannelId: string;
  codexThreadId?: string | undefined;
  statusMessageId?: string | undefined;
  lastRunAt?: string | undefined;
  lastPromptBy?: string | undefined;
  updatedAt: string;
}

export interface PersistedState {
  bindings: Record<string, ChannelBinding>;
  sessions: Record<string, ConversationSessionState>;
}

export interface AttachmentRef {
  name: string;
  localPath: string;
  sourceUrl: string;
  isImage: boolean;
  contentType?: string | undefined;
  size?: number | undefined;
}

export interface PromptTask {
  id: string;
  prompt: string;
  effectivePrompt: string;
  requestedBy: string;
  requestedById: string;
  messageId: string;
  enqueuedAt: string;
  bindingChannelId: string;
  conversationId: string;
  attachments: AttachmentRef[];
  attachmentDir?: string | undefined;
}

export interface CommandRecord {
  command: string;
  output: string;
  exitCode: number | null;
}

export interface PlanItem {
  text: string;
  completed: boolean;
}

export type RunStatus = 'idle' | 'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ActiveRunState {
  task: PromptTask;
  status: RunStatus;
  startedAt: string;
  latestActivity: string;
  currentCommand?: string | undefined;
  lastCommandOutput?: string | undefined;
  agentMessages: string[];
  reasoningSummaries: string[];
  planItems: PlanItem[];
  timeline: string[];
  stderr: string[];
  usedResume: boolean;
  progressMessageId?: string | undefined;
  codexThreadId?: string | undefined;
  exitCode?: number | null | undefined;
  signal?: NodeJS.Signals | null | undefined;
}

export interface ChannelRuntime {
  conversationId: string;
  queue: PromptTask[];
  activeRun?: ActiveRunState | undefined;
}

export interface CodexRunInput {
  prompt: string;
  imagePaths: string[];
  extraAddDirs: string[];
}

export interface CodexRunResult {
  success: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  codexThreadId?: string | undefined;
  usedResume: boolean;
  turnCompleted: boolean;
  agentMessages: string[];
  reasoning: string[];
  planItems: PlanItem[];
  stderr: string[];
  commands: CommandRecord[];
}

export interface DashboardConversation {
  conversationId: string;
  bindingChannelId: string;
  codexThreadId?: string | undefined;
  statusMessageId?: string | undefined;
  lastRunAt?: string | undefined;
  lastPromptBy?: string | undefined;
  queueLength: number;
  status: RunStatus | 'idle';
  latestActivity?: string | undefined;
}

export interface DashboardBinding {
  binding: ChannelBinding;
  conversations: DashboardConversation[];
}
