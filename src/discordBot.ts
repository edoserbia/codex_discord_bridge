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
import type { AppConfig } from './config.js';
import type { BindCommandOptions, ParsedCommand } from './commandParser.js';
import type { CodexExecutionDriver, CodexRunHooks, RunningCodexJob } from './codexRunner.js';
import type {
  ActiveRunState,
  AutopilotProjectState,
  AutopilotServiceState,
  ChannelRuntime,
  ChannelBinding,
  CollabToolCall,
  CodexDriverMode,
  CodexRunResult,
  ConversationSessionState,
  DashboardBinding,
  DashboardConversation,
  PromptTask,
} from './types.js';

import { buildPromptWithAttachments, downloadAttachments, extractMessageAttachments, removeAttachmentDir } from './attachments.js';
import { diagnoseCodexFailure, filterDiagnosticStderr, isIgnorableCodexStderrLine } from './codexDiagnostics.js';
import { isCommandMessage, parseCommand } from './commandParser.js';
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
} from './formatters.js';
import { JsonStateStore } from './store.js';
import { cloneCodexOptions, formatClockTimestamp, formatDurationMs, isWithinAllowedRoots, normalizeAllowedRoots, resolveExistingDirectory, splitIntoDiscordChunks, summarizeReasoningText, truncate, uniqueStrings } from './utils.js';

type SendableMessage = {
  id: string;
  content: string;
  reply: (content: string) => Promise<SendableMessage>;
  edit: (content: string) => Promise<SendableMessage>;
  pin?: () => Promise<unknown>;
};

