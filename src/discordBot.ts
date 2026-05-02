import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  type Message,
  type ThreadAutoArchiveDuration,
} from 'discord.js';

import {
  areAutopilotBoardsEquivalent,
  AUTOPILOT_BOARD_RELATIVE_PATH,
  boardItemsFromReport,
  buildAutopilotFallbackSummary,
  buildAutopilotPrompt,
  DEFAULT_AUTOPILOT_BRIEF,
  diffAutopilotBoards,
  formatAutopilotBoardChanges,
  getAutopilotDefaultIntervalMs,
  getAutopilotBoardCtlPath,
  getAutopilotBoardJsonPath,
  normalizeAutopilotParallelism,
  getAutopilotSkillDir,
  getAutopilotThreadName,
  getAutopilotTickMs,
  normalizeAutopilotBoardDocument,
  parseAutopilotReport,
} from './autopilot.js';
import {
  resolveAutopilotBindingTarget,
  toAutopilotTargetCandidate,
  type AutopilotResolvedTarget,
  type AutopilotTargetCandidate,
  type AutopilotTargetHints,
} from './autopilotControl.js';
import type { AppConfig } from './config.js';
import type { BindCommandOptions, ParsedCommand } from './commandParser.js';
import type { CodexExecutionDriver, CodexRunHooks, RunningCodexJob } from './codexRunner.js';
import type {
  ActiveRunState,
  AutopilotProjectState,
  AutopilotServiceState,
  CancellationReason,
  ChannelRuntime,
  ChannelBinding,
  CollabToolCall,
  CodexDriverMode,
  CodexRunInput,
  CodexRunResult,
  ConversationSessionState,
  DashboardBinding,
  DashboardConversation,
  DeferredDiscordReply,
  DeferredSendPayload,
  GoalSessionState,
  LocalSessionSendResult,
  PromptTask,
  SessionLookupResult,
  TranscriptEvent,
} from './types.js';

import { buildPromptWithAttachments, downloadAttachments, extractMessageAttachments, removeAttachmentDir } from './attachments.js';
import { appendBridgeFileSendInstructions, extractBridgeFileSendDirective } from './bridgeFileSendProtocol.js';
import { diagnoseCodexFailure, filterDiagnosticStderr, isIgnorableCodexStderrLine } from './codexDiagnostics.js';
import { loadCodexGlobalModel, resolveCodexConfigPath, writeCodexGlobalModel } from './codexConfig.js';
import { isCommandMessage, parseCommand } from './commandParser.js';
import {
  detectNaturalLanguageFileRequest,
  formatFileCandidates,
  parseFileSelectionFollowUp,
  resolveFileRequest,
  type FileTransferCandidate,
} from './fileTransfer.js';
import {
  formatAutopilotBriefAck,
  formatAutopilotEntryCard,
  formatAutopilotHelp,
  formatAutopilotKickoff,
  formatAutopilotProjectAck,
  formatAutopilotProjectStatus,
  formatAutopilotRunSummary,
  formatAutopilotServiceAck,
  formatAutopilotServiceStatus,
  formatAutopilotSkipNotice,
  formatAutopilotThreadWelcome,
  formatFailureReply,
  formatHelp,
  formatProgressMessage,
  formatProjects,
  formatQueue,
  formatStatus,
  formatSuccessReply,
  formatTranscriptBody,
  formatTranscriptHeader,
  formatWebAccessLinks,
} from './formatters.js';
import { JsonStateStore } from './store.js';
import { TranscriptStore } from './transcriptStore.js';
import { cloneCodexOptions, formatClockTimestamp, formatDurationMs, isWithinAllowedRoots, normalizeAllowedRoots, resolveDirectoryPath, resolveExistingDirectory, splitIntoDiscordChunks, summarizeReasoningText, truncate, uniqueStrings } from './utils.js';
import { buildWebAccessUrls } from './webAccess.js';

type SendPayload =
  | string
  | {
    content?: string;
    files?: Array<string | { attachment: string; name?: string }>;
  };

type SendableMessage = {
  id: string;
  content: string;
  reply: (content: SendPayload) => Promise<SendableMessage>;
  edit: (content: string) => Promise<SendableMessage>;
  delete?: () => Promise<unknown>;
  pin?: () => Promise<unknown>;
};

type SendableChannel = {
  id: string;
  parentId?: string | null;
  guildId?: string | null;
  attachmentSizeLimit?: number;
  send: (content: SendPayload) => Promise<SendableMessage>;
  sendTyping: () => Promise<void>;
  setArchived?: (archived: boolean) => Promise<unknown>;
  threads?: {
    create: (options: {
      name: string;
      autoArchiveDuration?: ThreadAutoArchiveDuration;
      reason?: string;
    }) => Promise<SendableChannel>;
  };
  messages: {
    fetch: (messageId: string) => Promise<SendableMessage>;
  };
};

class PendingRunningCodexJob implements RunningCodexJob {
  private currentJob: RunningCodexJob | undefined;
  private cancelled = false;
  private readonly pendingDone = new Promise<CodexRunResult>(() => undefined);

  constructor(private readonly preferredDriverMode: CodexDriverMode) {}

  setJob(job: RunningCodexJob): void {
    this.currentJob = job;
    if (this.cancelled) {
      job.cancel();
    }
  }

  clearJob(): void {
    this.currentJob = undefined;
  }

  isAttached(): boolean {
    return this.currentJob !== undefined;
  }

  get pid(): number | undefined {
    return this.currentJob?.pid;
  }

  get driverMode(): CodexDriverMode {
    return this.currentJob?.driverMode ?? this.preferredDriverMode;
  }

  get steer(): ((prompt: string) => Promise<void>) | undefined {
    return this.currentJob?.steer;
  }

  get done(): Promise<CodexRunResult> {
    return this.currentJob?.done ?? this.pendingDone;
  }

  cancel(): void {
    this.cancelled = true;
    this.currentJob?.cancel();
  }
}

interface ResolvedConversation {
  binding: ChannelBinding;
  bindingChannelId: string;
  conversationId: string;
  isThreadConversation: boolean;
  channel: SendableChannel;
}

const MIN_RUNTIME_VIEW_REFRESH_INTERVAL_MS = 300;
const DEFERRED_REPLY_RETRY_DELAY_MS = 3_000;
const AUTOPILOT_THREAD_AUTO_ARCHIVE_MINUTES: ThreadAutoArchiveDuration = 1440;
const AUTOPILOT_REQUESTED_BY = 'Autopilot';
const AUTOPILOT_REQUESTED_BY_ID = 'autopilot';
const FILE_SELECTION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_DISCORD_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DISCORD_WRITE_RETRY_DELAYS_MS = [250, 1_000, 2_500] as const;
const EMPTY_DISCORD_MESSAGE_FALLBACK = '（Codex 返回了空白消息，bridge 已拦截并保留执行结果。）';
const execFileAsync = promisify(execFile);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PendingRuntimeViewRefresh {
  channel: SendableChannel;
  binding: ChannelBinding;
  session: ConversationSessionState;
  runtime: ChannelRuntime;
  isThreadConversation: boolean;
}

interface PendingFileSelection {
  candidates: FileTransferCandidate[];
  expiresAtMs: number;
}

interface PendingLocalSessionTurn {
  resolve: (result: LocalSessionSendResult) => void;
  reject: (error: Error) => void;
}

interface AutopilotControlResult {
  ok: boolean;
  message: string;
  resolvedTarget?: AutopilotResolvedTarget | undefined;
  candidates?: AutopilotTargetCandidate[] | undefined;
  code?: 'target_required' | 'binding_not_found' | 'ambiguous_target' | undefined;
}

function hasBindingExecutionChanged(previous: ChannelBinding | undefined, next: ChannelBinding): boolean {
  if (!previous) {
    return false;
  }

  return previous.projectName !== next.projectName
    || previous.workspacePath !== next.workspacePath
    || JSON.stringify(previous.codex) !== JSON.stringify(next.codex);
}

function buildGuidancePrompt(rootPrompt: string, guidancePrompt: string): string {
  return [
    '系统提示：这是同一 Discord 会话中的一次中途引导。',
    '请先处理下面的最新引导，再继续完成原始任务。',
    '如果最新引导明确要求停止、替换或放弃原始任务，以最新引导为准；否则不要丢掉原始任务。',
    '继续沿用当前会话里已经获得的上下文，不要从头重复已经完成的步骤。',
    '',
    '【原始任务】',
    rootPrompt,
    '',
    '【最新引导】',
    guidancePrompt,
  ].join('\n');
}

function getInterruptedTaskPrompt(task: PromptTask): string {
  if (task.guidancePrompt) {
    return buildGuidancePrompt(task.rootEffectivePrompt, task.guidancePrompt);
  }

  return task.recovery ? task.rootEffectivePrompt : task.effectivePrompt;
}

function buildRecoveryPrompt(activeRun: ActiveRunState, source: 'retry' | 'restart'): string {
  const completedPlanItems = activeRun.planItems
    .filter((item) => item.completed)
    .map((item) => `- ${item.text}`);
  const lines = [
    `系统提示：这是同一 Discord 会话中的一次${source === 'restart' ? '自动恢复' : '自动重试恢复'}。`,
    '上一个执行轮次在 bridge 侧中断或断链，但工作区内容可能已经部分更新。',
    '请先基于当前工作区状态继续任务，不要从头重复已经完成的步骤；如有必要，先快速核对当前仓库状态再继续。',
    '如果下面列出的步骤已经完成，直接从后续步骤继续，并在最终答复里简要说明恢复动作。',
    '',
    '【上次中断时的任务】',
    getInterruptedTaskPrompt(activeRun.task),
  ];

  if (activeRun.latestActivity) {
    lines.push('', `【上次中断前的最新活动】\n${activeRun.latestActivity}`);
  }

  if (activeRun.currentCommand) {
    lines.push('', `【上次中断前的当前命令】\n${activeRun.currentCommand}`);
  }

  if (activeRun.lastCommandOutput?.trim()) {
    lines.push('', `【上次中断前的最近命令输出】\n${truncate(activeRun.lastCommandOutput, 1200)}`);
  }

  if (completedPlanItems.length > 0) {
    lines.push('', '【已完成的计划项】', ...completedPlanItems.slice(0, 8));
  }

  if (activeRun.stderr.length > 0) {
    lines.push('', `【最近诊断信息】\n${truncate(activeRun.stderr.slice(-5).join('\n'), 900)}`);
  }

  return lines.join('\n');
}

function shouldContinueRecoveryFromState(activeRun: ActiveRunState): boolean {
  return Boolean(
    activeRun.currentCommand
      || activeRun.lastCommandOutput?.trim()
      || activeRun.reasoningSummaries.length > 0
      || activeRun.agentMessages.length > 0
      || activeRun.collabToolCalls.length > 0
      || activeRun.planItems.some((item) => item.completed)
      || activeRun.timeline.some((entry) => /✅|❌|计划进度|子代理|执行命令/.test(entry)),
  );
}

function buildRecoveryTask(
  activeRun: ActiveRunState,
  source: 'retry' | 'restart',
  reason: string,
  attempt: number,
): PromptTask {
  const strategy = shouldContinueRecoveryFromState(activeRun) ? 'continue-from-state' : 'retry-original';
  const baseTask = activeRun.task;

  return {
    ...baseTask,
    effectivePrompt: strategy === 'continue-from-state'
      ? buildRecoveryPrompt(activeRun, source)
      : baseTask.effectivePrompt,
    enqueuedAt: new Date().toISOString(),
    priority: 'recovery',
    recovery: {
      source,
      strategy,
      reason,
      attempt,
      lastKnownCommand: activeRun.currentCommand,
    },
  };
}

function shouldAutoRetryFailedRun(
  activeRun: ActiveRunState | undefined,
  result: CodexRunResult,
  cancellationReason: CancellationReason | undefined,
  failureKind: ReturnType<typeof diagnoseCodexFailure>['kind'],
): boolean {
  if (result.success || cancellationReason) {
    return false;
  }

  if (failureKind === 'transient' || failureKind === 'rate-limit' || failureKind === 'stale-session' || failureKind === 'unexpected-empty-exit') {
    return true;
  }

  return Boolean(activeRun && shouldContinueRecoveryFromState(activeRun));
}

function buildRunInputFromTask(task: PromptTask): CodexRunInput {
  return {
    prompt: appendBridgeFileSendInstructions(task.effectivePrompt),
    imagePaths: task.attachments.filter((item) => item.isImage).map((item) => item.localPath),
    extraAddDirs: [
      ...task.extraAddDirs,
      ...(task.attachmentDir ? [task.attachmentDir] : []),
    ],
  };
}

function buildQueuedGuidanceTask(activeTask: PromptTask, queuedTask: PromptTask): PromptTask {
  return {
    ...queuedTask,
    effectivePrompt: buildGuidancePrompt(activeTask.rootEffectivePrompt, queuedTask.effectivePrompt),
    rootPrompt: activeTask.rootPrompt,
    rootEffectivePrompt: activeTask.rootEffectivePrompt,
    guidancePrompt: queuedTask.prompt,
    priority: 'normal',
    recovery: undefined,
  };
}

export interface BindRequest {
  channelId: string;
  guildId?: string | undefined;
  projectName: string;
  workspacePath: string;
  options?: BindCommandOptions | undefined;
}

