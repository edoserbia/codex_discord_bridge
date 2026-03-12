import { randomUUID } from 'node:crypto';

import {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  type Message,
} from 'discord.js';

import type { AppConfig } from './config.js';
import type { BindCommandOptions, ParsedCommand } from './commandParser.js';
import type { CodexRunner, RunningCodexJob } from './codexRunner.js';
import type {
  ChannelRuntime,
  ChannelBinding,
  ConversationSessionState,
  DashboardBinding,
  DashboardConversation,
  PromptTask,
} from './types.js';

import { buildPromptWithAttachments, downloadAttachments, extractMessageAttachments } from './attachments.js';
import { isCommandMessage, parseCommand } from './commandParser.js';
import { formatFailureReply, formatHelp, formatProjects, formatQueue, formatStatus, formatSuccessReply } from './formatters.js';
import { JsonStateStore } from './store.js';
import { cloneCodexOptions, isWithinAllowedRoots, normalizeAllowedRoots, resolveExistingDirectory, splitIntoDiscordChunks } from './utils.js';

type SendableChannel = {
  id: string;
  parentId?: string | null;
  guildId?: string | null;
  send: (content: string) => Promise<Message>;
  sendTyping: () => Promise<void>;
  messages: {
    fetch: (messageId: string) => Promise<Message>;
  };
};

