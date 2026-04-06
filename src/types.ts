export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export type ApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';

export type AppServerTransport = 'auto' | 'stdio' | 'ws';

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

export interface AutopilotServiceState {
  guildId: string;
  enabled: boolean;
  parallelism: number;
  updatedAt: string;
}

export type AutopilotBoardStatus = 'ready' | 'doing' | 'blocked' | 'done' | 'deferred';

export interface AutopilotBoardItem {
  id: string;
  title: string;
  status: AutopilotBoardStatus;
  updatedAt: string;
  createdAt?: string | undefined;
  notes?: string | undefined;
}

export interface AutopilotProjectState {
  bindingChannelId: string;
  guildId: string;
  workspacePath?: string | undefined;
  threadChannelId?: string | undefined;
  entryMessageId?: string | undefined;
  enabled: boolean;
  intervalMs: number;
  brief: string;
  briefUpdatedAt: string;
  board: AutopilotBoardItem[];
  status: 'idle' | 'running' | 'paused' | 'waiting';
  lastRunAt?: string | undefined;
  lastResultStatus?: 'success' | 'failed' | 'skipped' | undefined;
  lastGoal?: string | undefined;
  lastSummary?: string | undefined;
  nextSuggestedWork?: string | undefined;
  currentGoal?: string | undefined;
  currentRunStartedAt?: string | undefined;
  lastActivityAt?: string | undefined;
  lastActivityText?: string | undefined;
}

export interface ConversationSessionState {
  conversationId: string;
  bindingChannelId: string;
  codexThreadId?: string | undefined;
  driver?: CodexDriverMode | undefined;
  fallbackActive?: boolean | undefined;
  statusMessageId?: string | undefined;
  transcriptHeaderMessageId?: string | undefined;
  transcriptMessageIds?: string[] | undefined;
  lastTranscriptEventAt?: string | undefined;
  lastRunAt?: string | undefined;
  lastPromptBy?: string | undefined;
  updatedAt: string;
}

export interface PersistedState {
  bindings: Record<string, ChannelBinding>;
  sessions: Record<string, ConversationSessionState>;
  runtimes: Record<string, ChannelRuntime>;
  autopilotServices: Record<string, AutopilotServiceState>;
  autopilotProjects: Record<string, AutopilotProjectState>;
}

export interface AttachmentRef {
  name: string;
  localPath: string;
  workspaceLocalPath?: string | undefined;
  sourceUrl: string;
  isImage: boolean;
  contentType?: string | undefined;
  size?: number | undefined;
}

export interface PromptTask {
  id: string;
  prompt: string;
  effectivePrompt: string;
  rootPrompt: string;
  rootEffectivePrompt: string;
  guidancePrompt?: string | undefined;
  requestedBy: string;
  requestedById: string;
  messageId: string;
  enqueuedAt: string;
  bindingChannelId: string;
  conversationId: string;
  attachments: AttachmentRef[];
  attachmentDir?: string | undefined;
  extraAddDirs: string[];
  origin: 'user' | 'autopilot' | 'local-resume';
  priority?: 'normal' | 'recovery' | undefined;
  recovery?: {
    source: 'retry' | 'restart';
    strategy: 'retry-original' | 'continue-from-state';
    reason: string;
    attempt: number;
    lastKnownCommand?: string | undefined;
  } | undefined;
}

export interface CommandRecord {
  command: string;
  output: string;
  exitCode: number | null;
}

export interface PlanItem {
  id?: string | undefined;
  text: string;
  completed: boolean;
}

export type CollabToolName = 'spawn_agent' | 'send_input' | 'wait' | 'close_agent';
export type CollabToolStatus = 'in_progress' | 'completed' | 'failed';
export type CollabAgentStatus =
  | 'pending_init'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'errored'
  | 'shutdown'
  | 'not_found';

export interface CollabAgentState {
  status: CollabAgentStatus;
  message?: string | null | undefined;
  nickname?: string | null | undefined;
  role?: string | null | undefined;
}

export interface CollabToolCall {
  id: string;
  tool: CollabToolName;
  senderThreadId: string;
  receiverThreadIds: string[];
  prompt?: string | undefined;
  agentsStates: Record<string, CollabAgentState>;
  status: CollabToolStatus;
}