export class DiscordCodexBridge {
  private readonly client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  private readonly transcriptStore: TranscriptStore;
  private readonly runtimes = new Map<string, ChannelRuntime>();
  private readonly activeJobs = new Map<string, RunningCodexJob>();
  private readonly runtimeViewFlushes = new Map<string, Promise<void>>();
  private readonly pendingRuntimeViewRefreshes = new Map<string, PendingRuntimeViewRefresh>();
  private readonly lastRuntimeViewRefreshAt = new Map<string, number>();
  private readonly pendingRuntimeStateSaves = new Map<string, NodeJS.Timeout>();
  private readonly pendingDeferredReplyFlushes = new Map<string, NodeJS.Timeout>();
  private readonly activeAutopilotProjects = new Set<string>();
  private readonly autopilotBoardSnapshots = new Map<string, AutopilotProjectState['board']>();
  private readonly pendingFileSelections = new Map<string, PendingFileSelection>();
  private readonly pendingLocalSessionTurns = new Map<string, PendingLocalSessionTurn>();
  private autopilotTicker: NodeJS.Timeout | undefined;
  private autopilotTickInFlight = false;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStateStore,
    private readonly runner: CodexExecutionDriver,
  ) {
    this.transcriptStore = new TranscriptStore(this.config.dataDir);
    this.client.once('clientReady', () => {
      console.log(`Discord bot connected as ${this.client.user?.tag ?? 'unknown-user'}`);
    });

    this.client.on('messageCreate', (message) => {
      void this.handleIncomingMessage(message);
    });

    this.client.on('error', (error) => {
      this.logBridgeError('discord-client', error);
    });

    this.client.on('warn', (warning) => {
      console.warn(`[discord-client] ${warning}`);
    });
  }

  async start(): Promise<void> {
    await this.client.login(this.config.discordToken);
    await this.reconcileAutopilotResources();
    await this.recoverPersistedRuntimes();
    this.startAutopilotTicker();
  }

  async stop(): Promise<void> {
    if (this.autopilotTicker) {
      clearInterval(this.autopilotTicker);
      this.autopilotTicker = undefined;
    }

    for (const timer of this.pendingRuntimeStateSaves.values()) {
      clearTimeout(timer);
    }
    this.pendingRuntimeStateSaves.clear();

    for (const timer of this.pendingDeferredReplyFlushes.values()) {
      clearTimeout(timer);
    }
    this.pendingDeferredReplyFlushes.clear();

    await this.store.drain();
    await this.runner.stop?.();
    await this.client.destroy();
  }

  listBindings(guildId?: string): ChannelBinding[] {
    return this.store.listBindings(guildId);
  }

  async bindChannel(request: BindRequest): Promise<ChannelBinding> {
    const resolvedGuildId = request.guildId ?? (await this.fetchChannel(request.channelId))?.guildId ?? undefined;
    const allowedRoots = await normalizeAllowedRoots(this.config.allowedWorkspaceRoots);
    const targetWorkspace = await resolveDirectoryPath(request.workspacePath);

    if (!resolvedGuildId) {
      throw new Error(`无法解析频道 ${request.channelId} 对应的 guildId，请确认机器人已加入该服务器并能访问此频道。`);
    }

    if (!isWithinAllowedRoots(targetWorkspace, allowedRoots)) {
      throw new Error(`该目录不在允许的根目录下：${targetWorkspace}`);
    }

    await fs.mkdir(targetWorkspace, { recursive: true });
    const resolvedWorkspace = await resolveExistingDirectory(targetWorkspace);
    const options = request.options ?? { addDirs: [], extraConfig: [] };
    const addDirs = await Promise.all(options.addDirs.map(async (item) => resolveExistingDirectory(item)));

    for (const addDir of addDirs) {
      if (!isWithinAllowedRoots(addDir, allowedRoots)) {
        throw new Error(`附加可写目录不在允许范围内：${addDir}`);
      }
    }

    const existingBinding = this.store.getBinding(request.channelId);
    const codexOptions = cloneCodexOptions(this.config.defaultCodex);
    let modelScope: ChannelBinding['modelScope'];

    if (options.model) {
      codexOptions.model = options.model;
      modelScope = 'project';
    } else if (codexOptions.model) {
      modelScope = 'global';
    }

    if (options.profile) {
      codexOptions.profile = options.profile;
    }

    if (options.sandboxMode) {
      codexOptions.sandboxMode = options.sandboxMode;
    }

    if (options.approvalPolicy) {
      codexOptions.approvalPolicy = options.approvalPolicy;
    }

    if (options.search !== undefined) {
      codexOptions.search = options.search;
    }

    if (options.skipGitRepoCheck !== undefined) {
      codexOptions.skipGitRepoCheck = options.skipGitRepoCheck;
    }

    if (options.addDirs.length > 0) {
      codexOptions.addDirs = addDirs;
    }

    if (options.extraConfig.length > 0) {
      codexOptions.extraConfig = [...codexOptions.extraConfig, ...options.extraConfig];
    }

    const now = new Date().toISOString();
    const binding: ChannelBinding = {
      channelId: request.channelId,
      guildId: resolvedGuildId,
      projectName: request.projectName,
      workspacePath: resolvedWorkspace,
      codex: codexOptions,
      modelScope,
      createdAt: existingBinding?.createdAt ?? now,
      updatedAt: now,
    };

    const executionChanged = hasBindingExecutionChanged(existingBinding, binding);
    const savedBinding = await this.store.upsertBinding(binding);

    if (executionChanged) {
      await this.resetBindingSessions(savedBinding.channelId);
    }

    const session = await this.store.ensureSession(savedBinding.channelId, savedBinding.channelId);
    const runtime = this.getRuntime(savedBinding.channelId);
    const channel = await this.fetchChannel(savedBinding.channelId);

    if (channel) {
      await this.refreshRuntimeViews(channel, savedBinding, session, runtime, false);
    }

    await this.ensureAutopilotResources(savedBinding);
    return savedBinding;
  }

  async unbindChannel(bindingChannelId: string): Promise<ChannelBinding | undefined> {
    const sessions = this.store.listSessions(bindingChannelId);
    const autopilotProject = this.store.getAutopilotProject(bindingChannelId);

    for (const session of sessions) {
      const activeJob = this.activeJobs.get(session.conversationId);
      const runtime = this.runtimes.get(session.conversationId);
      if (runtime) {
        if (runtime.activeRun) {
          runtime.activeRun.cancellationReason = 'unbind';
        }
        runtime.activeRun = undefined;
        runtime.queue = [];
      }
      activeJob?.cancel();
      this.activeJobs.delete(session.conversationId);
      this.runtimes.delete(session.conversationId);
      await this.store.removeRuntimeState(session.conversationId);
    }

    if (autopilotProject?.status === 'running') {
      this.activeAutopilotProjects.delete(bindingChannelId);
    }

    return this.store.removeBinding(bindingChannelId);
  }

  async resetConversation(conversationId: string, bindingChannelId?: string): Promise<ConversationSessionState> {
    return this.store.updateSession(conversationId, {
      codexThreadId: undefined,
      driver: undefined,
      fallbackActive: undefined,
    }, bindingChannelId);
  }

  async executeAutopilotControlCommand(
    command: Exclude<Extract<ParsedCommand, { kind: 'autopilot' }>, { scope: 'help' }>,
    targetHints: AutopilotTargetHints = {},
  ): Promise<AutopilotControlResult> {
    if (command.scope === 'server') {
      return {
        ok: true,
        message: await this.executeAutopilotServerCommand(command),
      };
    }

    const resolution = resolveAutopilotBindingTarget(this.store.listBindings(), targetHints);
    if (!resolution.ok) {
      return {
        ok: false,
        code: resolution.code,
        message: resolution.message,
        candidates: resolution.candidates,
      };
    }

    return {
      ok: true,
      message: await this.executeAutopilotProjectCommand(resolution.binding, command),
      resolvedTarget: {
        ...toAutopilotTargetCandidate(resolution.binding),
        mode: resolution.mode,
      },
    };
  }

  private async resetBindingSessions(bindingChannelId: string): Promise<void> {
    const sessions = this.store.listSessions(bindingChannelId);

    for (const session of sessions) {
      const activeJob = this.activeJobs.get(session.conversationId);
      const runtime = this.runtimes.get(session.conversationId);
      if (runtime) {
        if (runtime.activeRun) {
          runtime.activeRun.cancellationReason = 'binding_reset';
        }
        runtime.activeRun = undefined;
        runtime.queue = [];
      }
      activeJob?.cancel();
      this.activeJobs.delete(session.conversationId);
      this.runtimes.delete(session.conversationId);
      await this.store.removeRuntimeState(session.conversationId);

      await this.store.updateSession(session.conversationId, {
        codexThreadId: undefined,
        driver: undefined,
        fallbackActive: undefined,
        lastRunAt: undefined,
        lastPromptBy: undefined,
      }, bindingChannelId);
    }

    this.runtimes.delete(bindingChannelId);
  }

  getDashboardData(): DashboardBinding[] {
    return this.store.listBindings().map((binding) => {
      const conversations = this.store.listSessions(binding.channelId).map((session) => this.buildDashboardConversation(session));
      return { binding, conversations };
    });
  }

  getSessionByCodexThreadId(codexThreadId: string): SessionLookupResult | undefined {
    const normalizedThreadId = codexThreadId.trim();
    if (!normalizedThreadId) {
      return undefined;
    }

    const session = this.store.listSessions().find((candidate) => candidate.codexThreadId === normalizedThreadId);
    if (!session) {
      return undefined;
    }

    const binding = this.store.getBinding(session.bindingChannelId);
    if (!binding) {
      return undefined;
    }

    const runtime = this.getRuntime(session.conversationId);
    return {
      conversationId: session.conversationId,
      bindingChannelId: session.bindingChannelId,
      projectName: binding.projectName,
      workspacePath: binding.workspacePath,
      codexThreadId: normalizedThreadId,
      driver: session.driver,
      fallbackActive: session.fallbackActive,
      lastRunAt: session.lastRunAt,
      lastPromptBy: session.lastPromptBy,
      status: runtime.activeRun?.status ?? 'idle',
      queueLength: runtime.queue.length,
      resumeCommand: `bridgectl session resume ${normalizedThreadId}`,
    };
  }

  async sendLocalSessionMessage(codexThreadId: string, prompt: string): Promise<LocalSessionSendResult> {
    const normalizedThreadId = codexThreadId.trim();
    const normalizedPrompt = prompt.trim();

    if (!normalizedThreadId) {
      throw new Error('codexThreadId 不能为空。');
    }

    if (!normalizedPrompt) {
      throw new Error('prompt 不能为空。');
    }

    const resolved = this.getSessionByCodexThreadId(normalizedThreadId);
    if (!resolved) {
      throw new Error(`找不到 Resume ID 对应的会话：${normalizedThreadId}`);
    }

    const binding = this.store.getBinding(resolved.bindingChannelId);
    if (!binding) {
      throw new Error(`找不到会话对应的项目绑定：${resolved.bindingChannelId}`);
    }

    const channel = await this.fetchChannel(resolved.conversationId);
    if (!channel) {
      throw new Error(`找不到 Resume ID 对应的 Discord 会话频道：${resolved.conversationId}`);
    }

    const runtime = this.getRuntime(resolved.conversationId);
    const taskId = randomUUID();
    const task: PromptTask = {
      id: taskId,
      prompt: normalizedPrompt,
      effectivePrompt: normalizedPrompt,
      rootPrompt: normalizedPrompt,
      rootEffectivePrompt: normalizedPrompt,
      requestedBy: 'bridgectl',
      requestedById: 'local-resume',
      messageId: `local-${taskId}`,
      enqueuedAt: new Date().toISOString(),
      bindingChannelId: resolved.bindingChannelId,
      conversationId: resolved.conversationId,
      attachments: [],
      attachmentDir: undefined,
      extraAddDirs: [],
      origin: 'local-resume',
      priority: 'normal',
    };

    const pendingResult = new Promise<LocalSessionSendResult>((resolve, reject) => {
      this.pendingLocalSessionTurns.set(taskId, { resolve, reject });
    });

    runtime.queue.push(task);
    this.scheduleRuntimeStateSave(resolved.conversationId, true);
    const session = await this.store.ensureSession(resolved.bindingChannelId, resolved.conversationId);
    await this.safeRefreshStatusPanel(channel, binding, session, runtime, resolved.conversationId !== resolved.bindingChannelId);
    this.startProcessQueue(resolved.conversationId);
    return pendingResult;
  }

  private buildDashboardConversation(session: ConversationSessionState): DashboardConversation {
    const runtime = this.getRuntime(session.conversationId);
    return {
      conversationId: session.conversationId,
      bindingChannelId: session.bindingChannelId,
      codexThreadId: session.codexThreadId,
      statusMessageId: session.statusMessageId,
      lastRunAt: session.lastRunAt,
      lastPromptBy: session.lastPromptBy,
      queueLength: runtime.queue.length,
      status: runtime.activeRun?.status ?? 'idle',
      latestActivity: runtime.activeRun?.latestActivity,
    };
  }

  private getRuntime(conversationId: string): ChannelRuntime {
    let runtime = this.runtimes.get(conversationId);

    if (!runtime) {
      runtime = this.store.getRuntimeState(conversationId) ?? {
        conversationId,
        queue: [],
        pendingReplies: [],
        goal: this.store.getGoal(conversationId),
      };
      runtime.pendingReplies ??= [];
      runtime.goal ??= this.store.getGoal(conversationId);
      this.runtimes.set(conversationId, runtime);
    }

    this.recoverDetachedActiveRun(conversationId, runtime);
    return runtime;
  }

  private recoverDetachedActiveRun(conversationId: string, runtime: ChannelRuntime): void {
    const activeRun = runtime.activeRun;
    if (!activeRun || this.activeJobs.has(conversationId)) {
      return;
    }

    const taskId = activeRun.task.id.slice(0, 8);

    if (this.isRecoverableActiveRun(activeRun)) {
      runtime.queue.unshift(buildRecoveryTask(
        activeRun,
        'restart',
        'bridge 检测到运行状态残留，正在恢复中断任务',
        (activeRun.task.recovery?.attempt ?? 0) + 1,
      ));
      console.warn(
        `[bridge-runtime] recovered detached active run conversation=${conversationId} task=${taskId}`,
      );
    } else {
      console.warn(
        `[bridge-runtime] cleared detached finished run conversation=${conversationId} task=${taskId}`,
      );
    }

    runtime.activeRun = undefined;
    this.scheduleRuntimeStateSave(conversationId, true);
  }

  private scheduleRuntimeStateSave(conversationId: string, immediate = false): void {
    const existingTimer = this.pendingRuntimeStateSaves.get(conversationId);

    if (existingTimer) {
      clearTimeout(existingTimer);
      this.pendingRuntimeStateSaves.delete(conversationId);
    }

    if (immediate) {
      void this.persistRuntimeState(conversationId).catch((error) => {
        this.logBridgeError(`persistRuntimeState conversation=${conversationId}`, error);
      });
      return;
    }

    const timer = setTimeout(() => {
      this.pendingRuntimeStateSaves.delete(conversationId);
      void this.persistRuntimeState(conversationId).catch((error) => {
        this.logBridgeError(`persistRuntimeState conversation=${conversationId}`, error);
      });
    }, 50);
    timer.unref?.();
    this.pendingRuntimeStateSaves.set(conversationId, timer);
  }

  private async persistRuntimeState(conversationId: string): Promise<void> {
    const runtime = this.runtimes.get(conversationId);

    if (!runtime || (!runtime.activeRun && runtime.queue.length === 0 && (runtime.pendingReplies?.length ?? 0) === 0 && !runtime.goal)) {
      await this.store.removeRuntimeState(conversationId);
      return;
    }

    await this.store.upsertRuntimeState(structuredClone(runtime));
  }

  private isRecoverableActiveRun(activeRun: ActiveRunState | undefined): activeRun is ActiveRunState {
    return Boolean(
      activeRun
      && activeRun.status !== 'completed'
      && activeRun.status !== 'failed'
      && activeRun.status !== 'cancelled'
      && !activeRun.cancellationReason,
    );
  }

  private describeRecoveryTask(task: PromptTask): string {
    if (!task.recovery) {
      return '准备重新执行原始提示';
    }

    return task.recovery.strategy === 'continue-from-state'
      ? '继续基于当前工作区状态自动恢复，不重复已完成步骤'
      : '重新执行原始提示并沿用已有会话上下文';
  }

  private async announceRecoveryStart(channel: SendableChannel, task: PromptTask): Promise<void> {
    if (!task.recovery) {
      return;
    }

    const phase = task.recovery.source === 'restart'
      ? '检测到上次任务中断，bridge 正在自动恢复。'
      : '检测到当前任务中断，bridge 正在自动恢复。';
    await this.sendDriverStatusNotice(
      channel,
      `${phase}\n接下来：${this.describeRecoveryTask(task)}\n恢复原因：${truncate(task.recovery.reason, 240)}`,
    );
  }

  private async recoverPersistedRuntimes(): Promise<void> {
    for (const persisted of this.store.listRuntimeStates()) {
      const runtime: ChannelRuntime = structuredClone(persisted);
      runtime.pendingReplies ??= [];
      const conversationId = runtime.conversationId;
      const bindingChannelId = runtime.activeRun?.task.bindingChannelId
        ?? runtime.queue.at(0)?.bindingChannelId
        ?? this.store.getSession(conversationId)?.bindingChannelId;

      if (!bindingChannelId) {
        await this.store.removeRuntimeState(conversationId);
        this.runtimes.delete(conversationId);
        continue;
      }

      const binding = this.store.getBinding(bindingChannelId);
      if (!binding) {
        await this.store.removeRuntimeState(conversationId);
        this.runtimes.delete(conversationId);
        continue;
      }

      const channel = await this.fetchChannel(conversationId);
      if (!channel) {
        this.runtimes.set(conversationId, runtime);
        continue;
      }

      const interruptedRun = this.isRecoverableActiveRun(runtime.activeRun) ? runtime.activeRun : undefined;
      if (interruptedRun) {
        const recoveryTask = buildRecoveryTask(
          interruptedRun,
          'restart',
          'bridge 重启或断链后恢复中断任务',
          (interruptedRun.task.recovery?.attempt ?? 0) + 1,
        );
        runtime.queue.unshift(recoveryTask);
      }

      runtime.activeRun = undefined;
      this.runtimes.set(conversationId, runtime);
      await this.persistRuntimeState(conversationId);

      if (interruptedRun) {
        await this.announceRecoveryStart(channel, runtime.queue[0]!);
      }

      const session = await this.store.ensureSession(binding.channelId, conversationId);
      await this.refreshRuntimeViews(channel, binding, session, runtime, conversationId !== binding.channelId);
      this.scheduleDeferredReplyFlush(conversationId, 0);

      if (runtime.queue.length > 0) {
        this.startProcessQueue(conversationId);
      }
    }
  }

  private async handleIncomingMessage(message: Message): Promise<void> {
    try {
      await this.handleMessage(message);
    } catch (error) {
      this.logBridgeError(`messageCreate channel=${message.channelId}`, error);
      await this.safeMessageReply(message, `Bridge 内部错误：${this.formatErrorMessage(error)}`);
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot || !message.guild || !isSendableChannel(message.channel)) {
      return;
    }

    if (isCommandMessage(message.content, this.config.commandPrefix)) {
      try {
        const command = parseCommand(message.content, this.config.commandPrefix);
        await this.handleCommand(message, command);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        await this.safeMessageReply(message, text);
      }
      return;
    }

    const autopilotProject = this.getAutopilotProjectByThreadChannelId(message.channelId);
    if (autopilotProject) {
      await this.handleAutopilotThreadMessage(message, autopilotProject);
      return;
    }

    const resolved = this.resolveConversationForMessage(message);

    if (!resolved) {
      return;
    }

    this.scheduleDeferredReplyFlush(resolved.conversationId, 0);

    const prompt = message.content.trim();
    const attachments = extractMessageAttachments(message);

    if (!prompt && attachments.length === 0) {
      return;
    }

    if (prompt && attachments.length === 0) {
      const handled = await this.handleFileTransferMessage(message, resolved, prompt);
      if (handled) {
        return;
      }
    }

    await this.enqueuePrompt(message, resolved, prompt || '请分析我附带的附件内容。');
  }

  private async handleFileTransferMessage(
    message: Message,
    resolved: ResolvedConversation,
    prompt: string,
  ): Promise<boolean> {
    const selectionIndex = parseFileSelectionFollowUp(prompt);
    if (selectionIndex) {
      if (!this.getPendingFileSelection(resolved.conversationId)) {
        return false;
      }
      await this.handleSendFileSelection(message, resolved, selectionIndex);
      return true;
    }

    const request = detectNaturalLanguageFileRequest(prompt);
    if (!request) {
      return false;
    }

    await this.handleSendFileRequest(message, resolved, request);
    return true;
  }

  private getPendingFileSelection(conversationId: string): PendingFileSelection | undefined {
    const pending = this.pendingFileSelections.get(conversationId);

    if (!pending) {
      return undefined;
    }

    if (pending.expiresAtMs <= Date.now()) {
      this.pendingFileSelections.delete(conversationId);
      return undefined;
    }

    return pending;
  }

  private async sendResolvedFile(
    message: Message,
    file: FileTransferCandidate,
    content = `已发送文件：${file.name}`,
  ): Promise<void> {
    const validationError = await this.getResolvedFileSendError(
      file,
      message.channel as { attachmentSizeLimit?: number } | null,
    );
    if (validationError) {
      await this.replyWithRetry(message, validationError);
      return;
    }

    await this.replyWithRetry(message, {
      content,
      files: [{ attachment: file.absolutePath, name: file.name }],
    });
  }

  private getDiscordAttachmentSizeLimit(channel?: { attachmentSizeLimit?: number } | null): number {
    const limit = channel?.attachmentSizeLimit;
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
      return limit;
    }
    return DEFAULT_DISCORD_ATTACHMENT_BYTES;
  }

  private formatAttachmentSizeLimit(limitBytes: number): string {
    const limitMiB = limitBytes / (1024 * 1024);
    if (Number.isInteger(limitMiB)) {
      return `${limitMiB.toFixed(0)} MiB`;
    }
    return `${limitMiB.toFixed(1)} MiB`;
  }

  private async getResolvedFileSendError(
    file: FileTransferCandidate,
    channel?: { attachmentSizeLimit?: number } | null,
  ): Promise<string | undefined> {
    const stat = await fs.stat(file.absolutePath).catch(() => null);

    if (!stat || !stat.isFile()) {
      return `文件不存在或已不可读：${file.absolutePath}`;
    }

    const attachmentSizeLimit = this.getDiscordAttachmentSizeLimit(channel);
    if (stat.size > attachmentSizeLimit) {
      return `文件过大，当前频道最多支持发送 ${this.formatAttachmentSizeLimit(attachmentSizeLimit)} 的文件。`;
    }

    return undefined;
  }

  private async handleSendFileRequest(
    message: Message,
    resolved: ResolvedConversation,
    request: string,
  ): Promise<void> {
    const result = await resolveFileRequest({
      workspacePath: resolved.binding.workspacePath,
      request,
      allowAbsolutePath: this.isAdmin(message),
    });

    switch (result.kind) {
      case 'single':
        this.pendingFileSelections.delete(resolved.conversationId);
        await this.sendResolvedFile(message, result.file);
        return;
      case 'candidates':
        this.pendingFileSelections.set(resolved.conversationId, {
          candidates: result.candidates,
          expiresAtMs: Date.now() + FILE_SELECTION_TTL_MS,
        });
        await this.replyWithRetry(message, formatFileCandidates(result.candidates, { commandPrefix: this.config.commandPrefix }));
        return;
      case 'denied':
      case 'missing':
        this.pendingFileSelections.delete(resolved.conversationId);
        await this.replyWithRetry(message, result.message);
        return;
    }
  }

  private async handleSendFileSelection(
    message: Message,
    resolved: ResolvedConversation,
    index: number,
  ): Promise<void> {
    const pending = this.getPendingFileSelection(resolved.conversationId);

    if (!pending) {
      await this.replyWithRetry(message, '当前没有待选择的文件候选列表。先发送自然语言请求，或使用 `!sendfile <文件名>`。');
      return;
    }

    const selected = pending.candidates[index - 1];
    if (!selected) {
      await this.replyWithRetry(message, `当前候选只有 ${pending.candidates.length} 个，请回复有效序号。`);
      return;
    }

    this.pendingFileSelections.delete(resolved.conversationId);
    await this.sendResolvedFile(message, selected, `已发送第 ${index} 个文件：${selected.name}`);
  }

  private async buildSuccessReplyPayload(
    channel: SendableChannel,
    binding: ChannelBinding,
    task: PromptTask,
    result: CodexRunResult,
  ): Promise<SendPayload> {
    const finalMessage = result.agentMessages.at(-1) ?? '';
    const directive = extractBridgeFileSendDirective(finalMessage);
    const visibleMessage = directive.cleanText || directive.caption || undefined;
    const baseContent = visibleMessage
      ? formatSuccessReply(binding, task.requestedBy, result, { finalMessage: visibleMessage })
      : formatSuccessReply(binding, task.requestedBy, result);

    if (!directive.request) {
      if (!directive.error) {
        return baseContent;
      }

      return `${baseContent}\n\nBridge 文件发送请求无效：${directive.error}`;
    }

    const resolution = await resolveFileRequest({
      workspacePath: binding.workspacePath,
      request: directive.request,
      allowAbsolutePath: false,
    });

    switch (resolution.kind) {
      case 'single': {
        const validationError = await this.getResolvedFileSendError(resolution.file, channel);
        if (validationError) {
          return `${baseContent}\n\n${validationError}`;
        }

        return {
          content: baseContent,
          files: [{ attachment: resolution.file.absolutePath, name: resolution.file.name }],
        };
      }
      case 'candidates':
        this.pendingFileSelections.set(task.conversationId, {
          candidates: resolution.candidates,
          expiresAtMs: Date.now() + FILE_SELECTION_TTL_MS,
        });
        return `${baseContent}\n\n${formatFileCandidates(resolution.candidates, { commandPrefix: this.config.commandPrefix })}`;
      case 'denied':
      case 'missing':
        return `${baseContent}\n\n${resolution.message}`;
    }
  }

  private getVisibleAssistantMessage(result: CodexRunResult): string {
    const finalMessage = result.agentMessages.at(-1) ?? '';
    const directive = extractBridgeFileSendDirective(finalMessage);
    return directive.cleanText.trim()
      || directive.caption?.trim()
      || finalMessage.trim()
      || '本轮已完成，但 Codex 没有返回文本消息。';
  }

  private getTranscriptSourceForTask(task: PromptTask): TranscriptEvent['source'] {
    if (task.origin === 'local-resume') {
      return 'local-resume';
    }

    if (task.origin === 'autopilot' || task.origin === 'goal') {
      return 'bridge';
    }

    return 'discord';
  }

  private async recordTranscriptForCompletedTask(
    channel: SendableChannel,
    binding: ChannelBinding,
    session: ConversationSessionState,
    task: PromptTask,
    result: CodexRunResult,
  ): Promise<ConversationSessionState> {
    if (task.origin === 'autopilot') {
      return session;
    }

    const codexThreadId = result.codexThreadId ?? session.codexThreadId;
    const source = this.getTranscriptSourceForTask(task);
    const prompt = task.prompt.trim();

    if (prompt) {
      await this.transcriptStore.appendEvent(task.conversationId, {
        codexThreadId,
        role: 'user',
        source,
        content: prompt,
      });
    }

    if (result.success) {
      await this.transcriptStore.appendEvent(task.conversationId, {
        codexThreadId,
        role: 'assistant',
        source,
        content: this.getVisibleAssistantMessage(result),
      });
    } else {
      const errorMessage = filterDiagnosticStderr(result.stderr).slice(-3).join('\n').trim()
        || `执行失败，exitCode=${result.exitCode ?? 'null'} signal=${result.signal ?? 'null'}`;
      await this.transcriptStore.appendEvent(task.conversationId, {
        codexThreadId,
        role: 'system',
        source: 'bridge',
        content: errorMessage,
      });
    }

    return this.syncTranscriptMessages(channel, binding, session);
  }

  private async syncTranscriptMessages(
    channel: SendableChannel,
    binding: ChannelBinding,
    session: ConversationSessionState,
  ): Promise<ConversationSessionState> {
    const events = await this.transcriptStore.listEvents(session.conversationId);
    const mirroredEvents = events.filter((event) => event.source !== 'discord');
    let nextSession = session;

    if (mirroredEvents.length === 0) {
      await this.deleteTranscriptMessages(channel, session);
      if (
        !session.transcriptHeaderMessageId
        && (session.transcriptMessageIds?.length ?? 0) === 0
        && !session.lastTranscriptEventAt
      ) {
        return session;
      }

      return this.store.updateSession(session.conversationId, {
        transcriptHeaderMessageId: undefined,
        transcriptMessageIds: [],
        lastTranscriptEventAt: undefined,
      }, session.bindingChannelId);
    }

    const headerContent = formatTranscriptHeader(binding, session, mirroredEvents.length);
    const bodyChunks = splitIntoDiscordChunks(formatTranscriptBody(mirroredEvents), 1800);
    const nextMessageIds: string[] = [];

    const header = await this.upsertTranscriptMessage(channel, session.transcriptHeaderMessageId, headerContent);
    if (header.id !== session.transcriptHeaderMessageId) {
      nextSession = await this.store.updateSession(session.conversationId, {
        transcriptHeaderMessageId: header.id,
      }, session.bindingChannelId);
    }

    const existingBodyMessageIds = nextSession.transcriptMessageIds ?? [];
    for (let index = 0; index < bodyChunks.length; index += 1) {
      const message = await this.upsertTranscriptMessage(channel, existingBodyMessageIds[index], bodyChunks[index]!);
      nextMessageIds.push(message.id);
    }

    for (const staleMessageId of existingBodyMessageIds.slice(bodyChunks.length)) {
      await this.deleteTranscriptMessage(channel, staleMessageId);
    }

    nextSession = await this.store.updateSession(session.conversationId, {
      transcriptMessageIds: nextMessageIds,
      lastTranscriptEventAt: mirroredEvents.at(-1)?.createdAt,
    }, session.bindingChannelId);
    return nextSession;
  }

  private async deleteTranscriptMessages(
    channel: SendableChannel,
    session: ConversationSessionState,
  ): Promise<void> {
    const messageIds = [
      session.transcriptHeaderMessageId,
      ...(session.transcriptMessageIds ?? []),
    ].filter((messageId): messageId is string => Boolean(messageId));

    for (const messageId of messageIds) {
      await this.deleteTranscriptMessage(channel, messageId);
    }
  }

  private async deleteTranscriptMessage(channel: SendableChannel, messageId: string): Promise<void> {
    const existing = await this.fetchChannelMessageWithRetry(channel, messageId);
    if (!existing || typeof existing.delete !== 'function') {
      return;
    }

    await this.deleteWithRetry(existing);
  }

  private async upsertTranscriptMessage(
    channel: SendableChannel,
    messageId: string | undefined,
    content: string,
  ): Promise<SendableMessage> {
    const existing = messageId ? await this.fetchChannelMessageWithRetry(channel, messageId) : undefined;

    if (!existing) {
      return this.sendWithRetry(channel, content);
    }

    if (existing.content !== content) {
      await this.editWithRetry(existing, content);
    }

    return existing;
  }

  private settleLocalSessionTurn(
    taskId: string,
    result: LocalSessionSendResult | Error,
  ): void {
    const pending = this.pendingLocalSessionTurns.get(taskId);
    if (!pending) {
      return;
    }

    this.pendingLocalSessionTurns.delete(taskId);
    if (result instanceof Error) {
      pending.reject(result);
      return;
    }

    pending.resolve(result);
  }

  private describeDiscordError(error: unknown): string {
    const parts: string[] = [];
    const seen = new Set<unknown>();

    const visit = (value: unknown, depth = 0): void => {
      if (value == null || depth > 3 || seen.has(value)) {
        return;
      }

      seen.add(value);

      if (value instanceof Error) {
        if (value.message) {
          parts.push(value.message);
        }
        const code = (value as NodeJS.ErrnoException).code;
        if (typeof code === 'string') {
          parts.push(code);
        }
        visit((value as Error & { cause?: unknown }).cause, depth + 1);
        return;
      }

      if (typeof value === 'object') {
        const candidate = value as { message?: unknown; code?: unknown; cause?: unknown };
        if (typeof candidate.message === 'string') {
          parts.push(candidate.message);
        }
        if (typeof candidate.code === 'string') {
          parts.push(candidate.code);
        }
        visit(candidate.cause, depth + 1);
        return;
      }

      if (typeof value === 'string') {
        parts.push(value);
      }
    };

    visit(error);
    return uniqueStrings(parts.map((item) => item.trim()).filter(Boolean)).join(' | ') || String(error);
  }

  private isRetryableDiscordWriteError(error: unknown): boolean {
    return /(ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|ABORT_ERR|AbortError|This operation was aborted|UND_ERR|timeout|other side closed|socket hang up|Client network socket disconnected|secure TLS connection was established|fetch failed)/i
      .test(this.describeDiscordError(error));
  }

  private isMissingDiscordMessageError(error: unknown): boolean {
    return /(Unknown Message|10008|Message .* not found|\bnot found\b)/i.test(this.describeDiscordError(error));
  }

  private async waitForDiscordRetry(delayMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  private async withDiscordWriteRetry<T>(label: string, operation: () => Promise<T>): Promise<T> {
    const maxAttempts = DISCORD_WRITE_RETRY_DELAYS_MS.length + 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        if (!this.isRetryableDiscordWriteError(error) || attempt >= maxAttempts) {
          throw error;
        }

        const delayMs = DISCORD_WRITE_RETRY_DELAYS_MS[attempt - 1] ?? DISCORD_WRITE_RETRY_DELAYS_MS.at(-1) ?? 250;
        console.warn(
          `[discord-view] transient ${label} failure attempt=${attempt}/${maxAttempts} error=${this.describeDiscordError(error)}; retrying in ${delayMs}ms`,
        );
        await this.waitForDiscordRetry(delayMs);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
  }

  private async replyWithRetry(
    message: { id: string; reply: (content: SendPayload) => Promise<unknown> },
    content: SendPayload,
  ): Promise<SendableMessage> {
    const result = await this.withDiscordWriteRetry(`reply message=${message.id}`, async () => message.reply(content));
    return result as SendableMessage;
  }

  private async sendWithRetry(channel: SendableChannel, content: SendPayload): Promise<SendableMessage> {
    const result = await this.withDiscordWriteRetry(`send channel=${channel.id}`, async () => channel.send(content));
    return result as SendableMessage;
  }

  private async editWithRetry(message: SendableMessage, content: string): Promise<SendableMessage> {
    const result = await this.withDiscordWriteRetry(`edit message=${message.id}`, async () => message.edit(content));
    return result as SendableMessage;
  }

  private async deleteWithRetry(message: SendableMessage): Promise<void> {
    await this.withDiscordWriteRetry(`delete message=${message.id}`, async () => {
      await message.delete?.();
      return message;
    });
  }

  private async fetchChannelMessageWithRetry(channel: SendableChannel, messageId: string): Promise<SendableMessage | null> {
    try {
      const result = await this.withDiscordWriteRetry(`fetch message=${messageId}`, async () => channel.messages.fetch(messageId));
      return result as SendableMessage;
    } catch (error) {
      if (this.isMissingDiscordMessageError(error)) {
        return null;
      }
      throw error;
    }
  }

  private normalizeDiscordTextChunks(content: string): string[] {
    const chunks = splitIntoDiscordChunks(content, 1800).filter((chunk) => chunk.trim().length > 0);
    return chunks.length > 0 ? chunks : [EMPTY_DISCORD_MESSAGE_FALLBACK];
  }

  private async safeMessageReply(message: Message, content: string): Promise<void> {
    await this.replyWithRetry(message, content).catch((error) => {
      this.logBridgeError(`reply message=${message.id}`, error);
    });
  }

  private async replyWithChunks(message: Message, content: string): Promise<void> {
    const chunks = this.normalizeDiscordTextChunks(content);
    const [firstChunk, ...remainingChunks] = chunks;

    if (firstChunk) {
      await this.replyWithRetry(message, firstChunk);
    }

    for (const chunk of remainingChunks) {
      await this.sendWithRetry(message.channel as SendableChannel, chunk);
    }
  }

  private async sendDriverStatusNotice(channel: SendableChannel, text: string): Promise<void> {
    await this.sendWithRetry(channel, `${formatClockTimestamp(new Date())} ${text}`).catch((error) => {
      this.logBridgeError(`driver-status channel=${channel.id}`, error);
    });
  }

  private startProcessQueue(conversationId: string): void {
    void this.processQueue(conversationId).catch(async (error) => {
      await this.handleProcessQueueError(conversationId, error);
    });
  }

  private async handleProcessQueueError(conversationId: string, error: unknown): Promise<void> {
    this.logBridgeError(`processQueue conversation=${conversationId}`, error);

    const runtime = this.getRuntime(conversationId);
    const activeRun = runtime.activeRun;
    if (!activeRun) {
      return;
    }

    const errorMessage = this.formatErrorMessage(error);
    this.touchActiveRun(activeRun);
    activeRun.status = activeRun.status === 'cancelled' ? 'cancelled' : 'failed';
    activeRun.latestActivity = `Bridge 内部错误：${errorMessage}`;
    activeRun.stderr.push(`Bridge internal error: ${errorMessage}`);
    activeRun.stderr = activeRun.stderr.slice(-20);
    this.pushRunTimeline(runtime, `💥 Bridge 内部错误：${truncate(errorMessage, 120)}`);

    const binding = this.store.getBinding(activeRun.task.bindingChannelId);
    const session = this.store.getSession(conversationId);
    const channel = await this.fetchChannel(conversationId);

    if (binding && session && channel) {
      await this.refreshRuntimeViews(channel, binding, session, runtime, conversationId !== activeRun.task.bindingChannelId);
      if (activeRun.task.origin === 'user') {
        await this.safeReplyToOriginalMessage(
          channel,
          runtime,
          activeRun.task,
          activeRun.task.messageId,
          `❌ **${binding.projectName}** · ${activeRun.task.requestedBy}\n\nBridge 内部错误，任务已中断。\n\n诊断信息：\n\`\`\`\n${truncate(errorMessage, 900)}\n\`\`\``,
        );
      }
    }

    if (activeRun.task.origin === 'local-resume') {
      this.settleLocalSessionTurn(activeRun.task.id, new Error(errorMessage));
    }

    runtime.activeRun = undefined;
    this.activeJobs.delete(conversationId);
    this.scheduleRuntimeStateSave(conversationId, true);
    await removeAttachmentDir(activeRun.task.attachmentDir).catch(() => undefined);

    if (binding && activeRun.task.origin === 'autopilot') {
      this.activeAutopilotProjects.delete(activeRun.task.bindingChannelId);
      await this.markAutopilotProjectFailed(binding, errorMessage);
    }

    if (binding && session && channel) {
      const nextSession = this.store.getSession(conversationId) ?? session;
      await this.refreshRuntimeViews(channel, binding, nextSession, runtime, conversationId !== activeRun.task.bindingChannelId);
    }

    if (runtime.queue.length > 0) {
      this.startProcessQueue(conversationId);
    }
  }

  private logBridgeError(context: string, error: unknown): void {
    const message = this.formatErrorMessage(error);
    console.error(`[bridge-error] ${context} ${message}`);

    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
  }

  private formatErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async handleCommand(message: Message, command: ParsedCommand): Promise<void> {
    const resolved = this.resolveConversationForMessage(message);
    const isThread = this.isThreadChannel(message.channel);

    switch (command.kind) {
      case 'help':
        await message.reply(formatHelp(this.config.commandPrefix));
        return;
      case 'projects':
        await message.reply(formatProjects(this.store.listBindings(message.guildId ?? undefined)));
        return;
      case 'guide':
        await this.handleGuideCommand(message, resolved, command.prompt);
        return;
      case 'sendfile':
        if (!resolved) {
          await message.reply('当前频道未绑定项目。先执行 `!bind`。');
          return;
        }
        if ('index' in command) {
          await this.handleSendFileSelection(message, resolved, command.index);
          return;
        }
        await this.handleSendFileRequest(message, resolved, command.request);
        return;
      case 'model':
        if (command.action !== 'status' && !this.isAdmin(message)) {
          await message.reply('只有管理员才能切换 Codex 模型。');
          return;
        }
        await this.handleModelCommand(message, resolved, command);
        return;
      case 'goal':
        if (command.action !== 'status' && !this.isAdmin(message)) {
          await message.reply('只有管理员才能管理 Goal Loop。');
          return;
        }
        await this.handleGoalCommand(message, resolved, command);
        return;
      case 'autopilot':
        if (command.scope === 'help') {
          await this.replyWithChunks(message, formatAutopilotHelp(this.config.commandPrefix));
          return;
        }
        if (command.action !== 'status' && !this.isAdmin(message)) {
          await message.reply('只有管理员才能管理 Autopilot。');
          return;
        }
        await this.handleAutopilotCommand(message, resolved, command);
        return;
      case 'bind':
        if (isThread) {
          await message.reply('请在主频道执行 `!bind`，线程会自动继承主频道绑定。');
          return;
        }
        if (!this.isAdmin(message)) {
          await message.reply('只有管理员才能绑定或修改项目映射。');
          return;
        }
        await this.handleBindCommand(message, command.projectName, command.workspacePath, command.options);
        return;
      case 'unbind':
        if (isThread) {
          await message.reply('请在主频道执行 `!unbind`。');
          return;
        }
        if (!this.isAdmin(message)) {
          await message.reply('只有管理员才能解绑项目。');
          return;
        }
        await this.handleUnbindCommand(message);
        return;
      case 'status':
        await this.handleStatusCommand(message, resolved);
        return;
      case 'web':
        await this.handleWebCommand(message);
        return;
      case 'cancel':
        if (!this.isAdmin(message)) {
          await message.reply('只有管理员才能取消正在运行的任务。');
          return;
        }
        await this.handleCancelCommand(message, resolved);
        return;
      case 'reset':
        if (!this.isAdmin(message)) {
          await message.reply('只有管理员才能重置当前频道会话。');
          return;
        }
        await this.handleResetCommand(message, resolved);
        return;
      case 'queue': {
        const conversationId = resolved?.conversationId ?? message.channelId;
        if (command.action === 'show') {
          await message.reply(formatQueue(this.getRuntime(conversationId)));
          return;
        }
        if (!this.isAdmin(message)) {
          await message.reply('只有管理员才能调整队列。');
          return;
        }
        if (command.action === 'insert') {
          await this.handleQueueInsertCommand(message, resolved, command.index);
          return;
        }
        await this.handleQueueRemoveCommand(message, resolved, command.index);
        return;
      }
    }
  }

  private async handleBindCommand(
    message: Message,
    projectName: string,
    workspacePath: string,
    options: BindCommandOptions,
  ): Promise<void> {
    const existingBinding = this.store.getBinding(message.channelId);
    const savedBinding = await this.bindChannel({
      channelId: message.channelId,
      guildId: message.guildId!,
      projectName,
      workspacePath,
      options,
    });
    const autopilotProject = this.store.getAutopilotProject(savedBinding.channelId);
    const globalModel = await this.getGlobalCodexModel();

    const executionChanged = hasBindingExecutionChanged(existingBinding, savedBinding);

    await message.reply(
      [
        `已绑定当前频道到项目 **${savedBinding.projectName}**。`,
        `目录：\`${savedBinding.workspacePath}\``,
        `执行模式：sandbox=\`${savedBinding.codex.sandboxMode}\` · approval=\`${savedBinding.codex.approvalPolicy}\` · search=${savedBinding.codex.search ? 'on' : 'off'}`,
        `模型：${this.formatBindingModelSummary(savedBinding, globalModel)}`,
        autopilotProject?.threadChannelId
          ? `Autopilot 线程：<#${autopilotProject.threadChannelId}>`
          : 'Autopilot 线程：创建失败或当前频道不支持线程，请检查频道类型与权限。',
        'Autopilot 默认已创建但项目级调度默认暂停；可用 `!autopilot project on` 开启，`!autopilot` 查看完整说明。',
        executionChanged
          ? '检测到绑定配置已变更，已重置当前频道及其线程的 Codex 会话；下一条消息会按新权限新建会话。'
          : '现在主频道和其下线程都可以直接控制 Codex。',
      ].join('\n'),
    );
  }

  private async handleModelCommand(
    message: Message,
    resolved: ResolvedConversation | undefined,
    command: Extract<ParsedCommand, { kind: 'model' }>,
  ): Promise<void> {
    if (command.scope === 'global') {
      if (command.action === 'status') {
        const globalModel = await this.getGlobalCodexModel();
        await message.reply(
          [
            '🧠 **Codex 全局模型**',
            `全局模型：${globalModel ? `\`${globalModel}\`` : '未在配置文件中显式设置'}`,
            `配置文件：\`${this.getCodexConfigPath()}\``,
            '说明：全局切换不会 reset 当前会话；运行中的本轮继续使用旧模型，下一轮开始使用新模型。',
          ].join('\n'),
        );
        return;
      }

      const nextModel = command.model.trim();
      await writeCodexGlobalModel(this.getCodexConfigPath(), nextModel);
      this.config.defaultCodex.model = nextModel;

      const now = new Date().toISOString();
      const bindings = this.store.listBindings();

      for (const binding of bindings) {
        await this.store.upsertBinding({
          ...binding,
          codex: {
            ...binding.codex,
            model: nextModel,
          },
          modelScope: 'global',
          updatedAt: now,
        });
      }

      await this.refreshStatusPanelsForBindings(bindings.map((binding) => binding.channelId));
      await message.reply(
        [
          `已切换全局 Codex 模型为 \`${nextModel}\`。`,
          `配置文件：\`${this.getCodexConfigPath()}\``,
          `已同步绑定项目：${bindings.length}`,
          '运行中的任务不会被打断；下一轮请求开始使用新模型。',
        ].join('\n'),
      );
      return;
    }

    if (!resolved) {
      await message.reply('当前频道未绑定项目。先执行 `!bind`。');
      return;
    }

    const binding = this.store.getBinding(resolved.bindingChannelId);
    if (!binding) {
      await message.reply('当前频道未绑定项目。先执行 `!bind`。');
      return;
    }

    const globalModel = await this.getGlobalCodexModel();

    if (command.action === 'status') {
      await message.reply(this.formatProjectModelStatusMessage(binding, globalModel));
      return;
    }

    if (command.action === 'set') {
      const nextBinding: ChannelBinding = {
        ...binding,
        codex: {
          ...binding.codex,
          model: command.model.trim(),
        },
        modelScope: 'project',
        updatedAt: new Date().toISOString(),
      };
      await this.store.upsertBinding(nextBinding);
      await this.refreshStatusPanelsForBindings([nextBinding.channelId]);
      await message.reply(
        [
          `已将当前项目切换到 Codex 模型 \`${nextBinding.codex.model}\`。`,
          `项目：**${nextBinding.projectName}**`,
          '来源：项目覆盖',
          '运行中的任务不会被打断；下一轮请求开始使用新模型。',
        ].join('\n'),
      );
      return;
    }

    const nextCodex = {
      ...binding.codex,
    };
    delete nextCodex.model;

    const clearedBinding: ChannelBinding = {
      ...binding,
      codex: nextCodex,
      modelScope: undefined,
      updatedAt: new Date().toISOString(),
    };
    await this.store.upsertBinding(clearedBinding);
    await this.refreshStatusPanelsForBindings([clearedBinding.channelId]);
    await message.reply(
      [
        '已清除当前项目的模型覆盖，恢复跟随全局。',
        `项目：**${clearedBinding.projectName}**`,
        `全局模型：${globalModel ? `\`${globalModel}\`` : '未在配置文件中显式设置'}`,
        '运行中的任务不会被打断；下一轮请求开始使用全局模型。',
      ].join('\n'),
    );
  }

  private async handleGoalCommand(
    message: Message,
    resolved: ResolvedConversation | undefined,
    command: Extract<ParsedCommand, { kind: 'goal' }>,
  ): Promise<void> {
    if (!resolved) {
      await message.reply('当前频道未绑定项目。先执行 `!bind`。');
      return;
    }

    const runtime = this.getRuntime(resolved.conversationId);
    const session = await this.store.ensureSession(resolved.bindingChannelId, resolved.conversationId);

    if (command.action === 'status') {
      await message.reply(this.formatGoalStatusMessage(resolved.binding, runtime.goal ?? this.store.getGoal(resolved.conversationId)));
      return;
    }

    if (command.action === 'stop') {
      await this.stopGoalLoop(message, resolved, runtime, session);
      return;
    }

    if (command.action === 'start') {
      await this.startGoalLoop(message, resolved, runtime, session, command.goal);
    }
  }

  private formatGoalStatusMessage(binding: ChannelBinding, goal: GoalSessionState | undefined): string {
    if (!goal || goal.status === 'stopped') {
      return [
        '🎯 **Goal Loop 状态**',
        `项目：**${binding.projectName}**`,
        '状态：未运行',
        '用法：`!goal <目标>` 启动；`!goal stop` 停止。',
      ].join('\n');
    }

    return [
      '🎯 **Goal Loop 状态**',
      `项目：**${binding.projectName}**`,
      `状态：${goal.status}`,
      `目标：${goal.objective}`,
      `Codex 会话：${goal.codexThreadId ? `\`${goal.codexThreadId}\`` : '尚未建立'}`,
      `更新时间：${goal.updatedAt}`,
      goal.lastActivity ? `最近活动：${goal.lastActivity}` : undefined,
    ].filter((line): line is string => Boolean(line)).join('\n');
  }

  private buildGoalPrompt(objective: string): string {
    return [
      `Bridge Goal Loop 目标：${objective}`,
      '',
      'Bridge 指令：请开始推进当前已设置的 Goal Loop 目标。只有在目标已经完成、被阻塞且需要用户输入，或收到 `!goal stop` 时才停止。',
      '不要 reset 当前会话；沿用已有上下文继续工作。',
    ].join('\n');
  }

  private async startGoalLoop(
    message: Message,
    resolved: ResolvedConversation,
    runtime: ChannelRuntime,
    session: ConversationSessionState,
    objective: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    let codexThreadId = session.codexThreadId;
    let nativeGoalEnabled = false;

    if (this.runner.setGoal) {
      try {
        codexThreadId = await this.runner.setGoal(resolved.binding, session.codexThreadId, objective);
        nativeGoalEnabled = true;
        if (codexThreadId !== session.codexThreadId) {
          await this.store.updateSession(resolved.conversationId, {
            codexThreadId,
            driver: this.config.codexDriverMode ?? 'app-server',
            fallbackActive: false,
          }, resolved.bindingChannelId);
        }
      } catch (error) {
        this.logBridgeError(`goalSet conversation=${resolved.conversationId}`, error);
      }
    }

    const goal: GoalSessionState = {
      conversationId: resolved.conversationId,
      bindingChannelId: resolved.bindingChannelId,
      objective,
      status: 'active',
      codexThreadId,
      createdAt: runtime.goal?.createdAt ?? now,
      updatedAt: now,
      lastActivity: nativeGoalEnabled ? '已通过 app-server 原生 Goal API 启动' : '已通过 prompt 级 Goal 指令启动',
    };

    runtime.goal = goal;
    await this.store.upsertGoal(goal);

    await this.enqueuePrompt(message, resolved, this.buildGoalPrompt(objective), 'normal', 'goal');
    await message.reply(
      [
        '🎯 Goal Loop 已启动。',
        `项目：**${resolved.binding.projectName}**`,
        `目标：${objective}`,
        nativeGoalEnabled ? '模式：app-server 原生 goal + bridge 状态跟踪' : '模式：prompt 级 goal + bridge 状态跟踪',
        '当前会话上下文已保留，没有 reset。',
      ].join('\n'),
    );
  }

  private async stopGoalLoop(
    message: Message,
    resolved: ResolvedConversation,
    runtime: ChannelRuntime,
    session: ConversationSessionState,
  ): Promise<void> {
    const existingGoal = runtime.goal ?? this.store.getGoal(resolved.conversationId);
    if (!existingGoal || existingGoal.status === 'stopped') {
      await message.reply('当前没有正在运行的 Goal Loop。');
      return;
    }

    const now = new Date().toISOString();
    const stoppedGoal: GoalSessionState = {
      ...existingGoal,
      status: 'stopped',
      updatedAt: now,
      lastActivity: `已由 ${message.author.username} 停止`,
    };

    if (this.runner.clearGoal && session.codexThreadId) {
      try {
        await this.runner.clearGoal(resolved.binding, session.codexThreadId);
      } catch (error) {
        this.logBridgeError(`goalClear conversation=${resolved.conversationId}`, error);
      }
    }

    if (runtime.activeRun) {
      runtime.activeRun.latestActivity = 'Goal Loop 已请求停止';
      runtime.activeRun.cancellationReason = 'user_cancel';
      runtime.activeRun.status = 'cancelled';
      this.pushRunTimeline(runtime, 'Goal Loop 已请求停止');
      if (runtime.activeRun.task.origin === 'goal') {
        this.activeJobs.get(resolved.conversationId)?.cancel();
      }
    }

    runtime.goal = stoppedGoal;
    await this.store.upsertGoal(stoppedGoal);
    await this.refreshRuntimeViews(resolved.channel, resolved.binding, session, runtime, resolved.isThreadConversation);
    await message.reply('Goal Loop 已停止；当前 Codex 会话和上下文已保留。');
  }

  private async handleUnbindCommand(message: Message): Promise<void> {
    const existing = await this.unbindChannel(message.channelId);

    if (!existing) {
      await message.reply('当前频道还没有绑定任何项目。');
      return;
    }

    await message.reply(`已解绑当前频道，原项目为 **${existing.projectName}**。`);
  }

  private getCodexConfigPath(): string {
    return resolveCodexConfigPath(this.config.codexConfigPath);
  }

  private async getGlobalCodexModel(): Promise<string | undefined> {
    const configured = await loadCodexGlobalModel(this.getCodexConfigPath());
    return configured?.trim() || this.config.defaultCodex.model?.trim() || undefined;
  }

  private formatBindingModelSummary(binding: ChannelBinding, globalModel: string | undefined): string {
    const projectModel = binding.codex.model?.trim();

    if (binding.modelScope === 'project' && projectModel) {
      return `\`${projectModel}\`（项目覆盖）`;
    }

    if (binding.modelScope === 'global' && projectModel) {
      return `\`${projectModel}\`（全局已同步）`;
    }

    if (projectModel) {
      return `\`${projectModel}\``;
    }

    if (globalModel) {
      return `\`${globalModel}\`（跟随全局）`;
    }

    return '未显式指定（跟随 Codex 默认配置）';
  }

  private formatProjectModelStatusMessage(binding: ChannelBinding, globalModel: string | undefined): string {
    const effectiveModel = binding.codex.model?.trim() || globalModel;
    const projectModelLine = binding.codex.model?.trim()
      ? `项目模型：${this.formatBindingModelSummary(binding, globalModel)}`
      : globalModel
        ? '项目模型：跟随全局'
        : '项目模型：未显式指定';

    return [
      '🧠 **Codex 项目模型**',
      `项目：**${binding.projectName}**`,
      projectModelLine,
      `全局模型：${globalModel ? `\`${globalModel}\`` : '未在配置文件中显式设置'}`,
      `当前生效：${effectiveModel ? `\`${effectiveModel}\`` : 'Codex 默认配置'}`,
      '说明：切换模型不会 reset 当前会话；运行中的本轮继续使用旧模型，下一轮开始使用新模型。',
    ].join('\n');
  }

  private async refreshStatusPanelsForBindings(bindingChannelIds: string[]): Promise<void> {
    for (const bindingChannelId of bindingChannelIds) {
      const binding = this.store.getBinding(bindingChannelId);
      if (!binding) {
        continue;
      }

      for (const session of this.store.listSessions(bindingChannelId)) {
        const channel = await this.fetchChannel(session.conversationId);
        if (!channel) {
          continue;
        }

        const runtime = this.getRuntime(session.conversationId);
        await this.safeRefreshStatusPanel(
          channel,
          binding,
          session,
          runtime,
          session.conversationId !== bindingChannelId,
        );
      }
    }
  }

  private async handleStatusCommand(message: Message, resolved: ResolvedConversation | undefined): Promise<void> {
    if (!resolved) {
      await message.reply('当前频道未绑定项目。先执行 `!bind`。');
      return;
    }

    const runtime = this.getRuntime(resolved.conversationId);
    const session = await this.store.ensureSession(resolved.bindingChannelId, resolved.conversationId);
    const globalModel = await this.getGlobalCodexModel();
    await this.refreshStatusPanel(resolved.channel, resolved.binding, session, runtime, resolved.isThreadConversation);
    await message.reply(
      formatStatus(
        resolved.binding,
        session,
        runtime,
        this.config.commandPrefix,
        resolved.isThreadConversation,
        this.config.codexDriverMode ?? 'app-server',
        globalModel,
      ),
    );
  }

  private async handleWebCommand(message: Message): Promise<void> {
    if (!this.config.web.enabled) {
      await message.reply('当前 Web 面板未启用。');
      return;
    }

    const urls = buildWebAccessUrls(this.config.web);
    await message.reply(formatWebAccessLinks(urls));
  }

  private async handleCancelCommand(message: Message, resolved: ResolvedConversation | undefined): Promise<void> {
    if (!resolved) {
      await message.reply('当前频道没有正在运行的任务。');
      return;
    }

    const runtime = this.getRuntime(resolved.conversationId);
    let activeJob = this.activeJobs.get(resolved.conversationId);

    if (!activeJob && runtime.activeRun) {
      activeJob = await this.waitForActiveJob(resolved.conversationId);
    }

    if (!activeJob || !runtime.activeRun) {
      await message.reply('当前会话没有正在运行的任务。');
      return;
    }

    runtime.activeRun.status = 'cancelled';
    runtime.activeRun.latestActivity = `已由 ${message.author.username} 请求取消`;
    runtime.activeRun.cancellationReason = 'user_cancel';
    this.scheduleRuntimeStateSave(resolved.conversationId, true);
    activeJob.cancel();

    const session = await this.store.ensureSession(resolved.bindingChannelId, resolved.conversationId);
    await this.refreshStatusPanel(resolved.channel, resolved.binding, session, runtime, resolved.isThreadConversation);
    await message.reply('已发送取消信号给当前 Codex 任务。');
  }

  private async handleQueueInsertCommand(
    message: Message,
    resolved: ResolvedConversation | undefined,
    index: number,
  ): Promise<void> {
    if (!resolved) {
      await message.reply('当前频道未绑定项目。先执行 `!bind`。');
      return;
    }

    const runtime = this.getRuntime(resolved.conversationId);
    if (!runtime.activeRun) {
      await message.reply('当前没有正在运行的任务，无法插入队列项。');
      return;
    }
    const activeTaskId = runtime.activeRun.task.id;

    const queueIndex = index - 1;
    if (queueIndex < 0 || queueIndex >= runtime.queue.length) {
      await message.reply(`队列序号无效。当前等待队列共有 ${runtime.queue.length} 条任务。`);
      return;
    }

    const [queuedTask] = runtime.queue.splice(queueIndex, 1);
    if (!queuedTask) {
      await message.reply('未找到指定的队列项。');
      return;
    }

    const insertedTask = buildQueuedGuidanceTask(runtime.activeRun.task, queuedTask);
    runtime.queue.unshift(insertedTask);
    runtime.activeRun.latestActivity = `已将队列中的 #${index} 插入当前工作，准备优先处理`;
    this.pushRunTimeline(runtime, `🧭 已将队列中的 #${index} 插入当前任务：${truncate(queuedTask.prompt, 120)}`);
    this.scheduleRuntimeStateSave(resolved.conversationId, true);

    await message.reply(`已将队列中的 #${index} 插入当前工作，正在中断当前步骤并优先处理这条新提示。`);

    const session = await this.store.ensureSession(resolved.bindingChannelId, resolved.conversationId);
    await this.refreshRuntimeViews(resolved.channel, resolved.binding, session, runtime, resolved.isThreadConversation);

    let activeJob = this.activeJobs.get(resolved.conversationId);
    if (!activeJob || this.isPendingDetachedJob(activeJob)) {
      activeJob = await this.waitForControllableJob(resolved.conversationId, 1_500, activeTaskId);
    }

    if (activeJob) {
      if (runtime.activeRun?.task.id !== activeTaskId) {
        return;
      }

      runtime.activeRun.cancellationReason = 'guidance';
      this.scheduleRuntimeStateSave(resolved.conversationId, true);

      if (!runtime.activeRun.codexThreadId) {
        await this.waitForConversationThreadId(resolved.conversationId, 1_500, activeTaskId);
      }

      if (runtime.activeRun?.task.id !== activeTaskId) {
        return;
      }

      activeJob.cancel();
      return;
    }

    if (runtime.activeRun?.task.id !== activeTaskId) {
      return;
    }

    runtime.activeRun.cancellationReason = 'guidance';
    runtime.activeRun = undefined;
    this.scheduleRuntimeStateSave(resolved.conversationId, true);
    this.startProcessQueue(resolved.conversationId);
  }

  private async handleQueueRemoveCommand(
    message: Message,
    resolved: ResolvedConversation | undefined,
    index: number,
  ): Promise<void> {
    if (!resolved) {
      await message.reply('当前频道未绑定项目。先执行 `!bind`。');
      return;
    }

    const runtime = this.getRuntime(resolved.conversationId);
    const queueIndex = index - 1;
    if (queueIndex < 0 || queueIndex >= runtime.queue.length) {
      await message.reply(`队列序号无效。当前等待队列共有 ${runtime.queue.length} 条任务。`);
      return;
    }

    const [removedTask] = runtime.queue.splice(queueIndex, 1);
    if (!removedTask) {
      await message.reply('未找到指定的队列项。');
      return;
    }

    this.pushRunTimeline(runtime, `🗑️ 已移除队列中的 #${index}：${truncate(removedTask.prompt, 120)}`);
    this.scheduleRuntimeStateSave(resolved.conversationId, true);

    await message.reply(`已从队列中移除 #${index}：${truncate(removedTask.prompt, 120)}`);

    const session = await this.store.ensureSession(resolved.bindingChannelId, resolved.conversationId);
    await this.refreshRuntimeViews(resolved.channel, resolved.binding, session, runtime, resolved.isThreadConversation);
  }

  private async handleResetCommand(message: Message, resolved: ResolvedConversation | undefined): Promise<void> {
    if (!resolved) {
      await message.reply('当前频道未绑定项目。');
      return;
    }

    const runtime = this.getRuntime(resolved.conversationId);
    let activeJob = this.activeJobs.get(resolved.conversationId);

    if (!activeJob && runtime.activeRun) {
      activeJob = await this.waitForActiveJob(resolved.conversationId);
    }

    if (runtime.activeRun) {
      runtime.activeRun.status = 'cancelled';
      runtime.activeRun.latestActivity = `已由 ${message.author.username} 重置当前会话`;
      runtime.activeRun.cancellationReason = 'reset';
    }
    runtime.queue = [];
    this.scheduleRuntimeStateSave(resolved.conversationId, true);
    activeJob?.cancel();

    const session = await this.resetConversation(resolved.conversationId, resolved.bindingChannelId);
    await this.refreshStatusPanel(resolved.channel, resolved.binding, session, runtime, resolved.isThreadConversation);
    await message.reply('当前会话的 Codex 上下文已重置。下一条消息会开启新会话。');
  }

  private async handleGuideCommand(
    message: Message,
    resolved: ResolvedConversation | undefined,
    prompt: string,
  ): Promise<void> {
    if (!resolved) {
      await message.reply('当前频道未绑定项目。先执行 `!bind`。');
      return;
    }

    const runtime = this.getRuntime(resolved.conversationId);

    if (!runtime.activeRun) {
      await message.reply('当前没有正在运行的任务。直接发送普通消息即可，或先启动一个任务后再使用 `!guide`。');
      return;
    }

    let activeJob = this.activeJobs.get(resolved.conversationId);

    if (!activeJob || this.isPendingDetachedJob(activeJob)) {
      activeJob = await this.waitForControllableJob(resolved.conversationId);
    }

    if (activeJob?.steer) {
      runtime.activeRun.task.guidancePrompt = prompt;
      runtime.activeRun.latestActivity = `收到 ${message.author.username} 的中途引导，继续当前轮次`;
      this.pushRunTimeline(runtime, `🧭 收到新的引导：${truncate(prompt, 120)}`);
      this.scheduleRuntimeStateSave(resolved.conversationId, true);
      await activeJob.steer(prompt);
      await message.react('🧭').catch(() => undefined);
      await message.reply('已将你的新消息作为引导项插入当前工作，Codex 将继续在当前轮次处理中途引导。');
      const session = await this.store.ensureSession(resolved.bindingChannelId, resolved.conversationId);
      await this.refreshRuntimeViews(resolved.channel, resolved.binding, session, runtime, resolved.isThreadConversation);
      return;
    }

    await this.enqueuePrompt(message, resolved, prompt, 'guidance');
  }

  private async handleAutopilotCommand(
    message: Message,
    resolved: ResolvedConversation | undefined,
    command: Exclude<Extract<ParsedCommand, { kind: 'autopilot' }>, { scope: 'help' }>,
  ): Promise<void> {
    if (command.scope === 'server') {
      const response = await this.executeAutopilotServerCommand(command);
      if (command.action === 'status') {
        await this.replyWithChunks(message, response);
        return;
      }
      await message.reply(response);
      return;
    }

    if (!resolved) {
      await message.reply('项目级 Autopilot 命令只能在已绑定项目频道或该项目的 Autopilot 线程里使用。');
      return;
    }

    const response = await this.executeAutopilotProjectCommand(resolved.binding, command);
    if (command.action === 'status') {
      await this.replyWithChunks(message, response);
      return;
    }
    await message.reply(response);
  }

  private async executeAutopilotServerCommand(
    command: Extract<Exclude<Extract<ParsedCommand, { kind: 'autopilot' }>, { scope: 'help' }>, { scope: 'server' }>,
  ): Promise<string> {
    if (command.action === 'status') {
      return this.buildAutopilotServiceStatusText();
    }

    if (command.action === 'concurrency') {
      await this.setAutopilotParallelismAcrossBindings(command.parallelism);
      return formatAutopilotServiceAck('concurrency', command.parallelism);
    }

    if (command.action === 'clear') {
      await this.clearAllAutopilotProjects();
      return formatAutopilotServiceAck('clear');
    }

    await this.setAutopilotEnabledAcrossBindings(command.action === 'on');
    if (command.action === 'off') {
      await this.stopAutopilotWorkAcrossBindings('已按服务级暂停命令停止当前 Autopilot 运行');
    }
    return formatAutopilotServiceAck(command.action);
  }

  private async executeAutopilotProjectCommand(
    binding: ChannelBinding,
    command: Extract<Exclude<Extract<ParsedCommand, { kind: 'autopilot' }>, { scope: 'help' }>, { scope: 'project' }>,
  ): Promise<string> {
    const project = await this.ensureAutopilotResources(binding);

    switch (command.action) {
      case 'status':
        return this.buildAutopilotProjectStatusText(binding, project, this.store.getAutopilotService(binding.guildId));
      case 'on': {
        const nextProject = await this.setAutopilotProjectEnabled(binding, project, true);
        return formatAutopilotProjectAck('on', binding, nextProject);
      }
      case 'off': {
        const nextProject = await this.setAutopilotProjectEnabled(binding, project, false, false);
        await this.stopAutopilotWorkForBinding(binding, '已按项目级暂停命令停止当前 Autopilot 运行');
        return formatAutopilotProjectAck('off', binding, nextProject);
      }
      case 'clear': {
        const nextProject = await this.clearAutopilotProject(binding, project, '已清空项目 Autopilot 状态');
        return formatAutopilotProjectAck('clear', binding, nextProject);
      }
      case 'run': {
        const trigger = await this.triggerAutopilotProjectRun(binding);
        if (trigger.status === 'already-running') {
          return '当前项目的 Autopilot 已在运行中。';
        }
        if (trigger.status === 'busy') {
          const service = this.store.getAutopilotService(binding.guildId);
          return `当前服务器的 Autopilot 已达到并行上限 ${this.getAutopilotParallelism(service)}，请稍后再试，或先执行 \`!autopilot server concurrency <N>\` 调大并行数。`;
        }
        if (trigger.status === 'unavailable') {
          return '当前项目的 Autopilot 线程不可用，暂时无法立即执行。';
        }
        return formatAutopilotProjectAck('run', binding, trigger.project);
      }
      case 'interval': {
        const nextProject = await this.setAutopilotProjectInterval(binding, project, command.intervalMs);
        return formatAutopilotProjectAck('interval', binding, nextProject);
      }
      case 'prompt': {
        const nextProject = await this.updateAutopilotProjectBrief(binding, project, command.prompt);
        return formatAutopilotProjectAck('prompt', binding, nextProject);
      }
    }
  }

  private async handleAutopilotThreadMessage(message: Message, project: AutopilotProjectState): Promise<void> {
    if (!this.isAdmin(message)) {
      await message.reply('只有管理员才能更新当前项目的 Autopilot Prompt。');
      return;
    }

    const brief = message.content.trim();

    if (!brief) {
      await message.reply('请直接发送自然语言要求，例如：优先补测试和稳定性，不要做大功能。');
      return;
    }

    const binding = this.store.getBinding(project.bindingChannelId);
    if (!binding) {
      await message.reply('当前项目绑定不存在，无法更新 Autopilot Prompt。');
      return;
    }

    const nextProject = await this.updateAutopilotProjectBrief(binding, project, brief);
    await message.reply(formatAutopilotBriefAck(nextProject));
  }

  private describeAutopilotProjectRuntime(
    project: AutopilotProjectState,
    service = this.store.getAutopilotService(project.guildId),
  ): string {
    if (project.status === 'running') {
      return '运行中';
    }

    if (service?.enabled === false) {
      return '服务已暂停';
    }

    if (!project.enabled) {
      return '项目已暂停';
    }

    return '待命';
  }

  private getAutopilotParallelism(service: AutopilotServiceState | undefined): number {
    return normalizeAutopilotParallelism(service?.parallelism);
  }

  private isAutopilotProjectActive(bindingChannelId: string): boolean {
    return this.activeAutopilotProjects.has(bindingChannelId);
  }

  private countActiveAutopilotRuns(guildId: string): number {
    let count = 0;

    for (const bindingChannelId of this.activeAutopilotProjects) {
      const project = this.store.getAutopilotProject(bindingChannelId);
      if (project?.guildId === guildId) {
        count += 1;
      }
    }

    return count;
  }

  private buildAutopilotNextRunText(
    project: AutopilotProjectState,
    service = this.store.getAutopilotService(project.guildId),
    nowMs = Date.now(),
  ): string {
    if (project.status === 'running') {
      return project.currentRunStartedAt
        ? `当前运行中（开始于 ${project.currentRunStartedAt}）`
        : '当前运行中';
    }

    if (service?.enabled === false) {
      return '服务级已暂停';
    }

    if (!project.enabled) {
      return '项目级已暂停';
    }

    if (!project.lastRunAt) {
      return '立即可运行';
    }

    const lastRunAtMs = new Date(project.lastRunAt).getTime();
    if (!Number.isFinite(lastRunAtMs)) {
      return '立即可运行';
    }

    const nextRunAtMs = lastRunAtMs + project.intervalMs;
    if (nextRunAtMs <= nowMs) {
      return '立即可运行';
    }

    return new Date(nextRunAtMs).toISOString();
  }

  private async buildAutopilotServiceStatusText(): Promise<string> {
    const generatedAt = new Date().toISOString();
    const lines = [];

    for (const binding of this.store.listBindings()) {
      const project = await this.ensureAutopilotResources(binding);
      const service = this.store.getAutopilotService(binding.guildId);
      lines.push({
        channelId: binding.channelId,
        projectName: binding.projectName,
        serviceEnabled: service?.enabled ?? false,
        projectEnabled: project.enabled,
        runtimeStatus: this.describeAutopilotProjectRuntime(project, service),
        intervalText: formatDurationMs(project.intervalMs),
        nextRunText: this.buildAutopilotNextRunText(project, service),
        parallelism: this.getAutopilotParallelism(service),
        activeAutopilotRuns: this.countActiveAutopilotRuns(binding.guildId),
      });
    }

    return formatAutopilotServiceStatus(lines, generatedAt);
  }

  private buildAutopilotProjectStatusText(
    binding: ChannelBinding,
    project: AutopilotProjectState,
    service: AutopilotServiceState | undefined,
  ): string {
    return formatAutopilotProjectStatus(binding, project, service, {
      generatedAt: new Date().toISOString(),
      nextRunText: this.buildAutopilotNextRunText(project, service),
      serviceParallelism: this.getAutopilotParallelism(service),
      activeAutopilotRuns: this.countActiveAutopilotRuns(binding.guildId),
    });
  }

  private getAutopilotProjectStatus(
    project: AutopilotProjectState,
    serviceEnabled = this.store.getAutopilotService(project.guildId)?.enabled ?? false,
    preserveRunning = true,
  ): AutopilotProjectState['status'] {
    if (preserveRunning && project.status === 'running' && this.isAutopilotProjectActive(project.bindingChannelId)) {
      return 'running';
    }

    return serviceEnabled && project.enabled ? 'idle' : 'paused';
  }

  private async runAutopilotBoardCtl(binding: ChannelBinding, args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(process.execPath, [getAutopilotBoardCtlPath(), ...args], {
        cwd: binding.workspacePath,
        maxBuffer: 1024 * 1024,
      });
      return stdout.trim();
    } catch (error) {
      const candidate = error as NodeJS.ErrnoException & { stdout?: string | Buffer; stderr?: string | Buffer };
      const stderr = typeof candidate.stderr === 'string'
        ? candidate.stderr.trim()
        : Buffer.isBuffer(candidate.stderr)
          ? candidate.stderr.toString('utf8').trim()
          : '';
      const detail = stderr || candidate.message || 'unknown boardctl failure';
      throw new Error(`boardctl 失败（${AUTOPILOT_BOARD_RELATIVE_PATH}）：${detail}`);
    }
  }

  private async importAutopilotBoardFromState(
    binding: ChannelBinding,
    project: AutopilotProjectState,
  ): Promise<void> {
    const importDir = path.join(this.config.dataDir, 'autopilot-board-imports');
    const importPath = path.join(importDir, `${binding.channelId}-${randomUUID()}.json`);
    await fs.mkdir(importDir, { recursive: true });
    await fs.writeFile(importPath, `${JSON.stringify({ items: project.board }, null, 2)}\n`, 'utf8');

    try {
      await this.runAutopilotBoardCtl(binding, ['import', importPath, '--replace', '--json']);
    } finally {
      await fs.rm(importPath, { force: true }).catch(() => undefined);
    }
  }

  private async readAutopilotBoardFromWorkspace(binding: ChannelBinding): Promise<AutopilotProjectState['board']> {
    const raw = await this.runAutopilotBoardCtl(binding, ['export', '--json']);
    return normalizeAutopilotBoardDocument(JSON.parse(raw)).items;
  }

  private async syncAutopilotBoardState(
    binding: ChannelBinding,
    project: AutopilotProjectState,
  ): Promise<AutopilotProjectState> {
    const boardPath = getAutopilotBoardJsonPath(binding.workspacePath);

    try {
      await fs.access(boardPath);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== 'ENOENT') {
        throw error;
      }

      if (project.board.length > 0) {
        await this.importAutopilotBoardFromState(binding, project);
      } else {
        await this.runAutopilotBoardCtl(binding, ['ensure', '--json']);
      }
    }

    const board = await this.readAutopilotBoardFromWorkspace(binding);
    if (areAutopilotBoardsEquivalent(project.board, board)) {
      return project;
    }

    return this.store.upsertAutopilotProject({
      ...project,
      board,
    });
  }

  private async updateAutopilotProjectBrief(
    binding: ChannelBinding,
    project: AutopilotProjectState,
    brief: string,
  ): Promise<AutopilotProjectState> {
    const now = new Date().toISOString();
    const nextProject = await this.store.upsertAutopilotProject({
      ...project,
      brief,
      briefUpdatedAt: now,
      lastActivityAt: now,
      lastActivityText: '已更新项目 Autopilot Prompt',
      status: this.getAutopilotProjectStatus(project),
    });

    await this.refreshAutopilotEntryCard(binding, nextProject);
    return nextProject;
  }

  private async setAutopilotEnabled(guildId: string, enabled: boolean): Promise<AutopilotServiceState> {
    const existingService = this.store.getAutopilotService(guildId);
    const nextService = await this.store.upsertAutopilotService({
      guildId,
      enabled,
      parallelism: this.getAutopilotParallelism(existingService),
      updatedAt: new Date().toISOString(),
    });

    for (const project of this.store.listAutopilotProjects(guildId)) {
      await this.store.upsertAutopilotProject({
        ...project,
        status: this.getAutopilotProjectStatus(project, enabled),
      });
    }

    await this.refreshAutopilotEntryCards(guildId);
    return nextService;
  }

  private async setAutopilotParallelism(guildId: string, parallelism: number): Promise<AutopilotServiceState> {
    const existingService = this.store.getAutopilotService(guildId);
    const nextService = await this.store.upsertAutopilotService({
      guildId,
      enabled: existingService?.enabled ?? false,
      parallelism: normalizeAutopilotParallelism(parallelism),
      updatedAt: new Date().toISOString(),
    });

    await this.refreshAutopilotEntryCards(guildId);
    return nextService;
  }

  private async setAutopilotEnabledAcrossBindings(enabled: boolean): Promise<void> {
    const guildIds = uniqueStrings([
      ...this.store.listBindings().map((binding) => binding.guildId),
      ...this.store.listAutopilotServices().map((service) => service.guildId),
    ]);

    for (const guildId of guildIds) {
      await this.setAutopilotEnabled(guildId, enabled);
    }
  }

  private async setAutopilotParallelismAcrossBindings(parallelism: number): Promise<void> {
    const guildIds = uniqueStrings([
      ...this.store.listBindings().map((binding) => binding.guildId),
      ...this.store.listAutopilotServices().map((service) => service.guildId),
    ]);

    for (const guildId of guildIds) {
      await this.setAutopilotParallelism(guildId, parallelism);
    }
  }

  private async setAutopilotProjectEnabled(
    binding: ChannelBinding,
    project: AutopilotProjectState,
    enabled: boolean,
    preserveRunning = true,
  ): Promise<AutopilotProjectState> {
    const now = new Date().toISOString();
    const nextProject = await this.store.upsertAutopilotProject({
      ...project,
      enabled,
      status: this.getAutopilotProjectStatus({ ...project, enabled }, undefined, preserveRunning),
      lastActivityAt: now,
      lastActivityText: enabled ? '项目级 Autopilot 已开启' : '项目级 Autopilot 已暂停',
    });

    await this.refreshAutopilotEntryCard(binding, nextProject);
    return nextProject;
  }

  private async stopAutopilotWorkAcrossBindings(reasonText: string): Promise<void> {
    for (const binding of this.store.listBindings()) {
      await this.stopAutopilotWorkForBinding(binding, reasonText);
    }
  }

  private async stopAutopilotWorkForBinding(binding: ChannelBinding, reasonText: string): Promise<void> {
    const sessions = this.store.listSessions(binding.channelId);

    for (const session of sessions) {
      const runtime = this.runtimes.get(session.conversationId);
      if (!runtime) {
        continue;
      }

      let changed = false;
      const nextQueue = runtime.queue.filter((task) => !(task.origin === 'autopilot' && task.bindingChannelId === binding.channelId));
      if (nextQueue.length !== runtime.queue.length) {
        runtime.queue = nextQueue;
        changed = true;
      }

      if (runtime.activeRun?.task.origin === 'autopilot' && runtime.activeRun.task.bindingChannelId === binding.channelId) {
        runtime.activeRun.cancellationReason = 'autopilot_disabled';
        runtime.activeRun.status = 'cancelled';
        runtime.activeRun.latestActivity = reasonText;
        this.pushRunTimeline(runtime, `⏹️ ${reasonText}`);
        this.activeJobs.get(session.conversationId)?.cancel();
        this.activeAutopilotProjects.delete(binding.channelId);
        changed = true;
      }

      if (!changed) {
        continue;
      }

      this.scheduleRuntimeStateSave(session.conversationId, true);
      const channel = await this.fetchChannel(session.conversationId);
      if (!channel) {
        continue;
      }

      const nextSession = this.store.getSession(session.conversationId) ?? session;
      await this.refreshRuntimeViews(channel, binding, nextSession, runtime, session.conversationId !== binding.channelId);
    }
  }

  private async setAutopilotProjectInterval(
    binding: ChannelBinding,
    project: AutopilotProjectState,
    intervalMs: number,
  ): Promise<AutopilotProjectState> {
    const now = new Date().toISOString();
    const nextProject = await this.store.upsertAutopilotProject({
      ...project,
      intervalMs,
      status: this.getAutopilotProjectStatus(project),
      lastActivityAt: now,
      lastActivityText: '已更新项目 Autopilot 调度周期',
    });

    await this.refreshAutopilotEntryCard(binding, nextProject);
    return nextProject;
  }

  private async clearAutopilotProject(
    binding: ChannelBinding,
    project: AutopilotProjectState,
    activityText: string,
  ): Promise<AutopilotProjectState> {
    await this.runAutopilotBoardCtl(binding, ['clear', '--json']);
    this.autopilotBoardSnapshots.delete(binding.channelId);
    const clearedProject = await this.store.clearAutopilotProject(binding.channelId) ?? project;
    const now = new Date().toISOString();
    const nextProject = await this.store.upsertAutopilotProject({
      ...clearedProject,
      status: this.getAutopilotProjectStatus(clearedProject),
      lastActivityAt: now,
      lastActivityText: activityText,
    });

    await this.refreshAutopilotEntryCard(binding, nextProject);
    return nextProject;
  }

  private async clearAllAutopilotProjects(): Promise<void> {
    for (const binding of this.store.listBindings()) {
      const project = this.store.getAutopilotProject(binding.channelId);
      if (!project) {
        continue;
      }

      await this.clearAutopilotProject(binding, project, '服务级已清空 Autopilot 状态');
    }
  }

  private async reconcileAutopilotResources(): Promise<void> {
    for (const binding of this.store.listBindings()) {
      try {
        await this.ensureAutopilotResources(binding);
      } catch (error) {
        this.logBridgeError(`reconcileAutopilotResources channel=${binding.channelId}`, error);
      }
    }
  }

  private startAutopilotTicker(): void {
    if (this.autopilotTicker) {
      return;
    }

    this.autopilotTicker = setInterval(() => {
      void this.runAutopilotTick().catch((error) => {
        this.logBridgeError('autopilotTick', error);
      });
    }, getAutopilotTickMs());
    this.autopilotTicker.unref();
  }

  async runAutopilotTick(): Promise<void> {
    if (this.autopilotTickInFlight) {
      return;
    }

    this.autopilotTickInFlight = true;

    try {
      for (const service of this.store.listAutopilotServices()) {
        if (!service.enabled) {
          continue;
        }

        const availableSlots = this.getAutopilotParallelism(service) - this.countActiveAutopilotRuns(service.guildId);
        if (availableSlots <= 0) {
          continue;
        }

        for (let index = 0; index < availableSlots; index += 1) {
          const binding = await this.pickDueAutopilotBinding(service.guildId);
          if (!binding) {
            break;
          }

          await this.launchAutopilotForBinding(binding);
        }
      }
    } finally {
      this.autopilotTickInFlight = false;
    }
  }

  private async pickDueAutopilotBinding(guildId: string): Promise<ChannelBinding | undefined> {
    const now = Date.now();

    for (const binding of this.store.listBindings(guildId)) {
      const project = await this.ensureAutopilotResources(binding);

      if (!project.enabled || project.status === 'running' || this.isAutopilotProjectActive(binding.channelId)) {
        continue;
      }

      if (!project.threadChannelId) {
        continue;
      }

      if (!project.lastRunAt) {
        return binding;
      }

      const lastRunAt = new Date(project.lastRunAt).getTime();
      if (!Number.isFinite(lastRunAt) || now - lastRunAt >= project.intervalMs) {
        return binding;
      }
    }

    return undefined;
  }

  private async launchAutopilotForBinding(binding: ChannelBinding): Promise<void> {
    const project = await this.ensureAutopilotResources(binding);

    if (!project.threadChannelId || !project.enabled) {
      return;
    }
    await this.startAutopilotRun(binding, project);
  }

  private async triggerAutopilotProjectRun(
    binding: ChannelBinding,
  ): Promise<
    | { status: 'started'; project: AutopilotProjectState }
    | { status: 'already-running'; project: AutopilotProjectState }
    | { status: 'busy'; project: AutopilotProjectState }
    | { status: 'unavailable'; project: AutopilotProjectState }
  > {
    const project = await this.ensureAutopilotResources(binding);

    if (project.status === 'running') {
      return { status: 'already-running', project };
    }

    if (!project.threadChannelId) {
      return { status: 'unavailable', project };
    }

    const service = this.store.getAutopilotService(binding.guildId);
    if (this.countActiveAutopilotRuns(binding.guildId) >= this.getAutopilotParallelism(service)) {
      return { status: 'busy', project };
    }

    const nextProject = await this.startAutopilotRun(binding, project);
    return {
      status: nextProject ? 'started' : 'unavailable',
      project: nextProject ?? project,
    };
  }

  private async startAutopilotRun(
    binding: ChannelBinding,
    project: AutopilotProjectState,
  ): Promise<AutopilotProjectState | undefined> {
    if (!project.threadChannelId || this.isAutopilotProjectActive(binding.channelId)) {
      return undefined;
    }

    this.activeAutopilotProjects.add(binding.channelId);

    try {
      const threadChannel = await this.fetchChannel(project.threadChannelId);
      if (!threadChannel) {
        this.activeAutopilotProjects.delete(binding.channelId);
        return undefined;
      }

      if (threadChannel.setArchived) {
        await threadChannel.setArchived(false).catch(() => undefined);
      }

      const syncedProject = await this.syncAutopilotBoardState(binding, project);
      const goal = this.pickAutopilotGoal(syncedProject);
      this.autopilotBoardSnapshots.set(binding.channelId, syncedProject.board);
      const kickoff = await threadChannel.send(formatAutopilotKickoff(binding, syncedProject));
      const now = new Date().toISOString();
      const nextProject = await this.store.upsertAutopilotProject({
        ...syncedProject,
        status: 'running',
        currentGoal: goal,
        currentRunStartedAt: now,
        lastActivityAt: now,
        lastActivityText: 'Autopilot 已启动',
      });

      await this.refreshAutopilotEntryCard(binding, nextProject);
      await this.enqueueSyntheticTask(binding, threadChannel, kickoff.id, {
        displayPrompt: nextProject.brief,
        effectivePrompt: buildAutopilotPrompt(binding, nextProject),
        requestedBy: AUTOPILOT_REQUESTED_BY,
        requestedById: AUTOPILOT_REQUESTED_BY_ID,
        extraAddDirs: [getAutopilotSkillDir()],
        origin: 'autopilot',
      });
      return nextProject;
    } catch (error) {
      this.activeAutopilotProjects.delete(binding.channelId);
      this.autopilotBoardSnapshots.delete(binding.channelId);
      throw error;
    }
  }

  private pickAutopilotGoal(project: AutopilotProjectState): string | undefined {
    const doing = project.board.find((item) => item.status === 'doing');
    if (doing) {
      return doing.title;
    }

    const ready = project.board.find((item) => item.status === 'ready');
    if (ready) {
      return ready.title;
    }

    return undefined;
  }

  private async finishAutopilotTask(
    binding: ChannelBinding,
    task: PromptTask,
    result: CodexRunResult,
    channel: SendableChannel,
  ): Promise<void> {
    const project = this.store.getAutopilotProject(task.bindingChannelId);
    if (!project) {
      return;
    }

    const report = parseAutopilotReport(result.agentMessages);
    const now = new Date().toISOString();
    const boardBefore = this.autopilotBoardSnapshots.get(task.bindingChannelId) ?? project.board;
    this.autopilotBoardSnapshots.delete(task.bindingChannelId);
    let syncedProject = project;
    let nextBoard = project.board;
    let boardSyncError: string | undefined;

    try {
      syncedProject = await this.syncAutopilotBoardState(binding, project);
      nextBoard = syncedProject.board;
    } catch (error) {
      boardSyncError = truncate(error instanceof Error ? error.message : String(error), 180);
      nextBoard = report
        ? boardItemsFromReport(report, project.board)
        : this.buildFallbackAutopilotBoard(project, result.success);
    }

    const boardChanges = diffAutopilotBoards(boardBefore, nextBoard);
    const baseSummary = report?.summary || buildAutopilotFallbackSummary(project.currentGoal, result.agentMessages.at(-1));
    const lastSummary = boardSyncError
      ? `${baseSummary}（看板同步失败：${boardSyncError}）`
      : baseSummary;
    const nextProject: AutopilotProjectState = {
      ...syncedProject,
      status: this.getAutopilotProjectStatus(syncedProject, undefined, false),
      board: nextBoard,
      lastRunAt: now,
      lastResultStatus: result.success ? 'success' : 'failed',
      lastGoal: report?.goal || project.currentGoal || project.lastGoal,
      lastSummary,
      nextSuggestedWork: report?.next || project.nextSuggestedWork,
      currentGoal: undefined,
      currentRunStartedAt: undefined,
      lastActivityAt: now,
      lastActivityText: boardSyncError
        ? (result.success ? 'Autopilot 本轮完成（看板同步异常）' : 'Autopilot 本轮失败（看板同步异常）')
        : result.success
          ? 'Autopilot 本轮完成'
          : 'Autopilot 本轮失败',
    };

    const savedProject = await this.store.upsertAutopilotProject(nextProject);
    await this.refreshAutopilotEntryCard(binding, savedProject);
    await channel.send(formatAutopilotRunSummary(binding, savedProject, boardChanges, boardSyncError));
  }

  private async finishStoppedAutopilotTask(
    binding: ChannelBinding,
    task: PromptTask,
    channel: SendableChannel,
  ): Promise<void> {
    const project = this.store.getAutopilotProject(task.bindingChannelId);
    if (!project) {
      return;
    }

    this.autopilotBoardSnapshots.delete(task.bindingChannelId);
    let syncedProject = project;

    try {
      syncedProject = await this.syncAutopilotBoardState(binding, project);
    } catch (error) {
      this.logBridgeError(`syncAutopilotBoardOnStop channel=${binding.channelId}`, error);
    }

    const now = new Date().toISOString();
    const nextProject = await this.store.upsertAutopilotProject({
      ...syncedProject,
      status: this.getAutopilotProjectStatus(syncedProject, undefined, false),
      lastResultStatus: 'skipped',
      lastSummary: '已按暂停命令停止当前 Autopilot 运行',
      currentGoal: undefined,
      currentRunStartedAt: undefined,
      lastActivityAt: now,
      lastActivityText: 'Autopilot 已按暂停命令停止',
    });

    await this.refreshAutopilotEntryCard(binding, nextProject);
    await channel.send(formatAutopilotSkipNotice(binding, '已按暂停命令停止当前运行。'));
  }

  private buildFallbackAutopilotBoard(project: AutopilotProjectState, success: boolean): AutopilotProjectState['board'] {
    const currentGoal = project.currentGoal?.trim();
    const remaining = project.board.filter((item) => item.title !== currentGoal && item.status !== 'doing');

    if (!currentGoal) {
      return remaining;
    }

    return [
      ...remaining,
      {
        id: `${success ? 'done' : 'blocked'}:${currentGoal}`.toLowerCase().replace(/[^a-z0-9:_-]+/g, '-'),
        title: currentGoal,
        status: success ? 'done' as const : 'blocked' as const,
        updatedAt: new Date().toISOString(),
      },
    ];
  }

  private async markAutopilotProjectFailed(binding: ChannelBinding, errorMessage: string): Promise<void> {
    const project = this.store.getAutopilotProject(binding.channelId);
    if (!project) {
      return;
    }

    this.autopilotBoardSnapshots.delete(binding.channelId);
    const now = new Date().toISOString();
    let syncedProject = project;
    let nextBoard = this.buildFallbackAutopilotBoard(project, false);

    try {
      syncedProject = await this.syncAutopilotBoardState(binding, project);
      nextBoard = syncedProject.board;
    } catch (error) {
      this.logBridgeError(`syncAutopilotBoardOnFailure channel=${binding.channelId}`, error);
    }

    const nextProject = await this.store.upsertAutopilotProject({
      ...syncedProject,
      status: this.getAutopilotProjectStatus(syncedProject, undefined, false),
      lastRunAt: now,
      lastResultStatus: 'failed',
      lastSummary: errorMessage,
      currentGoal: undefined,
      currentRunStartedAt: undefined,
      lastActivityAt: now,
      lastActivityText: 'Autopilot 运行异常中断',
      board: nextBoard,
    });

    await this.refreshAutopilotEntryCard(binding, nextProject);
    const threadChannel = project.threadChannelId ? await this.fetchChannel(project.threadChannelId) : null;
    if (threadChannel) {
      await threadChannel.send(formatAutopilotSkipNotice(binding, errorMessage));
    }
  }

  private async ensureAutopilotResources(binding: ChannelBinding): Promise<AutopilotProjectState> {
    let service = this.store.getAutopilotService(binding.guildId);
    if (!service) {
      service = await this.store.upsertAutopilotService({
        guildId: binding.guildId,
        enabled: false,
        parallelism: this.getAutopilotParallelism(undefined),
        updatedAt: new Date().toISOString(),
      });
    }

    let project = this.store.getAutopilotProject(binding.channelId);
    if (!project) {
      project = await this.store.upsertAutopilotProject({
        bindingChannelId: binding.channelId,
        guildId: binding.guildId,
        workspacePath: binding.workspacePath,
        enabled: false,
        intervalMs: getAutopilotDefaultIntervalMs(),
        brief: DEFAULT_AUTOPILOT_BRIEF,
        briefUpdatedAt: new Date().toISOString(),
        board: [],
        status: 'paused',
      });
    } else if (project.workspacePath && project.workspacePath !== binding.workspacePath) {
      project = await this.store.upsertAutopilotProject({
        ...project,
        workspacePath: binding.workspacePath,
        board: [],
        lastGoal: undefined,
        lastSummary: undefined,
        nextSuggestedWork: undefined,
        currentGoal: undefined,
        currentRunStartedAt: undefined,
        lastActivityAt: new Date().toISOString(),
        lastActivityText: '检测到项目目录变更，已重置看板同步到新目录',
        status: this.getAutopilotProjectStatus({ ...project, board: [] }),
      });
    } else if (!Number.isFinite(project.intervalMs) || project.intervalMs <= 0) {
      project = await this.store.upsertAutopilotProject({
        ...project,
        workspacePath: project.workspacePath ?? binding.workspacePath,
        enabled: project.enabled ?? false,
        intervalMs: getAutopilotDefaultIntervalMs(),
        status: this.getAutopilotProjectStatus(project),
      });
    } else {
      const nextStatus = this.getAutopilotProjectStatus(project, service.enabled);
      if (project.status !== nextStatus || project.workspacePath !== binding.workspacePath) {
        project = await this.store.upsertAutopilotProject({
          ...project,
          workspacePath: binding.workspacePath,
          status: nextStatus,
        });
      }
    }

    project = await this.syncAutopilotBoardState(binding, project);

    const rootChannel = await this.fetchChannel(binding.channelId);
    if (!rootChannel) {
      return project;
    }

    if (project.threadChannelId) {
      const threadChannel = await this.fetchChannel(project.threadChannelId);
      if (threadChannel) {
        if (threadChannel.setArchived) {
          await threadChannel.setArchived(false).catch(() => undefined);
        }
      } else {
        project = await this.store.upsertAutopilotProject({
          ...project,
          threadChannelId: undefined,
        });
      }
    }

    if (!project.threadChannelId) {
      const createdThread = rootChannel.threads
        ? await rootChannel.threads.create({
          name: getAutopilotThreadName(binding.projectName),
          autoArchiveDuration: AUTOPILOT_THREAD_AUTO_ARCHIVE_MINUTES,
          reason: 'Create project autopilot thread',
        }).catch((error) => {
          this.logBridgeError(`createAutopilotThread channel=${binding.channelId}`, error);
          return null;
        })
        : null;

      if (createdThread) {
        project = await this.store.upsertAutopilotProject({
          ...project,
          threadChannelId: createdThread.id,
          lastActivityAt: new Date().toISOString(),
          lastActivityText: 'Autopilot 线程已创建',
        });
        await createdThread.send(formatAutopilotThreadWelcome(binding, project)).catch(() => undefined);
      }
    }

    await this.refreshAutopilotEntryCard(binding, project, rootChannel, service);
    return project;
  }

  private async refreshAutopilotEntryCards(guildId: string): Promise<void> {
    for (const binding of this.store.listBindings(guildId)) {
      const project = this.store.getAutopilotProject(binding.channelId);
      if (!project) {
        continue;
      }

      await this.refreshAutopilotEntryCard(binding, project);
    }
  }

  private async refreshAutopilotEntryCard(
    binding: ChannelBinding,
    project: AutopilotProjectState,
    rootChannel?: SendableChannel,
    service?: AutopilotServiceState,
  ): Promise<void> {
    const channel = rootChannel ?? await this.fetchChannel(binding.channelId);
    if (!channel) {
      return;
    }

    const effectiveService = service ?? this.store.getAutopilotService(binding.guildId);
    const content = formatAutopilotEntryCard(binding, project, effectiveService);

    if (!project.entryMessageId) {
      const created = await channel.send(content);
      if (created.pin) {
        await created.pin().catch(() => undefined);
      }
      await this.store.upsertAutopilotProject({
        ...project,
        entryMessageId: created.id,
      });
      return;
    }

    const existing = await channel.messages.fetch(project.entryMessageId).catch(() => null);
    if (!existing) {
      const created = await channel.send(content);
      if (created.pin) {
        await created.pin().catch(() => undefined);
      }
      await this.store.upsertAutopilotProject({
        ...project,
        entryMessageId: created.id,
      });
      return;
    }

    if (existing.content !== content) {
      await existing.edit(content);
    }
  }

  private getAutopilotProjectByThreadChannelId(threadChannelId: string): AutopilotProjectState | undefined {
    return this.store.listAutopilotProjects().find((project) => project.threadChannelId === threadChannelId);
  }

  private async enqueueSyntheticTask(
    binding: ChannelBinding,
    channel: SendableChannel,
    messageId: string,
    options: {
      displayPrompt: string;
      effectivePrompt: string;
      requestedBy: string;
      requestedById: string;
      extraAddDirs: string[];
      origin: PromptTask['origin'];
    },
  ): Promise<void> {
    const runtime = this.getRuntime(channel.id);
    const task: PromptTask = {
      id: randomUUID(),
      prompt: options.displayPrompt,
      effectivePrompt: options.effectivePrompt,
      rootPrompt: options.displayPrompt,
      rootEffectivePrompt: options.effectivePrompt,
      requestedBy: options.requestedBy,
      requestedById: options.requestedById,
      messageId,
      enqueuedAt: new Date().toISOString(),
      bindingChannelId: binding.channelId,
      conversationId: channel.id,
      attachments: [],
      attachmentDir: undefined,
      extraAddDirs: options.extraAddDirs,
      origin: options.origin,
      priority: 'normal',
    };

    runtime.queue.push(task);
    this.scheduleRuntimeStateSave(channel.id, true);
    const session = await this.store.ensureSession(binding.channelId, channel.id);
    await this.safeRefreshStatusPanel(channel, binding, session, runtime, channel.id !== binding.channelId);
    this.startProcessQueue(channel.id);
  }

  private async enqueuePrompt(
    message: Message,
    resolved: ResolvedConversation,
    prompt: string,
    mode: 'normal' | 'guidance' = 'normal',
    origin: PromptTask['origin'] = 'user',
  ): Promise<void> {
    const runtime = this.getRuntime(resolved.conversationId);
    const taskId = randomUUID();
    const downloaded = await downloadAttachments(
      this.config.dataDir,
      resolved.conversationId,
      taskId,
      extractMessageAttachments(message),
      resolved.binding.workspacePath,
    );
    const basePrompt = buildPromptWithAttachments(prompt, downloaded.attachments, downloaded.attachmentDir);
    const activeTask = runtime.activeRun?.task;
    const rootPrompt = mode === 'guidance'
      ? activeTask?.rootPrompt ?? activeTask?.prompt ?? prompt
      : prompt;
    const rootEffectivePrompt = mode === 'guidance'
      ? activeTask?.rootEffectivePrompt ?? activeTask?.effectivePrompt ?? basePrompt
      : basePrompt;
    const guidancePrompt = mode === 'guidance' ? prompt : undefined;
    const effectivePrompt = mode === 'guidance'
      ? buildGuidancePrompt(rootEffectivePrompt, basePrompt)
      : basePrompt;

    const task: PromptTask = {
      id: taskId,
      prompt,
      effectivePrompt,
      rootPrompt,
      rootEffectivePrompt,
      guidancePrompt,
      requestedBy: message.author.username,
      requestedById: message.author.id,
      messageId: message.id,
      enqueuedAt: new Date().toISOString(),
      bindingChannelId: resolved.bindingChannelId,
      conversationId: resolved.conversationId,
      attachments: downloaded.attachments,
      attachmentDir: downloaded.attachmentDir,
      extraAddDirs: [],
      origin,
      priority: 'normal',
    };

    runtime.queue.push(task);
    this.scheduleRuntimeStateSave(resolved.conversationId, true);

    if (runtime.activeRun) {
      if (mode === 'guidance') {
        let activeJob = this.activeJobs.get(resolved.conversationId);
        const activeTaskId = runtime.activeRun.task.id;

        runtime.queue.splice(runtime.queue.length - 1, 1);
        runtime.queue.unshift(task);
        runtime.activeRun.latestActivity = `收到 ${message.author.username} 的中途引导，准备继续原任务`;
        this.pushRunTimeline(runtime, `🧭 收到新的引导：${truncate(prompt, 120)}`);
        this.scheduleRuntimeStateSave(resolved.conversationId, true);

        await message.react('🧭').catch(() => undefined);
        await message.reply('已将你的新消息作为引导项插入当前工作，正在中断当前步骤，先处理中途引导，再继续原任务。');

        const session = await this.store.ensureSession(resolved.bindingChannelId, resolved.conversationId);
        await this.refreshRuntimeViews(resolved.channel, resolved.binding, session, runtime, resolved.isThreadConversation);

        if (!activeJob || this.isPendingDetachedJob(activeJob)) {
          activeJob = await this.waitForControllableJob(resolved.conversationId, 1_500, activeTaskId);
        }

        if (activeJob) {
          if (runtime.activeRun?.task.id !== activeTaskId) {
            return;
          }

          runtime.activeRun.cancellationReason = 'guidance';
          this.scheduleRuntimeStateSave(resolved.conversationId, true);

          if (!runtime.activeRun.codexThreadId) {
            await this.waitForConversationThreadId(resolved.conversationId, 1_500, activeTaskId);
          }

          if (runtime.activeRun?.task.id !== activeTaskId) {
            return;
          }

          activeJob.cancel();
        } else if (runtime.activeRun?.task.id === activeTaskId) {
          runtime.activeRun.cancellationReason = 'guidance';
          runtime.activeRun = undefined;
          this.scheduleRuntimeStateSave(resolved.conversationId, true);
          this.startProcessQueue(resolved.conversationId);
        }
        return;
      }

      await message.react('🕒').catch(() => undefined);
      await message.reply(`已加入队列，前面还有 ${runtime.queue.length - 1} 条请求。`);
    } else {
      await message.react('🤖').catch(() => undefined);
    }

    const session = await this.store.ensureSession(resolved.bindingChannelId, resolved.conversationId);
    await this.safeRefreshStatusPanel(resolved.channel, resolved.binding, session, runtime, resolved.isThreadConversation);
    this.startProcessQueue(resolved.conversationId);
  }

  private async processQueue(conversationId: string): Promise<void> {
    const runtime = this.getRuntime(conversationId);

    if (runtime.activeRun || runtime.queue.length === 0) {
      return;
    }

    const task = runtime.queue.shift();

    if (!task) {
      return;
    }

    const binding = this.store.getBinding(task.bindingChannelId);

    if (!binding) {
      runtime.queue = [];
      this.scheduleRuntimeStateSave(conversationId, true);
      return;
    }

    const nextRun: ActiveRunState = {
      task,
      driverMode: 'legacy-exec',
      status: 'starting',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      latestActivity: task.recovery ? '正在准备自动恢复' : '准备启动 Codex',
      agentMessages: [],
      reasoningSummaries: [],
      planItems: [],
      collabToolCalls: [],
      timeline: [
        task.recovery
          ? `♻️ 检测到任务中断，准备自动恢复：${this.describeRecoveryTask(task)}`
          : '⏳ 已收到请求，准备启动 Codex',
      ],
      stderr: [],
      usedResume: false,
      codexThreadId: undefined,
      cancellationReason: undefined,
    };

    const preferredDriverMode = this.config.codexDriverMode ?? 'app-server';
    const pendingJob = new PendingRunningCodexJob(preferredDriverMode);
    runtime.activeRun = nextRun;
    this.activeJobs.set(conversationId, pendingJob);
    this.scheduleRuntimeStateSave(conversationId, true);

    const channel = await this.fetchChannel(conversationId);

    if (!channel) {
      this.activeJobs.delete(conversationId);
      runtime.activeRun = undefined;
      runtime.queue = [];
      this.scheduleRuntimeStateSave(conversationId, true);
      return;
    }

    const session = await this.store.ensureSession(task.bindingChannelId, conversationId);
    const isThreadConversation = conversationId !== task.bindingChannelId;
    const resumableThreadId = !session.driver || session.driver === preferredDriverMode
      ? session.codexThreadId
      : undefined;
    nextRun.usedResume = Boolean(resumableThreadId);
    nextRun.codexThreadId = resumableThreadId;

    let currentSession = await this.store.updateSession(conversationId, {
      lastRunAt: nextRun.startedAt,
      lastPromptBy: task.requestedBy,
    }, task.bindingChannelId);

    let currentTask = task;
    let runInput = buildRunInputFromTask(currentTask);
    let pendingRecoveryNotice = false;
    const flushPendingRecoveryNotice = async (): Promise<void> => {
      if (!pendingRecoveryNotice) {
        return;
      }

      pendingRecoveryNotice = false;
      await this.sendDriverStatusNotice(channel, 'app-server 已恢复，后续请求将继续使用官方线程/轮次语义。');
    };
    const hooks: CodexRunHooks = {
      onThreadStarted: async (codexThreadId: string) => {
        if (!runtime.activeRun) {
          return;
        }

        await flushPendingRecoveryNotice();

        if (runtime.activeRun.cancellationReason === 'binding_reset'
          || runtime.activeRun.cancellationReason === 'reset'
          || runtime.activeRun.cancellationReason === 'unbind') {
          return;
        }

        this.touchActiveRun(runtime.activeRun);
        runtime.activeRun.codexThreadId = codexThreadId;
        this.pushRunTimeline(runtime, `🧵 Codex 会话已建立：${codexThreadId.slice(0, 8)}`);
        const nextSession = await this.store.updateSession(conversationId, { codexThreadId }, task.bindingChannelId);
        this.scheduleRuntimeStateSave(conversationId);
        this.scheduleRuntimeViewRefresh(channel, binding, nextSession, runtime, isThreadConversation);
      },
      onActivity: async (activity: string) => {
        if (!runtime.activeRun) {
          return;
        }

        this.touchActiveRun(runtime.activeRun);
        runtime.activeRun.status = runtime.activeRun.status === 'cancelled' ? 'cancelled' : 'running';
        runtime.activeRun.latestActivity = activity;
        this.pushRunTimeline(runtime, `🔄 ${activity}`);
        const nextSession = this.store.getSession(conversationId) ?? currentSession;
        this.scheduleRuntimeStateSave(conversationId);
        this.scheduleRuntimeViewRefresh(channel, binding, nextSession, runtime, isThreadConversation);
      },
      onReasoning: async (reasoning: string) => {
        if (!runtime.activeRun) {
          return;
        }

        this.touchActiveRun(runtime.activeRun);
        const summary = summarizeReasoningText(reasoning, 180);
        if (summary) {
          this.upsertStreamingText(runtime.activeRun.reasoningSummaries, summary, 6);
        }

        const nextSession = this.store.getSession(conversationId) ?? currentSession;
        this.scheduleRuntimeStateSave(conversationId);
        this.scheduleRuntimeViewRefresh(channel, binding, nextSession, runtime, isThreadConversation);
      },
      onTodoListChanged: async (items) => {
        if (!runtime.activeRun) {
          return;
        }

        this.touchActiveRun(runtime.activeRun);
        runtime.activeRun.planItems = items;
        const completed = items.filter((item) => item.completed).length;
        runtime.activeRun.latestActivity = `计划进度 ${completed}/${items.length}`;
        this.pushRunTimeline(runtime, `📋 计划进度 ${completed}/${items.length}`);
        const nextSession = this.store.getSession(conversationId) ?? currentSession;
        this.scheduleRuntimeStateSave(conversationId);
        this.scheduleRuntimeViewRefresh(channel, binding, nextSession, runtime, isThreadConversation);
      },
      onCollabToolChanged: async (item) => {
        if (!runtime.activeRun) {
          return;
        }

        this.touchActiveRun(runtime.activeRun);
        this.upsertCollabToolCall(runtime.activeRun, item);
        runtime.activeRun.latestActivity = describeCollabToolCall(item);
        this.pushRunTimeline(runtime, `🤝 ${truncate(describeCollabToolCall(item, true), 140)}`);
        const nextSession = this.store.getSession(conversationId) ?? currentSession;
        this.scheduleRuntimeStateSave(conversationId);
        this.scheduleRuntimeViewRefresh(channel, binding, nextSession, runtime, isThreadConversation);
      },
      onAgentMessage: async (agentMessage: string) => {
        if (!runtime.activeRun) {
          return;
        }

        this.touchActiveRun(runtime.activeRun);
        this.upsertStreamingText(runtime.activeRun.agentMessages, agentMessage);
        runtime.activeRun.latestActivity = '正在生成回答';
        const nextSession = this.store.getSession(conversationId) ?? currentSession;
        this.scheduleRuntimeStateSave(conversationId);
        this.scheduleRuntimeViewRefresh(channel, binding, nextSession, runtime, isThreadConversation);
      },
      onCommandStarted: async (command: string) => {
        if (!runtime.activeRun) {
          return;
        }

        this.touchActiveRun(runtime.activeRun);
        runtime.activeRun.status = runtime.activeRun.status === 'cancelled' ? 'cancelled' : 'running';
        runtime.activeRun.currentCommand = command;
        runtime.activeRun.latestActivity = '正在执行命令';
        this.pushRunTimeline(runtime, `▶️ ${truncate(command, 120)}`);
        const nextSession = this.store.getSession(conversationId) ?? currentSession;
        this.scheduleRuntimeStateSave(conversationId);
        this.scheduleRuntimeViewRefresh(channel, binding, nextSession, runtime, isThreadConversation);
      },
      onCommandCompleted: async (command: string, output: string, exitCode: number | null) => {
        if (!runtime.activeRun) {
          return;
        }

        this.touchActiveRun(runtime.activeRun);
        runtime.activeRun.currentCommand = command;
        runtime.activeRun.lastCommandOutput = output;
        runtime.activeRun.latestActivity = exitCode === 0 ? '命令执行完成' : '命令执行失败';
        this.pushRunTimeline(runtime, `${exitCode === 0 ? '✅' : '❌'} ${truncate(command, 120)} (${exitCode ?? 'null'})`);
        const nextSession = this.store.getSession(conversationId) ?? currentSession;
        this.scheduleRuntimeStateSave(conversationId);
        this.scheduleRuntimeViewRefresh(channel, binding, nextSession, runtime, isThreadConversation);
      },
      onStderr: async (line: string) => {
        if (!runtime.activeRun) {
          return;
        }

        if (isIgnorableCodexStderrLine(line)) {
          return;
        }

        this.touchActiveRun(runtime.activeRun);
        runtime.activeRun.stderr.push(line);
        runtime.activeRun.stderr = runtime.activeRun.stderr.slice(-20);
        runtime.activeRun.latestActivity = line;
        this.pushRunTimeline(runtime, `⚠️ ${truncate(line, 140)}`);
        const nextSession = this.store.getSession(conversationId) ?? currentSession;
        this.scheduleRuntimeStateSave(conversationId);
        this.scheduleRuntimeViewRefresh(channel, binding, nextSession, runtime, isThreadConversation);
      },
      onFallbackActivated: async (detail) => {
        if (!runtime.activeRun) {
          return;
        }

        this.touchActiveRun(runtime.activeRun);
        runtime.activeRun.driverMode = detail.to;
        runtime.activeRun.latestActivity = 'app-server 不可用，已切换到 legacy-exec fallback';
        this.pushRunTimeline(runtime, `↩️ 已切换到 legacy-exec fallback：${truncate(detail.reason, 120)}`);
        pendingRecoveryNotice = false;
        currentSession = await this.store.updateSession(conversationId, {
          driver: detail.to,
          fallbackActive: true,
          codexThreadId: undefined,
        }, task.bindingChannelId);
        this.scheduleRuntimeStateSave(conversationId, true);
        await this.sendDriverStatusNotice(
          channel,
          `app-server 不可用，当前请求已切换到 legacy-exec fallback。\n原因：${truncate(detail.reason, 240)}`,
        );
        await this.refreshRuntimeViews(channel, binding, currentSession, runtime, isThreadConversation);
      },
    };
    let result: CodexRunResult | undefined;
    let attemptsUsed = 0;
    let pendingRetryKind: ReturnType<typeof diagnoseCodexFailure>['kind'] | undefined;

    try {
      while (true) {
        attemptsUsed += 1;
        const attemptSession = this.store.getSession(conversationId) ?? currentSession;
        const shouldResumeOnPreferredDriver = !attemptSession.driver || attemptSession.driver === preferredDriverMode;
        const existingThreadId = shouldResumeOnPreferredDriver ? attemptSession.codexThreadId : undefined;
        const attemptLimit = this.getAttemptLimitForFailureKind(pendingRetryKind);

        if (attemptsUsed > 1 && runtime.activeRun && pendingRetryKind) {
          const retryDescription = this.describeRetry(pendingRetryKind, attemptsUsed - 1);
          currentTask = buildRecoveryTask(
            runtime.activeRun,
            'retry',
            retryDescription.latestActivity,
            attemptsUsed - 1,
          );
          runInput = buildRunInputFromTask(currentTask);
          this.touchActiveRun(runtime.activeRun);
          runtime.activeRun.task = currentTask;
          runtime.activeRun.status = 'starting';
          runtime.activeRun.latestActivity = retryDescription.latestActivity;
          runtime.activeRun.currentCommand = undefined;
          runtime.activeRun.lastCommandOutput = undefined;
          this.pushRunTimeline(runtime, retryDescription.timeline);
          this.scheduleRuntimeStateSave(conversationId, true);
          await this.announceRecoveryStart(channel, currentTask);
        }

        if (!shouldResumeOnPreferredDriver && attemptSession.codexThreadId) {
          currentSession = await this.store.updateSession(conversationId, {
            codexThreadId: undefined,
          }, task.bindingChannelId);
        }

        if (runtime.activeRun?.cancellationReason) {
          pendingJob.clearJob();
          result = buildCancelledBeforeStartResult(nextRun.usedResume);
          break;
        }

        const job = this.runner.start(binding, runInput, existingThreadId, hooks);
        pendingJob.setJob(job);
        const startedInFallback = preferredDriverMode === 'app-server' && job.driverMode === 'legacy-exec';
        nextRun.driverMode = job.driverMode;
        currentSession = await this.store.updateSession(conversationId, {
          driver: job.driverMode,
          fallbackActive: startedInFallback,
        }, currentTask.bindingChannelId);
        pendingRecoveryNotice = Boolean(attemptSession.fallbackActive) && job.driverMode === 'app-server';
        this.logCodexAttemptStart(binding, currentTask, conversationId, attemptsUsed, attemptLimit, job.pid, existingThreadId);

        await channel.sendTyping().catch(() => undefined);
        await this.refreshRuntimeViews(channel, binding, currentSession, runtime, isThreadConversation);

        result = await job.done;
        const cancellationReason = runtime.activeRun?.cancellationReason;
        const failureDiagnosis = diagnoseCodexFailure(result, cancellationReason);
        const shouldAutoRetry = shouldAutoRetryFailedRun(
          runtime.activeRun,
          result,
          cancellationReason,
          failureDiagnosis.kind,
        );
        const retryLimit = this.getAttemptLimitForFailureKind(failureDiagnosis.kind);
        const canRetryAgain = shouldAutoRetry && this.shouldRetryAgain(attemptsUsed, failureDiagnosis.kind);

        this.logCodexAttemptExit(
          binding,
          currentTask,
          conversationId,
          attemptsUsed,
          retryLimit,
          result,
          canRetryAgain,
          failureDiagnosis.kind,
        );

        if (canRetryAgain) {
          pendingRetryKind = failureDiagnosis.kind;
          let nextSession = this.store.getSession(conversationId) ?? attemptSession;
          const retryDescription = this.describeRetry(failureDiagnosis.kind, attemptsUsed);
          const shouldResetThreadBeforeRetry = retryDescription.resetThreadBeforeRetry;
          pendingJob.clearJob();

          if (shouldResetThreadBeforeRetry) {
            if (runtime.activeRun) {
              this.touchActiveRun(runtime.activeRun);
              runtime.activeRun.codexThreadId = undefined;
              runtime.activeRun.usedResume = false;
              runtime.activeRun.currentCommand = undefined;
              runtime.activeRun.latestActivity = retryDescription.latestActivity;
            }

            nextSession = await this.store.updateSession(conversationId, { codexThreadId: undefined }, currentTask.bindingChannelId);
          }

          this.scheduleRuntimeStateSave(conversationId, true);
          await this.refreshRuntimeViews(channel, binding, nextSession, runtime, isThreadConversation);
          await this.waitBeforeRetry(
            conversationId,
            runtime,
            channel,
            binding,
            nextSession,
            isThreadConversation,
            failureDiagnosis.kind,
            attemptsUsed,
          );
          continue;
        }

        break;
      }

      const cancellationReason = runtime.activeRun?.cancellationReason;
      const failureDiagnosis = diagnoseCodexFailure(result, cancellationReason);
      const suppressReply = !result.success && (cancellationReason === 'guidance' || cancellationReason === 'binding_reset' || cancellationReason === 'reset' || cancellationReason === 'unbind');
      let nextSession = this.store.getSession(conversationId) ?? currentSession;

      if (!result.success && failureDiagnosis.kind === 'stale-session') {
        nextSession = await this.store.updateSession(conversationId, { codexThreadId: undefined }, currentTask.bindingChannelId);
      }

      if (runtime.activeRun) {
        const stoppedByAutopilotPause = cancellationReason === 'autopilot_disabled';
        this.touchActiveRun(runtime.activeRun);
        runtime.activeRun.exitCode = result.exitCode;
        runtime.activeRun.signal = result.signal;
        runtime.activeRun.codexThreadId = result.codexThreadId;
        runtime.activeRun.status = runtime.activeRun.status === 'cancelled'
          ? 'cancelled'
          : result.success
            ? 'completed'
            : 'failed';
        runtime.activeRun.latestActivity = result.success
          ? '本轮执行完成'
          : cancellationReason === 'guidance'
            ? '已按新的引导继续原任务'
            : stoppedByAutopilotPause
              ? '已按暂停命令停止当前 Autopilot 运行'
              : failureDiagnosis.diagnosticLines.at(-1) ?? '本轮执行失败';
        if (!stoppedByAutopilotPause) {
          this.pushRunTimeline(
            runtime,
            result.success
              ? '🎉 本轮执行完成'
              : cancellationReason === 'guidance'
                ? '🧭 当前步骤已被中途引导打断，准备继续原任务'
                : '🛑 本轮执行失败',
          );
        }
      }

      await this.safeRefreshProgressMessage(channel, binding, runtime);
      nextSession = await this.recordTranscriptForCompletedTask(
        channel,
        binding,
        nextSession,
        currentTask,
        result,
      );
      await this.refreshRuntimeViews(channel, binding, nextSession, runtime, isThreadConversation);
      this.scheduleRuntimeStateSave(conversationId, true);
      const shouldReplyToOriginal = currentTask.origin === 'user'
        || (currentTask.origin === 'goal' && cancellationReason !== 'user_cancel');
      if (!suppressReply && shouldReplyToOriginal) {
        const replyPayload = result.success
          ? await this.buildSuccessReplyPayload(channel, binding, currentTask, result)
          : formatFailureReply(binding, currentTask.requestedBy, result);
        await this.safeReplyToOriginalMessage(
          channel,
          runtime,
          currentTask,
          currentTask.messageId,
          replyPayload,
        );
      }

      if (runtime.goal && currentTask.origin === 'goal') {
        const now = new Date().toISOString();
        const nextGoal: GoalSessionState = {
          ...runtime.goal,
          status: cancellationReason === 'user_cancel' ? 'stopped' : result.success ? 'active' : 'failed',
          codexThreadId: result.codexThreadId ?? nextSession.codexThreadId ?? runtime.goal.codexThreadId,
          updatedAt: now,
          lastActivity: cancellationReason === 'user_cancel'
            ? 'Goal Loop 已停止'
            : result.success
              ? 'Goal Loop 本轮完成，等待 Codex 继续或用户停止'
              : 'Goal Loop 本轮失败',
        };
        runtime.goal = nextGoal;
        await this.store.upsertGoal(nextGoal);
      }

      if (currentTask.origin === 'local-resume') {
        this.settleLocalSessionTurn(currentTask.id, {
          ok: result.success,
          conversationId,
          bindingChannelId: currentTask.bindingChannelId,
          projectName: binding.projectName,
          codexThreadId: result.codexThreadId ?? nextSession.codexThreadId ?? '',
          assistantMessage: result.success ? this.getVisibleAssistantMessage(result) : undefined,
          errorMessage: result.success ? undefined : formatFailureReply(binding, currentTask.requestedBy, result),
        });
      }

      if (currentTask.origin === 'autopilot') {
        this.activeAutopilotProjects.delete(currentTask.bindingChannelId);
        if (cancellationReason === 'autopilot_disabled') {
          await this.finishStoppedAutopilotTask(binding, currentTask, channel);
        } else {
          await this.finishAutopilotTask(binding, currentTask, result, channel);
        }
      }
    } finally {
      this.activeJobs.delete(conversationId);
      runtime.activeRun = undefined;
      this.scheduleRuntimeStateSave(conversationId, true);
      const shouldKeepAttachmentDir = Boolean(
        currentTask.attachmentDir
        && (runtime.pendingReplies ?? []).some((item) => item.attachmentDir === currentTask.attachmentDir),
      );
      if (!shouldKeepAttachmentDir) {
        await removeAttachmentDir(currentTask.attachmentDir).catch(() => undefined);
      }
      const nextSession = this.store.getSession(conversationId) ?? currentSession;
      await this.refreshRuntimeViews(channel, binding, nextSession, runtime, isThreadConversation);
      if ((runtime.pendingReplies?.length ?? 0) > 0) {
        this.scheduleDeferredReplyFlush(conversationId, 0);
      }

      if (currentTask.origin === 'autopilot') {
        this.activeAutopilotProjects.delete(currentTask.bindingChannelId);
      }

      if (runtime.queue.length > 0) {
        this.startProcessQueue(conversationId);
      }
    }
  }

  private resolveConversationForMessage(message: Message): ResolvedConversation | undefined {
    const directBinding = this.store.getBinding(message.channelId);
    const channel = this.asSendableChannel(message.channel);

    if (directBinding) {
      return {
        binding: directBinding,
        bindingChannelId: directBinding.channelId,
        conversationId: message.channelId,
        isThreadConversation: false,
        channel,
      };
    }

    const parentId = this.getThreadParentChannelId(message.channel);

    if (!parentId) {
      return undefined;
    }

    const parentBinding = this.store.getBinding(parentId);

    if (!parentBinding) {
      return undefined;
    }

    return {
      binding: parentBinding,
      bindingChannelId: parentBinding.channelId,
      conversationId: message.channelId,
      isThreadConversation: true,
      channel,
    };
  }

  private isThreadChannel(channel: Message['channel'] | SendableChannel): boolean {
    const candidate = channel as { isThread?: (() => boolean) | boolean };

    if (typeof candidate.isThread === 'function') {
      return candidate.isThread();
    }

    return candidate.isThread === true;
  }

  private getThreadParentChannelId(channel: Message['channel'] | SendableChannel): string | undefined {
    if (!this.isThreadChannel(channel)) {
      return undefined;
    }

    return (channel as { parentId?: string | null }).parentId ?? undefined;
  }

  private pushRunTimeline(runtime: ChannelRuntime, entry: string): void {
    if (!runtime.activeRun) {
      return;
    }

    const normalized = entry.trim();
    if (!normalized) {
      return;
    }

    this.touchActiveRun(runtime.activeRun);
    const timeline = runtime.activeRun.timeline;
    const stamped = `${formatClockTimestamp(runtime.activeRun.updatedAt)} ${normalized}`;

    if (timeline.at(-1) === stamped) {
      return;
    }

    timeline.push(stamped);
    if (timeline.length > 12) {
      timeline.splice(0, timeline.length - 12);
    }
  }

  private touchActiveRun(activeRun: ActiveRunState | undefined): void {
    if (!activeRun) {
      return;
    }

    activeRun.updatedAt = new Date().toISOString();
  }

  private upsertCollabToolCall(activeRun: ActiveRunState, item: CollabToolCall): void {
    const nextItem = structuredClone(item);
    const index = activeRun.collabToolCalls.findIndex((candidate) => candidate.id === nextItem.id);

    if (index >= 0) {
      activeRun.collabToolCalls[index] = nextItem;
    } else {
      activeRun.collabToolCalls.push(nextItem);
    }

    if (activeRun.collabToolCalls.length > 8) {
      activeRun.collabToolCalls.splice(0, activeRun.collabToolCalls.length - 8);
    }
  }

  private upsertStreamingText(target: string[], nextValue: string, maxItems = 12): void {
    const normalized = nextValue.trim();
    if (!normalized) {
      return;
    }

    const lastValue = target.at(-1);
    if (lastValue && normalized.startsWith(lastValue)) {
      target[target.length - 1] = normalized;
    } else if (lastValue !== normalized) {
      target.push(normalized);
    }

    if (target.length > maxItems) {
      target.splice(0, target.length - maxItems);
    }
  }

  private describeRetry(kind: ReturnType<typeof diagnoseCodexFailure>['kind'], attempt: number): {
      latestActivity: string;
      timeline: string;
      resetThreadBeforeRetry: boolean;
    } {
    switch (kind) {
      case 'stale-session':
        return {
          latestActivity: '检测到 Codex 会话可能损坏，bridge 正在丢弃当前会话并重试',
          timeline: '🧹 检测到 Codex 会话可能损坏，bridge 正在丢弃当前会话并重试',
          resetThreadBeforeRetry: true,
        };
      case 'rate-limit':
        return attempt >= 2
          ? {
              latestActivity: 'Codex 遇到连续 429 限流，bridge 会继续保留当前任务并再次重试',
              timeline: '⏳ Codex 遇到连续 429 限流，bridge 会继续保留当前任务并再次重试',
              resetThreadBeforeRetry: false,
            }
          : {
              latestActivity: 'Codex 遇到 429 限流，bridge 会继续保留当前任务并自动重试',
              timeline: '⏳ Codex 遇到 429 限流，bridge 会继续保留当前任务并自动重试',
              resetThreadBeforeRetry: false,
            };
      case 'transient':
        return attempt >= 2
          ? {
              latestActivity: 'Codex 连接连续中断，bridge 正在继续当前会话并再次自动重试',
              timeline: '🔁 Codex 连接连续中断，bridge 正在继续当前会话并再次自动重试',
              resetThreadBeforeRetry: false,
            }
          : {
              latestActivity: 'Codex 连接中断，bridge 正在继续当前会话并自动重试',
              timeline: '🔁 Codex 连接中断，bridge 正在继续当前会话并自动重试',
              resetThreadBeforeRetry: false,
            };
      case 'diagnostic':
      case 'none':
        return attempt >= 2
          ? {
              latestActivity: 'Codex 连续失败，bridge 正在继续当前会话并再次自动恢复',
              timeline: '🔁 Codex 连续失败，bridge 正在继续当前会话并再次自动恢复',
              resetThreadBeforeRetry: false,
            }
          : {
              latestActivity: 'Codex 执行失败，bridge 正在基于当前工作区状态自动恢复',
              timeline: '🔁 Codex 执行失败，bridge 正在基于当前工作区状态自动恢复',
              resetThreadBeforeRetry: false,
            };
      case 'unexpected-empty-exit':
      default:
        return attempt >= 2
          ? {
              latestActivity: 'Codex 异常退出且未完成当前轮次，bridge 正在继续当前会话并再次重试',
              timeline: '🔁 Codex 异常退出且未完成当前轮次，bridge 正在继续当前会话并再次重试',
              resetThreadBeforeRetry: false,
            }
          : {
              latestActivity: 'Codex 异常退出，bridge 正在自动重试一次',
              timeline: '🔁 Codex 异常退出，bridge 正在自动重试一次',
              resetThreadBeforeRetry: false,
            };
    }
  }

  private getAttemptLimitForFailureKind(kind: ReturnType<typeof diagnoseCodexFailure>['kind'] | undefined): number | null {
    if (kind === 'rate-limit') {
      return this.config.codexRateLimitMaxAttempts > 0
        ? this.config.codexRateLimitMaxAttempts
        : null;
    }

    return this.config.codexMaxAttempts;
  }

  private formatAttemptLimit(limit: number | null): string {
    return limit === null ? '∞' : String(limit);
  }

  private shouldRetryAgain(attempt: number, kind: ReturnType<typeof diagnoseCodexFailure>['kind']): boolean {
    const limit = this.getAttemptLimitForFailureKind(kind);
    return limit === null || attempt < limit;
  }

  private getRetryDelayMs(kind: ReturnType<typeof diagnoseCodexFailure>['kind'], attempt: number): number {
    if (kind !== 'rate-limit') {
      return 0;
    }

    const baseDelayMs = Math.max(0, this.config.codexRateLimitBaseDelayMs);
    const maxDelayMs = Math.max(baseDelayMs, this.config.codexRateLimitMaxDelayMs);
    if (baseDelayMs === 0 || maxDelayMs === 0) {
      return 0;
    }

    return Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempt - 1)));
  }

  private async waitBeforeRetry(
    conversationId: string,
    runtime: ChannelRuntime,
    channel: SendableChannel,
    binding: ChannelBinding,
    session: ConversationSessionState,
    isThreadConversation: boolean,
    kind: ReturnType<typeof diagnoseCodexFailure>['kind'],
    attempt: number,
  ): Promise<void> {
    const delayMs = this.getRetryDelayMs(kind, attempt);
    if (delayMs <= 0 || !runtime.activeRun) {
      return;
    }

    this.touchActiveRun(runtime.activeRun);
    runtime.activeRun.status = runtime.activeRun.status === 'cancelled' ? 'cancelled' : 'starting';
    runtime.activeRun.latestActivity = `上游返回 429 限流，bridge 将在 ${formatDurationMs(delayMs)} 后继续重试，当前任务不会结束`;
    this.pushRunTimeline(runtime, `⏱️ 上游返回 429 限流，等待 ${formatDurationMs(delayMs)} 后继续重试`);
    this.scheduleRuntimeStateSave(conversationId, true);
    await this.refreshRuntimeViews(channel, binding, session, runtime, isThreadConversation);
    await sleep(delayMs);
  }

  private logCodexAttemptStart(
    binding: ChannelBinding,
    task: PromptTask,
    conversationId: string,
    attempt: number,
    attemptLimit: number | null,
    pid: number | undefined,
    existingThreadId: string | undefined,
  ): void {
    console.log(
      [
        '[codex-run]',
        `project=${binding.projectName}`,
        `conversation=${conversationId}`,
        `task=${task.id.slice(0, 8)}`,
        `attempt=${attempt}/${this.formatAttemptLimit(attemptLimit)}`,
        `pid=${pid ?? 'null'}`,
        `resume=${existingThreadId ? 'true' : 'false'}`,
        `thread=${existingThreadId ?? 'new'}`,
      ].join(' '),
    );
  }

  private logCodexAttemptExit(
    binding: ChannelBinding,
    task: PromptTask,
    conversationId: string,
    attempt: number,
    attemptLimit: number | null,
    result: CodexRunResult,
    retryable: boolean,
    retryKind: ReturnType<typeof diagnoseCodexFailure>['kind'],
  ): void {
    const diagnosticStderr = filterDiagnosticStderr(result.stderr);
    const ignoredStderrCount = result.stderr.length - diagnosticStderr.length;
    const stderrSummary = diagnosticStderr.length > 0
      ? truncate(diagnosticStderr.slice(-3).join(' | '), 240)
      : 'none';
    const log = result.success ? console.log : console.warn;

    log(
      [
        '[codex-run]',
        `project=${binding.projectName}`,
        `conversation=${conversationId}`,
        `task=${task.id.slice(0, 8)}`,
        `attempt=${attempt}/${this.formatAttemptLimit(attemptLimit)}`,
        `exitCode=${result.exitCode ?? 'null'}`,
        `signal=${result.signal ?? 'null'}`,
        `turnCompleted=${result.turnCompleted}`,
        `success=${result.success}`,
        `retryable=${retryable}`,
        `retryKind=${retryKind}`,
        `ignoredStderr=${ignoredStderrCount}`,
        `stderr=${stderrSummary}`,
      ].join(' '),
    );
  }

  private async waitForConversationThreadId(
    conversationId: string,
    timeoutMs = 1_500,
    expectedTaskId?: string,
  ): Promise<string | undefined> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const runtime = this.runtimes.get(conversationId);

      if (expectedTaskId && runtime?.activeRun?.task.id !== expectedTaskId) {
        return undefined;
      }

      const threadId = runtime?.activeRun?.codexThreadId ?? this.store.getSession(conversationId)?.codexThreadId;

      if (threadId) {
        return threadId;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    return this.store.getSession(conversationId)?.codexThreadId;
  }

  private isPendingDetachedJob(job: RunningCodexJob | undefined): job is PendingRunningCodexJob {
    return job instanceof PendingRunningCodexJob && !job.isAttached();
  }

  private async waitForControllableJob(
    conversationId: string,
    timeoutMs = 1_500,
    expectedTaskId?: string,
  ): Promise<RunningCodexJob | undefined> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const runtime = this.runtimes.get(conversationId);

      if (expectedTaskId && runtime?.activeRun?.task.id !== expectedTaskId) {
        return undefined;
      }

      const activeJob = this.activeJobs.get(conversationId);

      if (activeJob && !this.isPendingDetachedJob(activeJob)) {
        return activeJob;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const activeJob = this.activeJobs.get(conversationId);
    const runtime = this.runtimes.get(conversationId);

    if (expectedTaskId && runtime?.activeRun?.task.id !== expectedTaskId) {
      return undefined;
    }

    return this.isPendingDetachedJob(activeJob) ? undefined : activeJob;
  }

  private async waitForActiveJob(conversationId: string, timeoutMs = 1_500): Promise<RunningCodexJob | undefined> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const activeJob = this.activeJobs.get(conversationId);

      if (activeJob) {
        return activeJob;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    return this.activeJobs.get(conversationId);
  }

  private async refreshRuntimeViews(
    channel: SendableChannel,
    binding: ChannelBinding,
    session: ConversationSessionState,
    runtime: ChannelRuntime,
    isThreadConversation: boolean,
  ): Promise<void> {
    const flush = this.queueRuntimeViewRefresh(channel, binding, session, runtime, isThreadConversation);
    await flush;
  }

  private scheduleRuntimeViewRefresh(
    channel: SendableChannel,
    binding: ChannelBinding,
    session: ConversationSessionState,
    runtime: ChannelRuntime,
    isThreadConversation: boolean,
  ): void {
    void this.queueRuntimeViewRefresh(channel, binding, session, runtime, isThreadConversation).catch((error) => {
      this.logBridgeError(`runtimeViewRefresh conversation=${runtime.conversationId}`, error);
    });
  }

  private queueRuntimeViewRefresh(
    channel: SendableChannel,
    binding: ChannelBinding,
    session: ConversationSessionState,
    runtime: ChannelRuntime,
    isThreadConversation: boolean,
  ): Promise<void> {
    const conversationId = runtime.conversationId;
    this.pendingRuntimeViewRefreshes.set(conversationId, {
      channel,
      binding,
      session,
      runtime,
      isThreadConversation,
    });

    const existingFlush = this.runtimeViewFlushes.get(conversationId);
    if (existingFlush) {
      return existingFlush;
    }

    const flush = this.flushRuntimeViews(conversationId);
    this.runtimeViewFlushes.set(conversationId, flush);
    return flush;
  }

  private async flushRuntimeViews(conversationId: string): Promise<void> {
    try {
      while (true) {
        const pending = this.pendingRuntimeViewRefreshes.get(conversationId);
        if (!pending) {
          return;
        }

        const lastRefreshedAt = this.lastRuntimeViewRefreshAt.get(conversationId) ?? 0;
        const waitMs = Math.max(0, MIN_RUNTIME_VIEW_REFRESH_INTERVAL_MS - (Date.now() - lastRefreshedAt));
        if (waitMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }

        const latest = this.pendingRuntimeViewRefreshes.get(conversationId);
        if (!latest) {
          continue;
        }

        this.pendingRuntimeViewRefreshes.delete(conversationId);
        this.touchActiveRun(latest.runtime.activeRun);
        await this.safeRefreshStatusPanel(latest.channel, latest.binding, latest.session, latest.runtime, latest.isThreadConversation);
        await this.safeRefreshProgressMessage(latest.channel, latest.binding, latest.runtime);
        this.lastRuntimeViewRefreshAt.set(conversationId, Date.now());
      }
    } finally {
      this.runtimeViewFlushes.delete(conversationId);
    }
  }

  private async safeRefreshProgressMessage(
    channel: SendableChannel,
    binding: ChannelBinding,
    runtime: ChannelRuntime,
  ): Promise<void> {
    try {
      await this.refreshProgressMessage(channel, binding, runtime);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[discord-view] failed to refresh progress message conversation=${runtime.conversationId} error=${message}`);
    }
  }

  private async safeRefreshStatusPanel(
    channel: SendableChannel,
    binding: ChannelBinding,
    session: ConversationSessionState,
    runtime: ChannelRuntime,
    isThreadConversation: boolean,
  ): Promise<void> {
    try {
      await this.refreshStatusPanel(channel, binding, session, runtime, isThreadConversation);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[discord-view] failed to refresh status panel conversation=${runtime.conversationId} error=${message}`);
    }
  }

  private async safeReplyToOriginalMessage(
    channel: SendableChannel,
    runtime: ChannelRuntime,
    task: PromptTask,
    messageId: string,
    content: SendPayload,
  ): Promise<void> {
    try {
      await this.replyToOriginalMessage(channel, messageId, content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[discord-view] failed to reply to original message id=${messageId} error=${message}`);

      if (this.isRetryableDiscordWriteError(error)) {
        this.deferOriginalReply(runtime, task, messageId, content, message);
      }
    }
  }

  private deferOriginalReply(
    runtime: ChannelRuntime,
    task: PromptTask,
    messageId: string,
    content: SendPayload,
    errorMessage: string,
  ): void {
    const pendingReplies = runtime.pendingReplies ?? [];
    pendingReplies.push({
      id: randomUUID(),
      messageId,
      content: this.serializeDeferredSendPayload(content),
      createdAt: new Date().toISOString(),
      retryCount: 0,
      lastError: errorMessage,
      attachmentDir: task.attachmentDir,
    });
    runtime.pendingReplies = pendingReplies;
    this.scheduleRuntimeStateSave(runtime.conversationId, true);
    this.scheduleDeferredReplyFlush(runtime.conversationId);
  }

  private scheduleDeferredReplyFlush(conversationId: string, delayMs = DEFERRED_REPLY_RETRY_DELAY_MS): void {
    const existingTimer = this.pendingDeferredReplyFlushes.get(conversationId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.pendingDeferredReplyFlushes.delete(conversationId);
      void this.flushDeferredReplies(conversationId).catch((error) => {
        this.logBridgeError(`deferredReplyFlush conversation=${conversationId}`, error);
      });
    }, Math.max(0, delayMs));
    timer.unref?.();
    this.pendingDeferredReplyFlushes.set(conversationId, timer);
  }

  private async flushDeferredReplies(conversationId: string): Promise<void> {
    const runtime = this.runtimes.get(conversationId);
    const pendingReplies = runtime?.pendingReplies ?? [];

    if (!runtime || pendingReplies.length === 0) {
      return;
    }

    const channel = await this.fetchChannel(conversationId);
    if (!channel) {
      this.scheduleDeferredReplyFlush(conversationId);
      return;
    }

    for (const pendingReply of [...pendingReplies]) {
      try {
        await this.replyToOriginalMessage(channel, pendingReply.messageId, this.deserializeDeferredSendPayload(pendingReply.content));
        runtime.pendingReplies = (runtime.pendingReplies ?? []).filter((item) => item.id !== pendingReply.id);
        await this.cleanupDeferredReplyAttachmentDir(runtime, pendingReply);
        this.scheduleRuntimeStateSave(conversationId, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (!this.isRetryableDiscordWriteError(error)) {
          console.warn(`[discord-view] dropping deferred reply conversation=${conversationId} id=${pendingReply.id} error=${message}`);
          runtime.pendingReplies = (runtime.pendingReplies ?? []).filter((item) => item.id !== pendingReply.id);
          await this.cleanupDeferredReplyAttachmentDir(runtime, pendingReply);
          this.scheduleRuntimeStateSave(conversationId, true);
          continue;
        }

        const existing = (runtime.pendingReplies ?? []).find((item) => item.id === pendingReply.id);
        if (existing) {
          existing.retryCount += 1;
          existing.lastError = message;
        }

        this.scheduleRuntimeStateSave(conversationId, true);
        this.scheduleDeferredReplyFlush(conversationId);
        return;
      }
    }
  }

  private async cleanupDeferredReplyAttachmentDir(runtime: ChannelRuntime, pendingReply: DeferredDiscordReply): Promise<void> {
    const attachmentDir = pendingReply.attachmentDir?.trim();
    if (!attachmentDir) {
      return;
    }

    const stillReferenced = (runtime.pendingReplies ?? []).some((item) => item.attachmentDir === attachmentDir);
    if (stillReferenced) {
      return;
    }

    await removeAttachmentDir(attachmentDir).catch(() => undefined);
  }

  private serializeDeferredSendPayload(content: SendPayload): DeferredSendPayload {
    if (typeof content === 'string') {
      return content;
    }

    return {
      content: content.content,
      files: content.files?.map((file) => (typeof file === 'string'
        ? file
        : file.name
          ? {
            attachment: file.attachment,
            name: file.name,
          }
          : {
            attachment: file.attachment,
          })),
    };
  }

  private deserializeDeferredSendPayload(content: DeferredSendPayload): SendPayload {
    if (typeof content === 'string') {
      return content;
    }

    const payload: Exclude<SendPayload, string> = {};

    if (typeof content.content === 'string') {
      payload.content = content.content;
    }

    if (content.files) {
      payload.files = content.files.map((file) => (typeof file === 'string'
        ? file
        : file.name
          ? {
            attachment: file.attachment,
            name: file.name,
          }
          : {
            attachment: file.attachment,
          }));
    }

    return payload;
  }

  private async refreshProgressMessage(
    channel: SendableChannel,
    binding: ChannelBinding,
    runtime: ChannelRuntime,
  ): Promise<void> {
    const activeRun = runtime.activeRun;

    if (!activeRun) {
      return;
    }

    const content = formatProgressMessage(
      binding,
      runtime,
      this.config.commandPrefix,
      this.config.codexDriverMode ?? 'app-server',
    );
    const progressMessageId = activeRun.progressMessageId;

    if (!progressMessageId) {
      const originalMessage = await this.fetchChannelMessageWithRetry(channel, activeRun.task.messageId);
      const created = originalMessage
        ? await this.replyWithRetry(originalMessage, content)
        : await this.sendWithRetry(channel, content);
      activeRun.progressMessageId = created.id;
      return;
    }

    const existing = await this.fetchChannelMessageWithRetry(channel, progressMessageId);

    if (!existing) {
      const created = await this.sendWithRetry(channel, content);
      activeRun.progressMessageId = created.id;
      return;
    }

    if (existing.content !== content) {
      await this.editWithRetry(existing, content);
    }
  }

  private async refreshStatusPanel(
    channel: SendableChannel,
    binding: ChannelBinding,
    session: ConversationSessionState,
    runtime: ChannelRuntime,
    isThreadConversation: boolean,
  ): Promise<void> {
    const globalModel = await this.getGlobalCodexModel();
    const content = formatStatus(
      binding,
      session,
      runtime,
      this.config.commandPrefix,
      isThreadConversation,
      this.config.codexDriverMode ?? 'app-server',
      globalModel,
    );
    const statusMessageId = session.statusMessageId;

    if (!statusMessageId) {
      const created = await this.sendWithRetry(channel, content);
      await this.store.updateSession(session.conversationId, { statusMessageId: created.id }, session.bindingChannelId);
      return;
    }

    const existing = await this.fetchChannelMessageWithRetry(channel, statusMessageId);

    if (!existing) {
      const created = await this.sendWithRetry(channel, content);
      await this.store.updateSession(session.conversationId, { statusMessageId: created.id }, session.bindingChannelId);
      return;
    }

    if (existing.content !== content) {
      await this.editWithRetry(existing, content);
    }
  }

  private async replyToOriginalMessage(channel: SendableChannel, messageId: string, content: SendPayload): Promise<void> {
    const originalMessage = await this.fetchChannelMessageWithRetry(channel, messageId);

    if (typeof content !== 'string') {
      if (originalMessage) {
        await this.replyWithRetry(originalMessage, content);
        return;
      }

      await this.sendWithRetry(channel, content);
      return;
    }

    const chunks = this.normalizeDiscordTextChunks(content);

    if (!originalMessage) {
      for (const chunk of chunks) {
        await this.sendWithRetry(channel, chunk);
      }
      return;
    }

    const [firstChunk, ...remainingChunks] = chunks;

    if (firstChunk) {
      await this.replyWithRetry(originalMessage, firstChunk);
    }

    for (const chunk of remainingChunks) {
      await this.sendWithRetry(channel, chunk);
    }
  }

  private isAdmin(message: Message): boolean {
    if (this.config.adminUserIds.has(message.author.id)) {
      return true;
    }

    return Boolean(
      message.member?.permissions.has(PermissionFlagsBits.ManageGuild)
      || message.member?.permissions.has(PermissionFlagsBits.ManageChannels),
    );
  }

  private async fetchChannel(channelId: string): Promise<SendableChannel | null> {
    const channel = await this.client.channels.fetch(channelId).catch(() => null);

    if (!channel || !isSendableChannel(channel)) {
      return null;
    }

    return channel;
  }

  private asSendableChannel(channel: Message['channel']): SendableChannel {
    return channel as unknown as SendableChannel;
  }
}

function describeCollabToolCall(item: CollabToolCall, includePrompt = false): string {
  const receiverCount = Math.max(item.receiverThreadIds.length, Object.keys(item.agentsStates).length);
  const promptSuffix = includePrompt && item.prompt ? `：${item.prompt}` : '';

  switch (item.tool) {
    case 'spawn_agent':
      switch (item.status) {
        case 'in_progress':
          return `正在拉起子代理${promptSuffix}`;
        case 'completed':
          return `已拉起 ${Math.max(1, receiverCount)} 个子代理`;
        case 'failed':
          return '拉起子代理失败';
      }
      break;
    case 'send_input':
      switch (item.status) {
        case 'in_progress':
          return `正在向子代理发送指令${promptSuffix}`;
        case 'completed':
          return `已向 ${Math.max(1, receiverCount)} 个子代理发送指令`;
        case 'failed':
          return '向子代理发送指令失败';
      }
      break;
    case 'wait':
      switch (item.status) {
        case 'in_progress':
          return `正在等待 ${Math.max(1, receiverCount)} 个子代理`;
        case 'completed':
          return `等待子代理结束：${summarizeCollabAgentStates(item)}`;
        case 'failed':
          return `等待子代理失败：${summarizeCollabAgentStates(item)}`;
      }
      break;
    case 'close_agent':
      switch (item.status) {
        case 'in_progress':
          return `正在关闭 ${Math.max(1, receiverCount)} 个子代理`;
        case 'completed':
          return `已关闭 ${Math.max(1, receiverCount)} 个子代理`;
        case 'failed':
          return '关闭子代理失败';
      }
      break;
  }

  return '子代理协作已更新';
}

function summarizeCollabAgentStates(item: CollabToolCall): string {
  const namedStates = Object.values(item.agentsStates)
    .map((state) => {
      const nickname = state.nickname?.trim();
      return nickname ? `${nickname} ${state.status}` : undefined;
    })
    .filter((value): value is string => Boolean(value));

  if (namedStates.length > 0) {
    return namedStates.join(' · ');
  }

  const counts = new Map<string, number>();

  for (const state of Object.values(item.agentsStates)) {
    counts.set(state.status, (counts.get(state.status) ?? 0) + 1);
  }

  if (counts.size === 0) {
    return '无状态';
  }

  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status} ${count}`)
    .join(' · ');
}

function buildCancelledBeforeStartResult(usedResume: boolean): CodexRunResult {
  return {
    success: false,
    exitCode: null,
    signal: null,
    codexThreadId: undefined,
    usedResume,
    turnCompleted: false,
    agentMessages: [],
    reasoning: [],
    planItems: [],
    stderr: ['Codex process cancelled before start.'],
    commands: [],
  };
}

function isSendableChannel(channel: unknown): channel is SendableChannel {
  return Boolean(
    channel
    && typeof (channel as SendableChannel).send === 'function'
    && typeof (channel as SendableChannel).sendTyping === 'function',
  );
}