interface ResolvedConversation {
  binding: ChannelBinding;
  bindingChannelId: string;
  conversationId: string;
  isThreadConversation: boolean;
  channel: SendableChannel;
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

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStateStore,
    private readonly runner: CodexRunner,
  ) {
    this.client.once('ready', () => {
      console.log(`Discord bot connected as ${this.client.user?.tag ?? 'unknown-user'}`);
    });

    this.client.on('messageCreate', (message) => {
      void this.handleMessage(message);
    });
  }

  async start(): Promise<void> {
    await this.client.login(this.config.discordToken);
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

    const savedBinding = await this.store.upsertBinding(binding);
    const session = await this.store.ensureSession(savedBinding.channelId, savedBinding.channelId);
    const runtime = this.getRuntime(savedBinding.channelId);
    const channel = await this.fetchChannel(savedBinding.channelId);

    if (channel) {
      await this.refreshStatusPanel(channel, savedBinding, session, runtime, false);
    }

    return savedBinding;
  }

  async unbindChannel(bindingChannelId: string): Promise<ChannelBinding | undefined> {
    const sessions = this.store.listSessions(bindingChannelId);

    for (const session of sessions) {
      const activeJob = this.activeJobs.get(session.conversationId);
      activeJob?.cancel();
      this.activeJobs.delete(session.conversationId);
      this.runtimes.delete(session.conversationId);
    }

    return this.store.removeBinding(bindingChannelId);
  }

  async resetConversation(conversationId: string, bindingChannelId?: string): Promise<ConversationSessionState> {
    return this.store.updateSession(conversationId, { codexThreadId: undefined }, bindingChannelId);
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
    const savedBinding = await this.bindChannel({
      channelId: message.channelId,
      guildId: message.guildId!,
      projectName,
      workspacePath,
      options,
    });

    await message.reply(
      [`已绑定当前频道到项目 **${savedBinding.projectName}**。`, `目录：\`${savedBinding.workspacePath}\``, '现在主频道和其下线程都可以直接控制 Codex。'].join('\n'),
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
    await message.reply(formatStatus(resolved.binding, session, runtime, this.config.commandPrefix, resolved.isThreadConversation));
  }

  private async handleCancelCommand(message: Message, resolved: ResolvedConversation | undefined): Promise<void> {
    if (!resolved) {
      await message.reply('当前频道没有正在运行的任务。');
      return;
    }

    const runtime = this.getRuntime(resolved.conversationId);
    const activeJob = this.activeJobs.get(resolved.conversationId);

    if (!activeJob || !runtime.activeRun) {
      await message.reply('当前会话没有正在运行的任务。');
      return;
    }

    runtime.activeRun.status = 'cancelled';
    runtime.activeRun.latestActivity = `已由 ${message.author.username} 请求取消`;
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

    const session = await this.resetConversation(resolved.conversationId, resolved.bindingChannelId);
    await this.refreshStatusPanel(resolved.channel, resolved.binding, session, this.getRuntime(resolved.conversationId), resolved.isThreadConversation);
    await message.reply('当前会话的 Codex 上下文已重置。下一条消息会开启新会话。');
  }

  private async enqueuePrompt(message: Message, resolved: ResolvedConversation, prompt: string): Promise<void> {
    const runtime = this.getRuntime(resolved.conversationId);
    const taskId = randomUUID();
    const downloaded = await downloadAttachments(this.config.dataDir, resolved.conversationId, taskId, extractMessageAttachments(message));
    const effectivePrompt = buildPromptWithAttachments(prompt, downloaded.attachments, downloaded.attachmentDir);

    const task: PromptTask = {
      id: taskId,
      prompt,
      effectivePrompt,
      requestedBy: message.author.username,
      requestedById: message.author.id,
      messageId: message.id,
      enqueuedAt: new Date().toISOString(),
      bindingChannelId: resolved.bindingChannelId,
      conversationId: resolved.conversationId,
      attachments: downloaded.attachments,
      attachmentDir: downloaded.attachmentDir,
    };

    runtime.queue.push(task);

    if (runtime.activeRun) {
      await message.react('🕒').catch(() => undefined);
      await message.reply(`已加入队列，前面还有 ${runtime.queue.length - 1} 条请求。`);
    } else {
      await message.react('🤖').catch(() => undefined);
    }

    const session = await this.store.ensureSession(resolved.bindingChannelId, resolved.conversationId);
    await this.refreshStatusPanel(resolved.channel, resolved.binding, session, runtime, resolved.isThreadConversation);
    void this.processQueue(resolved.conversationId);
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

    const channel = await this.fetchChannel(conversationId);

    if (!channel) {
      runtime.queue = [];
      return;
    }

    const session = await this.store.ensureSession(task.bindingChannelId, conversationId);
    const isThreadConversation = conversationId !== task.bindingChannelId;

    runtime.activeRun = {
      task,
      status: 'starting',
      startedAt: new Date().toISOString(),
      latestActivity: '准备启动 Codex',
      agentMessages: [],
      stderr: [],
      usedResume: Boolean(session.codexThreadId),
      codexThreadId: session.codexThreadId,
    };

    const currentSession = await this.store.updateSession(conversationId, {
      lastRunAt: runtime.activeRun.startedAt,
      lastPromptBy: task.requestedBy,
    }, task.bindingChannelId);

    await channel.sendTyping().catch(() => undefined);
    await this.refreshStatusPanel(channel, binding, currentSession, runtime, isThreadConversation);

    const job = this.runner.start(binding, {
      prompt: task.effectivePrompt,
      imagePaths: task.attachments.filter((item) => item.isImage).map((item) => item.localPath),
      extraAddDirs: task.attachmentDir ? [task.attachmentDir] : [],
    }, currentSession.codexThreadId, {
      onThreadStarted: async (codexThreadId) => {
        if (!runtime.activeRun) {
          return;
        }

        runtime.activeRun.codexThreadId = codexThreadId;
        const nextSession = await this.store.updateSession(conversationId, { codexThreadId }, task.bindingChannelId);
        await this.refreshStatusPanel(channel, binding, nextSession, runtime, isThreadConversation);
      },
      onActivity: async (activity) => {
        if (!runtime.activeRun) {
          return;
        }

        runtime.activeRun.status = runtime.activeRun.status === 'cancelled' ? 'cancelled' : 'running';
        runtime.activeRun.latestActivity = activity;
        const nextSession = this.store.getSession(conversationId) ?? currentSession;
        await this.refreshStatusPanel(channel, binding, nextSession, runtime, isThreadConversation);
      },
      onAgentMessage: async (agentMessage) => {
        if (!runtime.activeRun) {
          return;
        }

        runtime.activeRun.agentMessages.push(agentMessage);
        runtime.activeRun.latestActivity = agentMessage;
        const nextSession = this.store.getSession(conversationId) ?? currentSession;
        await this.refreshStatusPanel(channel, binding, nextSession, runtime, isThreadConversation);
      },
      onCommandStarted: async (command) => {
        if (!runtime.activeRun) {
          return;
        }

        runtime.activeRun.status = runtime.activeRun.status === 'cancelled' ? 'cancelled' : 'running';
        runtime.activeRun.currentCommand = command;
        runtime.activeRun.latestActivity = '正在执行命令';
        const nextSession = this.store.getSession(conversationId) ?? currentSession;
        await this.refreshStatusPanel(channel, binding, nextSession, runtime, isThreadConversation);
      },
      onCommandCompleted: async (command, output, exitCode) => {
        if (!runtime.activeRun) {
          return;
        }

        runtime.activeRun.currentCommand = command;
        runtime.activeRun.lastCommandOutput = output;
        runtime.activeRun.latestActivity = exitCode === 0 ? '命令执行完成' : '命令执行失败';
        const nextSession = this.store.getSession(conversationId) ?? currentSession;
        await this.refreshStatusPanel(channel, binding, nextSession, runtime, isThreadConversation);
      },
      onStderr: async (line) => {
        if (!runtime.activeRun) {
          return;
        }

        runtime.activeRun.stderr.push(line);
        runtime.activeRun.latestActivity = line;
        const nextSession = this.store.getSession(conversationId) ?? currentSession;
        await this.refreshStatusPanel(channel, binding, nextSession, runtime, isThreadConversation);
      },
    });

    this.activeJobs.set(conversationId, job);

    try {
      const result = await job.done;
      const nextSession = this.store.getSession(conversationId) ?? currentSession;

      if (runtime.activeRun) {
        runtime.activeRun.exitCode = result.exitCode;
        runtime.activeRun.signal = result.signal;
        runtime.activeRun.codexThreadId = result.codexThreadId;
        runtime.activeRun.status = runtime.activeRun.status === 'cancelled'
          ? 'cancelled'
          : result.success
            ? 'completed'
            : 'failed';
        runtime.activeRun.latestActivity = result.success ? '本轮执行完成' : '本轮执行失败';
      }

      await this.refreshStatusPanel(channel, binding, nextSession, runtime, isThreadConversation);
      await this.replyToOriginalMessage(
        channel,
        task.messageId,
        result.success
          ? formatSuccessReply(binding, task.requestedBy, result)
          : formatFailureReply(binding, task.requestedBy, result),
      );
    } finally {
      this.activeJobs.delete(conversationId);
      runtime.activeRun = undefined;
      const nextSession = this.store.getSession(conversationId) ?? currentSession;
      await this.refreshStatusPanel(channel, binding, nextSession, runtime, isThreadConversation);

      if (runtime.queue.length > 0) {
        void this.processQueue(conversationId);
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

  private async refreshStatusPanel(
    channel: SendableChannel,
    binding: ChannelBinding,
    session: ConversationSessionState,
    runtime: ChannelRuntime,
    isThreadConversation: boolean,
  ): Promise<void> {
    const content = formatStatus(binding, session, runtime, this.config.commandPrefix, isThreadConversation);
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

function isSendableChannel(channel: unknown): channel is SendableChannel {
  return Boolean(
    channel
    && typeof (channel as SendableChannel).send === 'function'
    && typeof (channel as SendableChannel).sendTyping === 'function',
  );
}