type SendableChannel = {
  id: string;
  parentId?: string | null;
  guildId?: string | null;
  send: (content: string) => Promise<SendableMessage>;
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

const MAX_CODEX_ATTEMPTS = 3;
const MIN_RUNTIME_VIEW_REFRESH_INTERVAL_MS = 1_200;
const AUTOPILOT_THREAD_AUTO_ARCHIVE_MINUTES: ThreadAutoArchiveDuration = 1440;
const AUTOPILOT_REQUESTED_BY = 'Autopilot';
const AUTOPILOT_REQUESTED_BY_ID = 'autopilot';
const execFileAsync = promisify(execFile);

interface PendingRuntimeViewRefresh {
  channel: SendableChannel;
  binding: ChannelBinding;
  session: ConversationSessionState;
  runtime: ChannelRuntime;
  isThreadConversation: boolean;
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

  private readonly runtimes = new Map<string, ChannelRuntime>();
  private readonly activeJobs = new Map<string, RunningCodexJob>();
  private readonly runtimeViewFlushes = new Map<string, Promise<void>>();
  private readonly pendingRuntimeViewRefreshes = new Map<string, PendingRuntimeViewRefresh>();
  private readonly lastRuntimeViewRefreshAt = new Map<string, number>();
  private readonly activeAutopilotProjects = new Set<string>();
  private readonly autopilotBoardSnapshots = new Map<string, AutopilotProjectState['board']>();
  private autopilotTicker: NodeJS.Timeout | undefined;
  private autopilotTickInFlight = false;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStateStore,
    private readonly runner: CodexExecutionDriver,
  ) {
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
    this.startAutopilotTicker();
  }

  async stop(): Promise<void> {
    if (this.autopilotTicker) {
      clearInterval(this.autopilotTicker);
      this.autopilotTicker = undefined;
    }

    await this.runner.stop?.();
    await this.client.destroy();
  }

  listBindings(guildId?: string): ChannelBinding[] {
    return this.store.listBindings(guildId);
  }

  async bindChannel(request: BindRequest): Promise<ChannelBinding> {
    const resolvedWorkspace = await resolveExistingDirectory(request.workspacePath);
    const resolvedGuildId = request.guildId ?? (await this.fetchChannel(request.channelId))?.guildId ?? undefined;
    const allowedRoots = await normalizeAllowedRoots(this.config.allowedWorkspaceRoots);

    if (!resolvedGuildId) {
      throw new Error(`无法解析频道 ${request.channelId} 对应的 guildId，请确认机器人已加入该服务器并能访问此频道。`);
    }

    if (!isWithinAllowedRoots(resolvedWorkspace, allowedRoots)) {
      throw new Error(`该目录不在允许的根目录下：${resolvedWorkspace}`);
    }

    const options = request.options ?? { addDirs: [], extraConfig: [] };
    const addDirs = await Promise.all(options.addDirs.map(async (item) => resolveExistingDirectory(item)));

    for (const addDir of addDirs) {
      if (!isWithinAllowedRoots(addDir, allowedRoots)) {
        throw new Error(`附加可写目录不在允许范围内：${addDir}`);
      }
    }

    const existingBinding = this.store.getBinding(request.channelId);
    const codexOptions = cloneCodexOptions(this.config.defaultCodex);

    if (options.model) {
      codexOptions.model = options.model;
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
      runtime = { conversationId, queue: [] };
      this.runtimes.set(conversationId, runtime);
    }

    return runtime;
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
        await message.reply(text);
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

    const prompt = message.content.trim();

    if (!prompt && extractMessageAttachments(message).length === 0) {
      return;
    }

    await this.enqueuePrompt(message, resolved, prompt || '请分析我附带的附件内容。');
  }

  private async safeMessageReply(message: Message, content: string): Promise<void> {
    await message.reply(content).catch((error) => {
      this.logBridgeError(`reply message=${message.id}`, error);
    });
  }

  private async replyWithChunks(message: Message, content: string): Promise<void> {
    const chunks = splitIntoDiscordChunks(content, 1800);
    const [firstChunk, ...remainingChunks] = chunks;

    if (firstChunk) {
      await message.reply(firstChunk);
    }

    for (const chunk of remainingChunks) {
      await (message.channel as SendableChannel).send(chunk);
    }
  }

  private async sendDriverStatusNotice(channel: SendableChannel, text: string): Promise<void> {
    await channel.send(`${formatClockTimestamp(new Date())} ${text}`).catch((error) => {
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
      await this.safeReplyToOriginalMessage(
        channel,
        activeRun.task.messageId,
        `❌ **${binding.projectName}** · ${activeRun.task.requestedBy}\n\nBridge 内部错误，任务已中断。\n\n诊断信息：\n\`\`\`\n${truncate(errorMessage, 900)}\n\`\`\``,
      );
    }

    runtime.activeRun = undefined;
    this.activeJobs.delete(conversationId);
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
        await message.reply(formatQueue(this.getRuntime(conversationId)));
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

    const executionChanged = hasBindingExecutionChanged(existingBinding, savedBinding);

    await message.reply(
      [
        `已绑定当前频道到项目 **${savedBinding.projectName}**。`,
        `目录：\`${savedBinding.workspacePath}\``,
        `执行模式：sandbox=\`${savedBinding.codex.sandboxMode}\` · approval=\`${savedBinding.codex.approvalPolicy}\` · search=${savedBinding.codex.search ? 'on' : 'off'}`,
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

  private async handleUnbindCommand(message: Message): Promise<void> {
    const existing = await this.unbindChannel(message.channelId);

    if (!existing) {
      await message.reply('当前频道还没有绑定任何项目。');
      return;
    }

    await message.reply(`已解绑当前频道，原项目为 **${existing.projectName}**。`);
  }

  private async handleStatusCommand(message: Message, resolved: ResolvedConversation | undefined): Promise<void> {
    if (!resolved) {
      await message.reply('当前频道未绑定项目。先执行 `!bind`。');
      return;
    }

    const runtime = this.getRuntime(resolved.conversationId);
    const session = await this.store.ensureSession(resolved.bindingChannelId, resolved.conversationId);
    await this.refreshStatusPanel(resolved.channel, resolved.binding, session, runtime, resolved.isThreadConversation);
    await message.reply(
      formatStatus(
        resolved.binding,
        session,
        runtime,
        this.config.commandPrefix,
        resolved.isThreadConversation,
        this.config.codexDriverMode ?? 'app-server',
      ),
    );
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
    activeJob.cancel();

    const session = await this.store.ensureSession(resolved.bindingChannelId, resolved.conversationId);
    await this.refreshStatusPanel(resolved.channel, resolved.binding, session, runtime, resolved.isThreadConversation);
    await message.reply('已发送取消信号给当前 Codex 任务。');
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
      if (command.action === 'status') {
        await this.replyWithChunks(message, await this.buildAutopilotServiceStatusText());
        return;
      }

      if (command.action === 'concurrency') {
        await this.setAutopilotParallelismAcrossBindings(command.parallelism);
        await message.reply(formatAutopilotServiceAck('concurrency', command.parallelism));
        return;
      }

      if (command.action === 'clear') {
        await this.clearAllAutopilotProjects();
        await message.reply(formatAutopilotServiceAck('clear'));
        return;
      }

      await this.setAutopilotEnabledAcrossBindings(command.action === 'on');
      await message.reply(formatAutopilotServiceAck(command.action));
      return;
    }

    if (!resolved) {
      await message.reply('项目级 Autopilot 命令只能在已绑定项目频道或该项目的 Autopilot 线程里使用。');
      return;
    }

    const binding = resolved.binding;
    const project = await this.ensureAutopilotResources(binding);

    switch (command.action) {
      case 'status':
        await this.replyWithChunks(
          message,
          this.buildAutopilotProjectStatusText(binding, project, this.store.getAutopilotService(binding.guildId)),
        );
        return;
      case 'on': {
        const nextProject = await this.setAutopilotProjectEnabled(binding, project, true);
        await message.reply(formatAutopilotProjectAck('on', binding, nextProject));
        return;
      }
      case 'off': {
        const nextProject = await this.setAutopilotProjectEnabled(binding, project, false);
        await message.reply(formatAutopilotProjectAck('off', binding, nextProject));
        return;
      }
      case 'clear': {
        const nextProject = await this.clearAutopilotProject(binding, project, '已清空项目 Autopilot 状态');
        await message.reply(formatAutopilotProjectAck('clear', binding, nextProject));
        return;
      }
      case 'run': {
        const trigger = await this.triggerAutopilotProjectRun(binding);
        if (trigger.status === 'already-running') {
          await message.reply('当前项目的 Autopilot 已在运行中。');
          return;
        }
        if (trigger.status === 'busy') {
          const service = this.store.getAutopilotService(binding.guildId);
          await message.reply(`当前服务器的 Autopilot 已达到并行上限 ${this.getAutopilotParallelism(service)}，请稍后再试，或先执行 \`!autopilot server concurrency <N>\` 调大并行数。`);
          return;
        }
        if (trigger.status === 'unavailable') {
          await message.reply('当前项目的 Autopilot 线程不可用，暂时无法立即执行。');
          return;
        }
        await message.reply(formatAutopilotProjectAck('run', binding, trigger.project));
        return;
      }
      case 'interval': {
        const nextProject = await this.setAutopilotProjectInterval(binding, project, command.intervalMs);
        await message.reply(formatAutopilotProjectAck('interval', binding, nextProject));
        return;
      }
      case 'prompt': {
        const nextProject = await this.updateAutopilotProjectBrief(binding, project, command.prompt);
        await message.reply(formatAutopilotProjectAck('prompt', binding, nextProject));
        return;
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
  ): Promise<AutopilotProjectState> {
    const now = new Date().toISOString();
    const nextProject = await this.store.upsertAutopilotProject({
      ...project,
      enabled,
      status: this.getAutopilotProjectStatus({ ...project, enabled }),
      lastActivityAt: now,
      lastActivityText: enabled ? '项目级 Autopilot 已开启' : '项目级 Autopilot 已暂停',
    });

    await this.refreshAutopilotEntryCard(binding, nextProject);
    return nextProject;
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
    };

    runtime.queue.push(task);
    const session = await this.store.ensureSession(binding.channelId, channel.id);
    await this.safeRefreshStatusPanel(channel, binding, session, runtime, channel.id !== binding.channelId);
    this.startProcessQueue(channel.id);
  }

  private async enqueuePrompt(
    message: Message,
    resolved: ResolvedConversation,
    prompt: string,
    mode: 'normal' | 'guidance' = 'normal',
  ): Promise<void> {
    const runtime = this.getRuntime(resolved.conversationId);
    const taskId = randomUUID();
    const downloaded = await downloadAttachments(this.config.dataDir, resolved.conversationId, taskId, extractMessageAttachments(message));
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
      origin: 'user',
    };

    runtime.queue.push(task);

    if (runtime.activeRun) {
      if (mode === 'guidance') {
        let activeJob = this.activeJobs.get(resolved.conversationId);

        runtime.queue.splice(runtime.queue.length - 1, 1);
        runtime.queue.unshift(task);
        runtime.activeRun.latestActivity = `收到 ${message.author.username} 的中途引导，准备继续原任务`;
        runtime.activeRun.cancellationReason = 'guidance';
        this.pushRunTimeline(runtime, `🧭 收到新的引导：${truncate(prompt, 120)}`);

        await message.react('🧭').catch(() => undefined);
        await message.reply('已将你的新消息作为引导项插入当前工作，正在中断当前步骤，先处理中途引导，再继续原任务。');

        const session = await this.store.ensureSession(resolved.bindingChannelId, resolved.conversationId);
        await this.refreshRuntimeViews(resolved.channel, resolved.binding, session, runtime, resolved.isThreadConversation);

        if (!activeJob || this.isPendingDetachedJob(activeJob)) {
          activeJob = await this.waitForControllableJob(resolved.conversationId);
        }

        if (activeJob) {
          if (!runtime.activeRun.codexThreadId) {
            await this.waitForConversationThreadId(resolved.conversationId);
          }
          activeJob.cancel();
        } else {
          runtime.activeRun = undefined;
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
      return;
    }

    const nextRun: ActiveRunState = {
      task,
      driverMode: 'legacy-exec',
      status: 'starting',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      latestActivity: '准备启动 Codex',
      agentMessages: [],
      reasoningSummaries: [],
      planItems: [],
      collabToolCalls: [],
      timeline: ['⏳ 已收到请求，准备启动 Codex'],
      stderr: [],
      usedResume: false,
      codexThreadId: undefined,
      cancellationReason: undefined,
    };

    const preferredDriverMode = this.config.codexDriverMode ?? 'app-server';
    const pendingJob = new PendingRunningCodexJob(preferredDriverMode);
    runtime.activeRun = nextRun;
    this.activeJobs.set(conversationId, pendingJob);

    const channel = await this.fetchChannel(conversationId);

    if (!channel) {
      this.activeJobs.delete(conversationId);
      runtime.activeRun = undefined;
      runtime.queue = [];
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

    const runInput = {
      prompt: task.effectivePrompt,
      imagePaths: task.attachments.filter((item) => item.isImage).map((item) => item.localPath),
      extraAddDirs: [
        ...task.extraAddDirs,
        ...(task.attachmentDir ? [task.attachmentDir] : []),
      ],
    };
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
        await this.refreshRuntimeViews(channel, binding, nextSession, runtime, isThreadConversation);
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
        await this.refreshRuntimeViews(channel, binding, nextSession, runtime, isThreadConversation);
      },
      onReasoning: async (reasoning: string) => {
        if (!runtime.activeRun) {
          return;
        }

        this.touchActiveRun(runtime.activeRun);
        const summary = summarizeReasoningText(reasoning, 180);
        if (summary) {
          runtime.activeRun.reasoningSummaries.push(summary);
          runtime.activeRun.reasoningSummaries = runtime.activeRun.reasoningSummaries.slice(-6);
          runtime.activeRun.latestActivity = summary;
          this.pushRunTimeline(runtime, `🧠 ${summary}`);
        }

        const nextSession = this.store.getSession(conversationId) ?? currentSession;
        await this.refreshRuntimeViews(channel, binding, nextSession, runtime, isThreadConversation);
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
        await this.refreshRuntimeViews(channel, binding, nextSession, runtime, isThreadConversation);
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
        await this.refreshRuntimeViews(channel, binding, nextSession, runtime, isThreadConversation);
      },
      onAgentMessage: async (agentMessage: string) => {
        if (!runtime.activeRun) {
          return;
        }

        this.touchActiveRun(runtime.activeRun);
        runtime.activeRun.agentMessages.push(agentMessage);
        runtime.activeRun.latestActivity = agentMessage;
        this.pushRunTimeline(runtime, `💬 ${truncate(agentMessage, 140)}`);
        const nextSession = this.store.getSession(conversationId) ?? currentSession;
        await this.refreshRuntimeViews(channel, binding, nextSession, runtime, isThreadConversation);
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
        await this.refreshRuntimeViews(channel, binding, nextSession, runtime, isThreadConversation);
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
        await this.refreshRuntimeViews(channel, binding, nextSession, runtime, isThreadConversation);
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
        await this.refreshRuntimeViews(channel, binding, nextSession, runtime, isThreadConversation);
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

        if (attemptsUsed > 1 && runtime.activeRun && pendingRetryKind) {
          const retryDescription = this.describeRetry(pendingRetryKind, attemptsUsed - 1);
          this.touchActiveRun(runtime.activeRun);
          runtime.activeRun.status = 'starting';
          runtime.activeRun.latestActivity = retryDescription.latestActivity;
          runtime.activeRun.currentCommand = undefined;
          this.pushRunTimeline(runtime, retryDescription.timeline);
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
        }, task.bindingChannelId);
        pendingRecoveryNotice = Boolean(attemptSession.fallbackActive) && job.driverMode === 'app-server';
        this.logCodexAttemptStart(binding, task, conversationId, attemptsUsed, job.pid, existingThreadId);

        await channel.sendTyping().catch(() => undefined);
        await this.refreshRuntimeViews(channel, binding, currentSession, runtime, isThreadConversation);

        result = await job.done;
        const cancellationReason = runtime.activeRun?.cancellationReason;
        const failureDiagnosis = diagnoseCodexFailure(result, cancellationReason);

        this.logCodexAttemptExit(binding, task, conversationId, attemptsUsed, result, failureDiagnosis.retryable, failureDiagnosis.kind);

        if (failureDiagnosis.retryable && attemptsUsed < MAX_CODEX_ATTEMPTS) {
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

            nextSession = await this.store.updateSession(conversationId, { codexThreadId: undefined }, task.bindingChannelId);
          }

          await this.refreshRuntimeViews(channel, binding, nextSession, runtime, isThreadConversation);
          continue;
        }

        break;
      }

      const cancellationReason = runtime.activeRun?.cancellationReason;
      const failureDiagnosis = diagnoseCodexFailure(result, cancellationReason);
      const suppressReply = !result.success && (cancellationReason === 'guidance' || cancellationReason === 'binding_reset' || cancellationReason === 'reset' || cancellationReason === 'unbind');
      let nextSession = this.store.getSession(conversationId) ?? currentSession;

      if (!result.success && failureDiagnosis.retryable) {
        nextSession = await this.store.updateSession(conversationId, { codexThreadId: undefined }, task.bindingChannelId);
      }

      if (runtime.activeRun) {
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
            : failureDiagnosis.diagnosticLines.at(-1) ?? '本轮执行失败';
        this.pushRunTimeline(
          runtime,
          result.success
            ? '🎉 本轮执行完成'
            : cancellationReason === 'guidance'
              ? '🧭 当前步骤已被中途引导打断，准备继续原任务'
              : '🛑 本轮执行失败',
        );
      }

      await this.refreshRuntimeViews(channel, binding, nextSession, runtime, isThreadConversation);
      if (!suppressReply && task.origin !== 'autopilot') {
        await this.safeReplyToOriginalMessage(
          channel,
          task.messageId,
          result.success
            ? formatSuccessReply(binding, task.requestedBy, result)
            : formatFailureReply(binding, task.requestedBy, result),
        );
      }

      if (task.origin === 'autopilot') {
        this.activeAutopilotProjects.delete(task.bindingChannelId);
        await this.finishAutopilotTask(binding, task, result, channel);
      }
    } finally {
      this.activeJobs.delete(conversationId);
      runtime.activeRun = undefined;
      await removeAttachmentDir(task.attachmentDir).catch(() => undefined);
      const nextSession = this.store.getSession(conversationId) ?? currentSession;
      await this.refreshRuntimeViews(channel, binding, nextSession, runtime, isThreadConversation);

      if (task.origin === 'autopilot') {
        this.activeAutopilotProjects.delete(task.bindingChannelId);
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
      case 'transient':
        return attempt >= 2
          ? {
              latestActivity: 'Codex 连接连续中断，bridge 正在放弃当前会话并改用全新会话重试',
              timeline: '🧹 Codex 连接连续中断，bridge 正在放弃当前会话并改用全新会话重试',
              resetThreadBeforeRetry: true,
            }
          : {
              latestActivity: 'Codex 连接中断，bridge 正在继续当前会话并自动重试',
              timeline: '🔁 Codex 连接中断，bridge 正在继续当前会话并自动重试',
              resetThreadBeforeRetry: false,
            };
      case 'unexpected-empty-exit':
      default:
        return attempt >= 2
          ? {
              latestActivity: 'Codex 异常退出且未完成当前轮次，bridge 正在改用全新会话重试',
              timeline: '🧹 Codex 异常退出且未完成当前轮次，bridge 正在改用全新会话重试',
              resetThreadBeforeRetry: true,
            }
          : {
              latestActivity: 'Codex 异常退出，bridge 正在自动重试一次',
              timeline: '🔁 Codex 异常退出，bridge 正在自动重试一次',
              resetThreadBeforeRetry: false,
            };
    }
  }

  private logCodexAttemptStart(
    binding: ChannelBinding,
    task: PromptTask,
    conversationId: string,
    attempt: number,
    pid: number | undefined,
    existingThreadId: string | undefined,
  ): void {
    console.log(
      [
        '[codex-run]',
        `project=${binding.projectName}`,
        `conversation=${conversationId}`,
        `task=${task.id.slice(0, 8)}`,
        `attempt=${attempt}/${MAX_CODEX_ATTEMPTS}`,
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
        `attempt=${attempt}/${MAX_CODEX_ATTEMPTS}`,
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

  private async waitForConversationThreadId(conversationId: string, timeoutMs = 1_500): Promise<string | undefined> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const runtime = this.runtimes.get(conversationId);
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

  private async waitForControllableJob(conversationId: string, timeoutMs = 1_500): Promise<RunningCodexJob | undefined> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const activeJob = this.activeJobs.get(conversationId);

      if (activeJob && !this.isPendingDetachedJob(activeJob)) {
        return activeJob;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const activeJob = this.activeJobs.get(conversationId);
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
      await existingFlush;
      return;
    }

    const flush = this.flushRuntimeViews(conversationId);
    this.runtimeViewFlushes.set(conversationId, flush);
    await flush;
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

  private async safeReplyToOriginalMessage(channel: SendableChannel, messageId: string, content: string): Promise<void> {
    try {
      await this.replyToOriginalMessage(channel, messageId, content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[discord-view] failed to reply to original message id=${messageId} error=${message}`);
    }
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

    const content = formatProgressMessage(binding, runtime, this.config.commandPrefix);
    const progressMessageId = activeRun.progressMessageId;

    if (!progressMessageId) {
      const originalMessage = await channel.messages.fetch(activeRun.task.messageId).catch(() => null);
      const created = originalMessage
        ? await originalMessage.reply(content)
        : await channel.send(content);
      activeRun.progressMessageId = created.id;
      return;
    }

    const existing = await channel.messages.fetch(progressMessageId).catch(() => null);

    if (!existing) {
      const created = await channel.send(content);
      activeRun.progressMessageId = created.id;
      return;
    }

    if (existing.content !== content) {
      await existing.edit(content);
    }
  }

  private async refreshStatusPanel(
    channel: SendableChannel,
    binding: ChannelBinding,
    session: ConversationSessionState,
    runtime: ChannelRuntime,
    isThreadConversation: boolean,
  ): Promise<void> {
    const content = formatStatus(
      binding,
      session,
      runtime,
      this.config.commandPrefix,
      isThreadConversation,
      this.config.codexDriverMode ?? 'app-server',
    );
    const statusMessageId = session.statusMessageId;

    if (!statusMessageId) {
      const created = await channel.send(content);
      await this.store.updateSession(session.conversationId, { statusMessageId: created.id }, session.bindingChannelId);
      return;
    }

    const existing = await channel.messages.fetch(statusMessageId).catch(() => null);

    if (!existing) {
      const created = await channel.send(content);
      await this.store.updateSession(session.conversationId, { statusMessageId: created.id }, session.bindingChannelId);
      return;
    }

    if (existing.content !== content) {
      await existing.edit(content);
    }
  }

  private async replyToOriginalMessage(channel: SendableChannel, messageId: string, content: string): Promise<void> {
    const chunks = splitIntoDiscordChunks(content, 1800);
    const originalMessage = await channel.messages.fetch(messageId).catch(() => null);

    if (!originalMessage) {
      for (const chunk of chunks) {
        await channel.send(chunk);
      }
      return;
    }

    const [firstChunk, ...remainingChunks] = chunks;

    if (firstChunk) {
      await originalMessage.reply(firstChunk);
    }

    for (const chunk of remainingChunks) {
      await channel.send(chunk);
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