export type RunStatus = 'idle' | 'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';
export type CancellationReason = 'user_cancel' | 'guidance' | 'binding_reset' | 'reset' | 'unbind';

export interface ActiveRunState {
  task: PromptTask;
  driverMode: CodexDriverMode;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  latestActivity: string;
  currentCommand?: string | undefined;
  lastCommandOutput?: string | undefined;
  agentMessages: string[];
  reasoningSummaries: string[];
  planItems: PlanItem[];
  collabToolCalls: CollabToolCall[];
  timeline: string[];
  stderr: string[];
  usedResume: boolean;
  progressMessageId?: string | undefined;
  codexThreadId?: string | undefined;
  cancellationReason?: CancellationReason | undefined;
  exitCode?: number | null | undefined;
  signal?: NodeJS.Signals | null | undefined;
}

export type DeferredSendFile =
  | string
  | {
    attachment: string;
    name?: string | undefined;
  };

export type DeferredSendPayload =
  | string
  | {
    content?: string | undefined;
    files?: DeferredSendFile[] | undefined;
  };

export interface DeferredDiscordReply {
  id: string;
  messageId: string;
  content: DeferredSendPayload;
  createdAt: string;
  retryCount: number;
  lastError?: string | undefined;
  attachmentDir?: string | undefined;
}

export interface ChannelRuntime {
  conversationId: string;
  queue: PromptTask[];
  activeRun?: ActiveRunState | undefined;
  pendingReplies?: DeferredDiscordReply[] | undefined;
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

export type CodexDriverMode = 'legacy-exec' | 'app-server';

export type AppServerPlanStatus = 'pending' | 'in_progress' | 'completed';

export interface AppServerPlanStep {
  step: string;
  status: AppServerPlanStatus;
}

export type AppServerTurnEvent =
  | { type: 'turn.started'; threadId: string; turnId: string }
  | { type: 'turn.completed'; threadId: string; turnId: string }
  | { type: 'turn.failed'; threadId: string; turnId: string; message?: string | undefined }
  | { type: 'turn.interrupted'; threadId: string; turnId: string }
  | { type: 'turn.steered'; threadId: string; turnId: string; prompt: string }
  | { type: 'plan.updated'; threadId: string; turnId: string; plan: AppServerPlanStep[] }
  | { type: 'item.started'; threadId: string; turnId: string; item: Record<string, unknown> }
  | { type: 'item.completed'; threadId: string; turnId: string; item: Record<string, unknown> }
  | { type: 'command.output.delta'; threadId: string; turnId: string; itemId: string; delta: string }
  | { type: 'agent.message.delta'; threadId: string; turnId: string; itemId: string; delta: string }
  | { type: 'reasoning.summary.delta'; threadId: string; turnId: string; itemId: string; delta: string };

export interface AppServerTurnInput {
  prompt: string;
  imagePaths: string[];
  extraAddDirs: string[];
  onEvent?: (event: AppServerTurnEvent) => void | Promise<void>;
}

export interface AppServerTurnResult {
  success: boolean;
  threadId: string;
  turnId: string;
  interrupted: boolean;
}

export interface RunningAppServerTurn {
  turnId: string;
  done: Promise<AppServerTurnResult>;
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

export type TranscriptEventRole = 'user' | 'assistant' | 'system';
export type TranscriptEventSource = 'discord' | 'local-resume' | 'bridge';

export interface TranscriptEvent {
  id: string;
  conversationId: string;
  codexThreadId?: string | undefined;
  role: TranscriptEventRole;
  source: TranscriptEventSource;
  content: string;
  createdAt: string;
}

export interface SessionLookupResult {
  conversationId: string;
  bindingChannelId: string;
  projectName: string;
  workspacePath: string;
  codexThreadId: string;
  driver?: CodexDriverMode | undefined;
  fallbackActive?: boolean | undefined;
  lastRunAt?: string | undefined;
  lastPromptBy?: string | undefined;
  status: RunStatus | 'idle';
  queueLength: number;
  resumeCommand: string;
}

export interface LocalSessionSendResult {
  ok: boolean;
  conversationId: string;
  bindingChannelId: string;
  projectName: string;
  codexThreadId: string;
  assistantMessage?: string | undefined;
  errorMessage?: string | undefined;
}
