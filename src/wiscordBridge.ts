import { promises as fs } from 'node:fs';
import path from 'node:path';

import WebSocket from 'ws';

import type { AppConfig, WiscordBridgeConfig } from './config.js';
import { isCommandMessage, parseCommand, type ParsedCommand } from './commandParser.js';
import type { CodexExecutionDriver, CodexRunHooks, RunningCodexJob } from './codexRunner.js';
import { extractBridgeFileSendDirective } from './bridgeFileSendProtocol.js';
import { buildPromptWithAttachments } from './attachments.js';
import {
  allocateInboxFilePath,
  allocateUniqueFilePath,
  detectNaturalLanguageFileRequest,
  formatFileCandidates,
  resolveFileRequest,
  type FileTransferCandidate,
} from './fileTransfer.js';
import {
  clearCodexGlobalReasoningEffort,
  loadCodexGlobalModel,
  loadCodexGlobalReasoningEffort,
  resolveCodexConfigPath,
  writeCodexGlobalModel,
  writeCodexGlobalReasoningEffort,
} from './codexConfig.js';
import {
  clearClaudeProjectModel,
  readClaudeGlobalModel,
  readClaudeProjectModel,
  writeClaudeGlobalModel,
  writeClaudeProjectModel,
} from './claudeSettings.js';
import { formatFailureReply, formatHelp, formatProgressMessage, formatSuccessReply } from './formatters.js';
import { appendBridgeProjectContext } from './projectContext.js';
import { JsonStateStore } from './store.js';
import type { ActiveRunState, ChannelBinding, ChannelRuntime, CodexRunResult, PromptTask } from './types.js';
import {
  cloneCodexOptions,
  formatSecondClockTimestamp,
  isWithinAllowedRoots,
  normalizeAllowedRoots,
  resolveDirectoryPath,
  resolveExistingDirectory,
} from './utils.js';

interface WiscordGatewayEvent {
  conversationId?: string | undefined;
  data: Record<string, unknown>;
  eventId: string;
  guildId?: string | undefined;
  occurredAt?: string | undefined;
  sequence: number;
  type: string;
  version: number;
}

interface WiscordGatewayFrame {
  code?: string | undefined;
  event?: WiscordGatewayEvent | undefined;
  heartbeatIntervalMs?: number | undefined;
  op: string;
}

interface WiscordMessage {
  attachments?: Array<{
    contentType: string;
    id: string;
    originalFilename: string;
    sizeBytes: number;
  }>;
  author: { id: string; kind: string };
  content: string;
  conversationId: string;
  guildId: string;
  id: string;
}

interface WiscordCheckpoint {
  lastAckedSequence: number;
  pending: WiscordGatewayEvent[];
  processedEventIds: string[];
}

interface WiscordActiveRun {
  binding: ChannelBinding;
  job?: RunningCodexJob | undefined;
  runtime: ChannelRuntime;
  refreshProgress: () => Promise<void>;
  cancellationReason?: 'guide' | 'cancel' | undefined;
}

const MAX_PROCESSED_EVENT_IDS = 2_000;
const MAX_MESSAGE_CHUNK_BYTES = 240 * 1024;

export class WiscordCodexBridge {
  private readonly wiscord: WiscordBridgeConfig;
  private readonly checkpoint: WiscordCheckpointStore;
  private accessToken = '';
  private socket: WebSocket | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = true;
  private gatewayQueue: Promise<void> = Promise.resolve();
  private readonly eventTasks = new Set<Promise<void>>();
  private readonly taskQueues = new Map<string, Promise<void>>();
  private readonly taskQueueGenerations = new Map<string, number>();
  private readonly activeRuns = new Map<string, WiscordActiveRun>();
  private readonly pendingFileSelections = new Map<string, FileTransferCandidate[]>();
  private readonly scheduledEventIds = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStateStore,
    private readonly runner: CodexExecutionDriver,
  ) {
    if (!config.wiscord) throw new Error('Wiscord bridge configuration is required');
    this.wiscord = config.wiscord;
    this.checkpoint = new WiscordCheckpointStore(path.join(config.dataDir, 'wiscord-checkpoint.json'));
  }

  async start(): Promise<void> {
    this.stopped = false;
    await fs.mkdir(this.wiscord.workspacePath, { recursive: true });
    await this.checkpoint.load();
    await this.ensureBinding();
    await this.connect();
    for (const event of this.checkpoint.pendingEvents()) this.scheduleEvent(event);
    console.log(`Wiscord bridge connected to ${this.wiscord.baseUrl} channel=${this.wiscord.channelId}`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = undefined;
    this.heartbeatTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'bridge stopped');
    await this.gatewayQueue;
    await Promise.all([...this.eventTasks]);
    await Promise.all([...this.taskQueues.values()]);
  }

  private async ensureBinding(): Promise<void> {
    const now = new Date().toISOString();
    const existing = this.store.getBinding(this.wiscord.channelId);
    const binding: ChannelBinding = {
      channelId: this.wiscord.channelId,
      codex: {
        ...this.config.defaultCodex,
        addDirs: [...this.config.defaultCodex.addDirs],
        extraConfig: [...this.config.defaultCodex.extraConfig],
      },
      createdAt: existing?.createdAt ?? now,
      guildId: this.wiscord.guildId,
      projectName: this.wiscord.projectName,
      updatedAt: now,
      workspacePath: this.wiscord.workspacePath,
    };
    await this.store.upsertBinding(binding);
  }

  private async connect(): Promise<void> {
    this.accessToken = await this.exchangeToken();
    const socket = new WebSocket(toGatewayUrl(this.wiscord.baseUrl));
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Wiscord Gateway READY timeout')), 10_000);
      let ready = false;
      const failBeforeReady = (error: Error) => {
        if (!ready) {
          clearTimeout(timeout);
          reject(error);
        }
      };

      socket.once('open', () => {
        socket.send(JSON.stringify({
          lastAckedSequence: this.checkpoint.lastAckedSequence,
          op: 'IDENTIFY',
          token: this.accessToken,
        }));
      });
      socket.on('message', (raw) => {
        let frame: WiscordGatewayFrame;
        try {
          frame = JSON.parse(raw.toString()) as WiscordGatewayFrame;
        } catch {
          return;
        }
        if (frame.op === 'READY') {
          ready = true;
          clearTimeout(timeout);
          this.startHeartbeat(frame.heartbeatIntervalMs ?? 15_000);
          resolve();
          return;
        }
        if (frame.op === 'EVENT' && frame.event) {
          this.gatewayQueue = this.gatewayQueue
            .then(() => this.acceptEvent(frame.event!))
            .catch((error) => {
              console.error('[wiscord] failed to checkpoint Gateway event', error);
            });
          return;
        }
        if (frame.op === 'ERROR') {
          console.error(`[wiscord] Gateway error code=${frame.code ?? 'UNKNOWN'}`);
        }
      });
      socket.once('error', (error) => failBeforeReady(error));
      socket.once('close', (code, reason) => {
        if (this.socket === socket) this.socket = undefined;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
        failBeforeReady(new Error(`Wiscord Gateway closed before READY: ${code} ${reason.toString()}`));
        if (!this.stopped) this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect()
        .then(() => {
          for (const event of this.checkpoint.pendingEvents()) this.scheduleEvent(event);
        })
        .catch((error) => {
          console.error('[wiscord] reconnect failed', error);
          this.scheduleReconnect();
        });
    }, 1_000);
    this.reconnectTimer.unref?.();
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({
          op: 'HEARTBEAT',
          sequence: this.checkpoint.lastAckedSequence,
        }));
      }
    }, Math.max(10, intervalMs));
    this.heartbeatTimer.unref?.();
  }

  private async acceptEvent(event: WiscordGatewayEvent): Promise<void> {
    if (this.stopped) return;
    await this.checkpoint.record(event);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({
        eventId: event.eventId,
        op: 'ACK',
        sequence: event.sequence,
      }));
    }
    this.scheduleEvent(event);
  }

  private scheduleEvent(event: WiscordGatewayEvent): void {
    if (this.checkpoint.isProcessed(event.eventId) || this.scheduledEventIds.has(event.eventId)) return;
    this.scheduledEventIds.add(event.eventId);
    const task = (async () => {
      try {
        await this.processEvent(event);
        await this.checkpoint.complete(event.eventId);
      } catch (error) {
        console.error(`[wiscord] event processing failed event=${event.eventId}`, error);
      } finally {
        this.scheduledEventIds.delete(event.eventId);
      }
    })();
    this.eventTasks.add(task);
    void task.finally(() => this.eventTasks.delete(task));
  }

  private async processEvent(event: WiscordGatewayEvent): Promise<void> {
    if (
      event.type !== 'MESSAGE_CREATE'
      || event.guildId !== this.wiscord.guildId
    ) {
      return;
    }
    const messageId = typeof event.data.messageId === 'string' ? event.data.messageId : '';
    if (!messageId) return;
    const message = await this.api<WiscordMessage>(`/bot/v1/messages/${encodeURIComponent(messageId)}`, { method: 'GET' });
    if (
      message.author.kind !== 'user'
      || message.guildId !== this.wiscord.guildId
      || !message.content.trim()
    ) {
      return;
    }
    if (isCommandMessage(message.content, this.config.commandPrefix)) {
      await this.handleCommand(message);
      return;
    }
    const fileRequest = detectNaturalLanguageFileRequest(message.content);
    if (fileRequest) {
      const binding = this.store.getBinding(message.conversationId);
      if (!binding) {
        await this.sendText(message.conversationId, '当前频道未绑定项目。先执行 `!bind`。');
        return;
      }
      await this.handleSendFileRequest(message, binding, fileRequest);
      return;
    }
    const binding = this.store.getBinding(message.conversationId);
    if (!binding) {
      await this.sendText(message.conversationId, `当前频道未绑定项目。先执行 \`${this.config.commandPrefix}help\` 查看命令。`);
      return;
    }
    await this.enqueueRun(message, binding);
  }

  private async handleCommand(message: WiscordMessage): Promise<void> {
    try {
      const command = parseCommand(message.content, this.config.commandPrefix);
      switch (command.kind) {
        case 'help':
          await this.sendText(message.conversationId, formatHelp(this.config.commandPrefix));
          return;
        case 'bind':
          this.assertAdministrator(message);
          await this.bindChannel(message, command.projectName, command.workspacePath, command.options.engine);
          return;
        case 'unbind': {
          this.assertAdministrator(message);
          await this.cancelConversation(message.conversationId, '解绑项目');
          const removed = await this.store.removeBinding(message.conversationId);
          await this.sendText(
            message.conversationId,
            removed
              ? `已解除频道与项目 **${removed.projectName}** 的绑定。`
              : '当前频道没有项目绑定。',
          );
          return;
        }
        case 'status': {
          await this.handleStatusCommand(message);
          return;
        }
        case 'guide':
          await this.handleGuideCommand(message, command.prompt);
          return;
        case 'cancel':
          this.assertAdministrator(message);
          await this.handleCancelCommand(message);
          return;
        case 'model':
          await this.handleModelCommand(message, command);
          return;
        case 'claude-model':
          await this.handleClaudeModelCommand(message, command);
          return;
        case 'effort':
          await this.handleEffortCommand(message, command);
          return;
        case 'reset': {
          this.assertAdministrator(message);
          const binding = this.store.getBinding(message.conversationId);
          if (!binding) {
            await this.sendText(message.conversationId, '当前频道未绑定项目。');
            return;
          }
          await this.cancelConversation(message.conversationId, '重置会话');
          await this.store.updateSession(message.conversationId, {
            claudeSessionId: undefined,
            codexThreadId: undefined,
            driver: undefined,
            fallbackActive: undefined,
            lastEngine: undefined,
          }, binding.channelId);
          await this.sendText(message.conversationId, '已重置当前频道的 Codex/Claude 会话。');
          return;
        }
        case 'projects': {
          const bindings = this.store.listBindings(message.guildId);
          await this.sendText(
            message.conversationId,
            bindings.length === 0
              ? '当前服务器还没有已绑定项目的频道。'
              : ['# 已绑定项目', '', ...bindings.map((binding) => `- **${binding.projectName}**：\`${binding.workspacePath}\``)].join('\n'),
          );
          return;
        }
        case 'sendfile': {
          const binding = this.store.getBinding(message.conversationId);
          if (!binding) {
            await this.sendText(message.conversationId, '当前频道未绑定项目。先执行 `!bind`。');
            return;
          }
          if ('index' in command) {
            const candidates = this.pendingFileSelections.get(message.conversationId);
            const candidate = candidates?.[command.index - 1];
            if (!candidate) {
              await this.sendText(message.conversationId, '当前没有对应的文件候选。先使用 `!sendfile <文件名>` 或发送自然语言请求。');
              return;
            }
            this.pendingFileSelections.delete(message.conversationId);
            await this.sendFile(message.conversationId, candidate.absolutePath, `已发送第 ${command.index} 个文件：${candidate.name}`);
            return;
          }
          await this.handleSendFileRequest(message, binding, command.request);
          return;
        }
        case 'prompt': {
          const binding = this.store.getBinding(message.conversationId);
          if (!binding) {
            await this.sendText(message.conversationId, '当前频道未绑定项目。先执行 `!bind <项目名> <工作区目录>`。');
            return;
          }
          await this.enqueueRun(message, binding, { engine: command.engine, prompt: command.prompt });
          return;
        }
        default:
          await this.sendText(message.conversationId, `该 Wiscord 命令尚未实现。执行 \`${this.config.commandPrefix}help\` 查看可用命令。`);
      }
    } catch (error) {
      await this.sendText(
        message.conversationId,
        `命令执行失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private assertAdministrator(message: WiscordMessage): void {
    if (!this.wiscord.adminUserIds.has(message.author.id)) {
      throw new Error('当前 Wiscord 用户没有管理权限。请在 Bridge 配置中设置 WISCORD_ADMIN_USER_IDS。');
    }
  }

  private async bindChannel(
    message: WiscordMessage,
    projectName: string,
    workspacePath: string,
    engine: ChannelBinding['engine'],
  ): Promise<void> {
    const allowedRoots = await normalizeAllowedRoots(this.config.allowedWorkspaceRoots);
    const targetWorkspace = await resolveDirectoryPath(workspacePath);
    if (!isWithinAllowedRoots(targetWorkspace, allowedRoots)) {
      throw new Error(`目录不在允许的工作区根目录下：${targetWorkspace}`);
    }
    await fs.mkdir(targetWorkspace, { recursive: true });
    const resolvedWorkspace = await resolveExistingDirectory(targetWorkspace);
    const existing = this.store.getBinding(message.conversationId);
    const now = new Date().toISOString();
    const binding: ChannelBinding = {
      channelId: message.conversationId,
      codex: cloneCodexOptions(this.config.defaultCodex),
      createdAt: existing?.createdAt ?? now,
      engine,
      guildId: message.guildId,
      projectName,
      updatedAt: now,
      workspacePath: resolvedWorkspace,
    };
    await this.store.upsertBinding(binding);
    await this.store.updateSession(message.conversationId, {
      claudeSessionId: undefined,
      codexThreadId: undefined,
      driver: undefined,
      fallbackActive: undefined,
      lastEngine: undefined,
    }, binding.channelId);
    await this.sendText(
      message.conversationId,
      [
        `已绑定当前频道到项目 **${binding.projectName}**。`,
        `目录：\`${binding.workspacePath}\``,
        `引擎：${binding.engine ?? 'codex'}`,
        '现在可以直接发送任务；Bridge 会持续更新过程，并在完成后发送最终结果。',
      ].join('\n'),
    );
  }

  private async handleSendFileRequest(
    message: WiscordMessage,
    binding: ChannelBinding,
    request: string,
  ): Promise<void> {
    const resolved = await resolveFileRequest({
      allowAbsolutePath: this.wiscord.adminUserIds.has(message.author.id),
      request,
      workspacePath: binding.workspacePath,
    });
    if (resolved.kind === 'single') {
      this.pendingFileSelections.delete(message.conversationId);
      await this.sendFile(message.conversationId, resolved.file.absolutePath, `已发送文件：${resolved.file.name}`);
      return;
    }
    if (resolved.kind === 'candidates') {
      this.pendingFileSelections.set(message.conversationId, resolved.candidates);
      await this.sendText(message.conversationId, formatFileCandidates(resolved.candidates, { commandPrefix: this.config.commandPrefix }));
      return;
    }
    await this.sendText(message.conversationId, resolved.message);
  }

  private enqueueRun(
    message: WiscordMessage,
    binding: ChannelBinding,
    options: { engine?: ChannelBinding['engine']; prompt?: string } = {},
  ): Promise<void> {
    const conversationId = message.conversationId;
    const generation = this.taskQueueGenerations.get(conversationId) ?? 0;
    const previous = this.taskQueues.get(conversationId) ?? Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(async () => {
        if (generation !== (this.taskQueueGenerations.get(conversationId) ?? 0)) return;
        await this.runMessage(message, binding, options);
      });
    this.taskQueues.set(conversationId, queued);
    void queued.finally(() => {
      if (this.taskQueues.get(conversationId) === queued) this.taskQueues.delete(conversationId);
    });
    return queued;
  }

  private async handleStatusCommand(message: WiscordMessage): Promise<void> {
    const binding = this.store.getBinding(message.conversationId);
    if (!binding) {
      await this.sendText(message.conversationId, '当前频道未绑定项目。先执行 `!bind <项目名> <工作区目录>`。');
      return;
    }
    const active = this.activeRuns.get(message.conversationId);
    if (active) {
      await this.sendText(message.conversationId, formatProgressMessage(
        binding,
        active.runtime,
        this.config.commandPrefix,
        this.config.codexDriverMode ?? 'app-server',
      ));
      return;
    }
    const session = this.store.getSession(message.conversationId);
    const queued = this.taskQueues.has(message.conversationId) ? '有等待任务' : '空闲';
    await this.sendText(message.conversationId, [
      `项目：**${binding.projectName}**`,
      `目录：\`${binding.workspacePath}\``,
      `引擎：${binding.engine ?? 'codex'}`,
      `状态：${queued}`,
      `Codex thread：${session?.codexThreadId ?? '尚未创建'}`,
    ].join('\n'));
  }

  private async handleGuideCommand(message: WiscordMessage, prompt: string): Promise<void> {
    const active = this.activeRuns.get(message.conversationId);
    if (!active) {
      await this.sendText(message.conversationId, '当前没有正在运行的任务。直接发送普通消息即可，或先启动一个任务后再使用 `!guide`。');
      return;
    }
    const activeRun = active.runtime.activeRun!;
    activeRun.task.guidancePrompt = prompt;
    activeRun.latestActivity = '收到中途引导，继续当前任务';
    activeRun.updatedAt = new Date().toISOString();
    activeRun.timeline = [...activeRun.timeline, `🧭 收到新的引导：${prompt}`].slice(-20);
    await active.refreshProgress();
    if (active.job?.steer) {
      await active.job.steer(prompt);
      await this.sendText(message.conversationId, '已将你的新消息作为引导项插入当前工作，当前引擎会在本轮继续处理中途引导。');
      return;
    }

    active.cancellationReason = 'guide';
    activeRun.status = 'cancelled';
    activeRun.latestActivity = '正在中断当前步骤，优先处理中途引导';
    await active.refreshProgress();
    const guidedMessage: WiscordMessage = {
      ...message,
      content: `当前任务：${activeRun.task.rootPrompt}\n\n中途引导：${prompt}`,
    };
    void this.enqueueRun(guidedMessage, active.binding).catch((error) => {
      console.error('[wiscord] failed to queue guided task', error);
    });
    active.job?.cancel();
    await this.sendText(message.conversationId, '已将你的新消息插入当前工作，正在中断当前步骤并优先处理引导。');
  }

  private async handleCancelCommand(message: WiscordMessage): Promise<void> {
    const active = this.activeRuns.get(message.conversationId);
    if (!active) {
      await this.sendText(message.conversationId, '当前会话没有正在运行的任务。');
      return;
    }
    this.taskQueueGenerations.set(
      message.conversationId,
      (this.taskQueueGenerations.get(message.conversationId) ?? 0) + 1,
    );
    active.cancellationReason = 'cancel';
    const activeRun = active.runtime.activeRun!;
    activeRun.status = 'cancelled';
    activeRun.latestActivity = `已由 ${message.author.id} 请求取消`;
    activeRun.updatedAt = new Date().toISOString();
    activeRun.timeline = [...activeRun.timeline, '🛑 已发送取消信号'].slice(-20);
    await active.refreshProgress();
    active.job?.cancel();
    await this.sendText(message.conversationId, '已发送取消信号给当前 Codex 任务，并清空等待队列。');
  }

  private async cancelConversation(conversationId: string, reason: string): Promise<void> {
    this.taskQueueGenerations.set(
      conversationId,
      (this.taskQueueGenerations.get(conversationId) ?? 0) + 1,
    );
    const active = this.activeRuns.get(conversationId);
    if (!active) return;
    active.cancellationReason = 'cancel';
    const activeRun = active.runtime.activeRun;
    if (activeRun) {
      activeRun.status = 'cancelled';
      activeRun.latestActivity = `${reason}，已中止当前任务`;
      activeRun.updatedAt = new Date().toISOString();
      activeRun.timeline = [...activeRun.timeline, `🛑 ${reason}`].slice(-20);
      await active.refreshProgress();
    }
    active.job?.cancel();
  }

  private getCodexConfigPath(): string {
    return resolveCodexConfigPath(this.config.codexConfigPath);
  }

  private async handleModelCommand(
    message: WiscordMessage,
    command: Extract<ParsedCommand, { kind: 'model' }>,
  ): Promise<void> {
    const engine = command.engine ?? this.store.getBinding(message.conversationId)?.engine ?? 'codex';
    if (engine === 'claude') {
      await this.handleClaudeModelCommand(message, {
        kind: 'claude-model',
        scope: command.scope,
        action: command.action,
        ...(command.action === 'set' ? { model: command.model } : {}),
      } as Extract<ParsedCommand, { kind: 'claude-model' }>);
      return;
    }
    if (command.action !== 'status') this.assertAdministrator(message);
    const configPath = this.getCodexConfigPath();
    if (command.scope === 'global') {
      if (command.action === 'status') {
        const model = await loadCodexGlobalModel(configPath);
        await this.sendText(message.conversationId, `🧠 **Codex 全局模型**\n全局模型：${model ? `\`${model}\`` : '未显式设置'}\n配置文件：\`${configPath}\``);
        return;
      }
      await writeCodexGlobalModel(configPath, command.model);
      this.config.defaultCodex.model = command.model;
      for (const binding of this.store.listBindings()) {
        if ((binding.engine ?? 'codex') !== 'codex') continue;
        await this.store.upsertBinding({ ...binding, codex: { ...binding.codex, model: command.model }, modelScope: 'global', updatedAt: new Date().toISOString() });
      }
      await this.sendText(message.conversationId, `已切换全局 Codex 模型为 \`${command.model}\`。运行中的任务不受影响，下一轮生效。`);
      return;
    }
    const binding = this.store.getBinding(message.conversationId);
    if (!binding) {
      await this.sendText(message.conversationId, '当前频道未绑定项目。先执行 `!bind`。');
      return;
    }
    const globalModel = await loadCodexGlobalModel(configPath);
    if (command.action === 'status') {
      await this.sendText(message.conversationId, `🧠 **Codex 项目模型**\n项目：**${binding.projectName}**\n项目模型：${binding.codex.model ? `\`${binding.codex.model}\`` : '跟随全局'}\n全局模型：${globalModel ? `\`${globalModel}\`` : '未显式设置'}\n当前生效：${binding.codex.model ? `\`${binding.codex.model}\`` : globalModel ? `\`${globalModel}\`` : 'Codex 默认配置'}`);
      return;
    }
    const codex = { ...binding.codex };
    if (command.action === 'set') codex.model = command.model;
    else delete codex.model;
    await this.store.upsertBinding({ ...binding, codex, modelScope: command.action === 'set' ? 'project' : undefined, updatedAt: new Date().toISOString() });
    await this.sendText(message.conversationId, command.action === 'set'
      ? `已将当前项目切换到 Codex 模型 \`${command.model}\`，下一轮生效。`
      : '已清除当前项目的 Codex 模型覆盖，下一轮跟随全局。');
  }

  private async handleClaudeModelCommand(
    message: WiscordMessage,
    command: Extract<ParsedCommand, { kind: 'claude-model' }>,
  ): Promise<void> {
    if (command.action !== 'status') this.assertAdministrator(message);
    if (command.scope === 'global') {
      if (command.action === 'status') {
        const model = await readClaudeGlobalModel(this.config.claudeSettingsPath);
        await this.sendText(message.conversationId, `🧠 **Claude 全局模型**\n全局模型：${model ? `\`${model}\`` : '未显式设置'}`);
        return;
      }
      await writeClaudeGlobalModel(this.config.claudeSettingsPath, command.model);
      await this.sendText(message.conversationId, `已切换全局 Claude 模型为 \`${command.model}\`，下一轮生效。`);
      return;
    }
    const binding = this.store.getBinding(message.conversationId);
    if (!binding) {
      await this.sendText(message.conversationId, '当前频道未绑定项目。先执行 `!bind`。');
      return;
    }
    if (command.action === 'status') {
      const [projectModel, globalModel] = await Promise.all([
        readClaudeProjectModel(binding.workspacePath), readClaudeGlobalModel(this.config.claudeSettingsPath),
      ]);
      await this.sendText(message.conversationId, `🧠 **Claude 项目模型**\n项目：**${binding.projectName}**\n项目模型：${projectModel ? `\`${projectModel}\`` : '跟随全局'}\n全局模型：${globalModel ? `\`${globalModel}\`` : '未显式设置'}`);
      return;
    }
    if (command.action === 'set') {
      await writeClaudeProjectModel(binding.workspacePath, command.model);
      await this.sendText(message.conversationId, `已将当前项目切换到 Claude 模型 \`${command.model}\`，下一轮生效。`);
    } else {
      await clearClaudeProjectModel(binding.workspacePath);
      await this.sendText(message.conversationId, '已清除当前项目的 Claude 模型覆盖，下一轮跟随全局。');
    }
  }

  private async handleEffortCommand(
    message: WiscordMessage,
    command: Extract<ParsedCommand, { kind: 'effort' }>,
  ): Promise<void> {
    if (command.action !== 'status') this.assertAdministrator(message);
    const configPath = this.getCodexConfigPath();
    if (command.scope === 'global') {
      if (command.action === 'status') {
        const effort = await loadCodexGlobalReasoningEffort(configPath);
        await this.sendText(message.conversationId, `🧠 **Codex 全局推理强度**\n当前设置：${effort ? `\`${effort}\`` : '未显式设置'}\n配置文件：\`${configPath}\``);
        return;
      }
      if (command.action === 'set') {
        await writeCodexGlobalReasoningEffort(configPath, command.effort);
        await this.sendText(message.conversationId, `已将 Codex 全局推理强度设为 \`${command.effort}\`，下一轮生效。`);
      } else {
        await clearCodexGlobalReasoningEffort(configPath);
        await this.sendText(message.conversationId, '已清除 Codex 全局推理强度，下一轮使用默认配置。');
      }
      return;
    }
    const binding = this.store.getBinding(message.conversationId);
    if (!binding) {
      await this.sendText(message.conversationId, '当前频道未绑定项目。先执行 `!bind`。');
      return;
    }
    if (command.action === 'status') {
      const globalEffort = await loadCodexGlobalReasoningEffort(configPath);
      await this.sendText(message.conversationId, `🧠 **Codex 项目推理强度**\n项目：**${binding.projectName}**\n项目设置：${binding.codex.reasoningEffort ? `\`${binding.codex.reasoningEffort}\`` : '跟随全局'}\n全局设置：${globalEffort ? `\`${globalEffort}\`` : '未显式设置'}`);
      return;
    }
    const codex = { ...binding.codex };
    if (command.action === 'set') codex.reasoningEffort = command.effort;
    else delete codex.reasoningEffort;
    await this.store.upsertBinding({ ...binding, codex, reasoningEffortScope: command.action === 'set' ? 'project' : undefined, updatedAt: new Date().toISOString() });
    await this.sendText(message.conversationId, command.action === 'set'
      ? `已将当前项目推理强度设为 \`${command.effort}\`，下一轮生效。`
      : '已清除当前项目推理强度覆盖，下一轮跟随全局。');
  }

  private async runMessage(
    message: WiscordMessage,
    binding: ChannelBinding,
    options: { engine?: ChannelBinding['engine']; prompt?: string } = {},
  ): Promise<void> {
    const runBinding = options.engine ? { ...binding, engine: options.engine } : binding;
    const runMessage = options.prompt ? { ...message, content: options.prompt } : message;
    const session = await this.store.ensureSession(binding.channelId, message.conversationId);
    const reply = await this.api<{ messageId: string }>('/bot/v1/messages', {
      body: JSON.stringify({ conversationId: message.conversationId }),
      method: 'POST',
    });
    let progressChain = Promise.resolve();
    const updateProgress = (content: string) => {
      progressChain = progressChain.then(() => this.editMessage(reply.messageId, content));
      return progressChain;
    };
    const runtime = createWiscordRuntime(runMessage, runBinding, this.config.codexDriverMode ?? 'app-server');
    const downloaded = await this.downloadAttachments(runMessage, runBinding);
    runtime.activeRun!.task.attachments = downloaded.attachments;
    const activeRun = runtime.activeRun!;
    const refreshProgress = () => updateProgress(formatProgressMessage(
      runBinding,
      runtime,
      this.config.commandPrefix,
      this.config.codexDriverMode ?? 'app-server',
    ));
    const touch = (activity?: string) => {
      activeRun.updatedAt = new Date().toISOString();
      if (activity) activeRun.latestActivity = activity;
    };
    const pushTimeline = (entry: string) => {
      activeRun.timeline = [...activeRun.timeline, entry].slice(-20);
    };

    await refreshProgress();
    const activeControl: WiscordActiveRun = { binding: runBinding, refreshProgress, runtime };
    this.activeRuns.set(message.conversationId, activeControl);
    const hooks: CodexRunHooks = {
      onActivity: async (activity) => {
        touch(activity);
        activeRun.status = activeRun.status === 'cancelled' ? 'cancelled' : 'running';
        pushTimeline(`🔄 ${activity}`);
        await refreshProgress();
      },
      onReasoning: async (reasoning) => {
        touch('正在分析请求');
        activeRun.reasoningSummaries = [...activeRun.reasoningSummaries, reasoning].slice(-6);
        pushTimeline(`🔄 正在分析请求`);
        await refreshProgress();
      },
      onTodoListChanged: async (items) => {
        touch(`计划进度 ${items.filter((item) => item.completed).length}/${items.length}`);
        activeRun.planItems = items;
        pushTimeline(`📋 ${activeRun.latestActivity}`);
        await refreshProgress();
      },
      onCollabToolChanged: async (item) => {
        touch('子代理状态已更新');
        const existing = activeRun.collabToolCalls.findIndex((candidate) => candidate.id === item.id);
        if (existing >= 0) {
          activeRun.collabToolCalls[existing] = item;
        } else {
          activeRun.collabToolCalls = [...activeRun.collabToolCalls, item].slice(-12);
        }
        pushTimeline('🤝 子代理状态已更新');
        await refreshProgress();
      },
      onAgentMessage: async (content) => {
        touch('正在生成回答');
        activeRun.agentMessages = [...activeRun.agentMessages, content].slice(-6);
        pushTimeline('🔄 正在生成回答');
        await refreshProgress();
      },
      onCommandStarted: async (command) => {
        touch('正在执行命令');
        activeRun.currentCommand = command;
        activeRun.currentCommandStartedAt = activeRun.updatedAt;
        activeRun.status = 'running';
        pushTimeline(`▶️ ${formatSecondClockTimestamp(activeRun.currentCommandStartedAt)} ${command}`);
        await refreshProgress();
      },
      onCommandCompleted: async (command, output, exitCode) => {
        touch(exitCode === 0 ? '命令执行完成' : '命令执行失败');
        activeRun.currentCommand = command;
        activeRun.lastCommandOutput = output;
        activeRun.lastCommandCompletedAt = activeRun.updatedAt;
        pushTimeline(`${exitCode === 0 ? '✅' : '❌'} ${formatSecondClockTimestamp(activeRun.lastCommandCompletedAt)} ${command} (${exitCode ?? 'null'})`);
        await refreshProgress();
      },
      onStderr: async (line) => {
        touch(line);
        activeRun.stderr = [...activeRun.stderr, line].slice(-20);
        pushTimeline(`⚠️ ${line}`);
        await refreshProgress();
      },
      onThreadStarted: async (threadId) => {
        touch();
        activeRun.codexThreadId = threadId;
        activeRun.status = 'running';
        pushTimeline(`🧵 Codex 会话已建立：${threadId.slice(0, 8)}`);
        await this.store.updateSession(message.conversationId, {
          codexThreadId: threadId,
          lastEngine: runBinding.engine ?? 'codex',
        }, binding.channelId);
        await refreshProgress();
      },
    };
    try {
      const job = this.runner.start(
        runBinding,
        {
          ...(options.engine ? { engine: options.engine } : {}),
          imagePaths: [],
          extraAddDirs: [],
          prompt: appendBridgeProjectContext(
            buildPromptWithAttachments(runMessage.content, downloaded.attachments, downloaded.attachmentDir),
            runBinding,
          ),
        },
        session.codexThreadId,
        hooks,
      );
      activeControl.job = job;
      if (activeControl.cancellationReason) job.cancel();
      const result = await job.done;
      const controlledCancellation = activeControl.cancellationReason;
    touch(result.success ? '本轮已完成' : '本轮失败');
    activeRun.status = controlledCancellation ? 'cancelled' : result.success ? 'completed' : 'failed';
    activeRun.exitCode = result.exitCode;
    activeRun.signal = result.signal;
    activeRun.codexThreadId = result.codexThreadId ?? activeRun.codexThreadId;
    activeRun.claudeSessionId = result.claudeSessionId ?? activeRun.claudeSessionId;
    activeRun.agentMessages = result.agentMessages.length > 0 ? result.agentMessages.slice(-6) : activeRun.agentMessages;
    activeRun.planItems = result.planItems.length > 0 ? result.planItems : activeRun.planItems;
    activeRun.reasoningSummaries = result.reasoning.length > 0 ? result.reasoning.slice(-6) : activeRun.reasoningSummaries;
    activeRun.stderr = result.stderr.length > 0 ? result.stderr.slice(-20) : activeRun.stderr;
    if (result.commands.length > 0) {
      const lastCommand = result.commands.at(-1)!;
      activeRun.currentCommand = lastCommand.command;
      activeRun.lastCommandOutput = lastCommand.output;
    }
    pushTimeline(
      controlledCancellation === 'guide'
        ? '🧭 当前步骤已被中途引导打断，准备优先处理引导'
        : controlledCancellation === 'cancel'
          ? '🛑 当前任务已取消'
          : result.success ? '✅ 本轮已完成' : '❌ 本轮失败',
    );
    await refreshProgress();
    await progressChain;
    await this.store.updateSession(message.conversationId, {
      codexThreadId: result.codexThreadId ?? session.codexThreadId,
      driver: job.driverMode === 'app-server' || job.driverMode === 'legacy-exec' ? job.driverMode : undefined,
      lastEngine: result.engine ?? 'codex',
      lastPromptBy: message.author.id,
      lastRunAt: new Date().toISOString(),
    }, binding.channelId);

    if (controlledCancellation) {
      await this.finalizeText(reply.messageId, formatProgressMessage(
        runBinding,
        runtime,
        this.config.commandPrefix,
        this.config.codexDriverMode ?? 'app-server',
      ));
      return;
    }

    const finalContent = result.success
      ? formatSuccessReply(runBinding, message.author.id, result, { finalMessage: visibleAssistantMessage(result) })
      : formatFailureReply(runBinding, message.author.id, result);
    await this.finalizeText(reply.messageId, formatProgressMessage(
      runBinding,
      runtime,
      this.config.commandPrefix,
      this.config.codexDriverMode ?? 'app-server',
    ));
    await this.sendText(message.conversationId, finalContent);
    } finally {
      if (this.activeRuns.get(message.conversationId) === activeControl) {
        this.activeRuns.delete(message.conversationId);
      }
    }
  }

  private async editMessage(messageId: string, content: string): Promise<void> {
    await this.api(`/bot/v1/messages/${encodeURIComponent(messageId)}`, {
      body: JSON.stringify({ content }),
      method: 'PATCH',
    });
  }

  private async downloadAttachments(
    message: WiscordMessage,
    binding: ChannelBinding,
  ): Promise<{ attachmentDir?: string; attachments: PromptTask['attachments'] }> {
    if (!message.attachments?.length) return { attachments: [] };
    const attachmentDir = path.join(this.config.dataDir, 'attachments', message.conversationId, message.id);
    await fs.mkdir(attachmentDir, { recursive: true });
    const attachments: PromptTask['attachments'] = [];
    for (const attachment of message.attachments) {
      const fileName = path.basename(attachment.originalFilename).replace(/[\x00-\x1f\x7f]/g, '') || 'attachment';
      const localPath = await allocateUniqueFilePath(attachmentDir, fileName);
      const response = await this.apiResponse(`/bot/v1/attachments/${encodeURIComponent(attachment.id)}`, { method: 'GET' });
      await fs.writeFile(localPath, Buffer.from(await response.arrayBuffer()));
      const workspaceLocalPath = await allocateInboxFilePath(binding.workspacePath, path.basename(localPath));
      await fs.copyFile(localPath, workspaceLocalPath);
      attachments.push({
        contentType: attachment.contentType,
        isImage: attachment.contentType.startsWith('image/'),
        localPath,
        name: path.basename(localPath),
        size: attachment.sizeBytes,
        sourceUrl: `wiscord:${attachment.id}`,
        workspaceLocalPath,
      });
    }
    return { attachmentDir, attachments };
  }

  private async sendText(conversationId: string, content: string): Promise<void> {
    const reply = await this.api<{ messageId: string }>('/bot/v1/messages', {
      body: JSON.stringify({ conversationId }),
      method: 'POST',
    });
    await this.finalizeText(reply.messageId, content);
  }

  private async sendFile(conversationId: string, filePath: string, caption: string): Promise<void> {
    const data = await fs.readFile(filePath);
    const reply = await this.api<{ messageId: string }>('/bot/v1/messages', {
      body: JSON.stringify({ conversationId }),
      method: 'POST',
    });
    const form = new FormData();
    form.append('file', new Blob([data]), path.basename(filePath));
    const attachment = await this.apiMultipart<{ id: string }>(
      `/bot/v1/conversations/${encodeURIComponent(conversationId)}/attachments`,
      form,
    );
    await this.api(`/bot/v1/messages/${encodeURIComponent(reply.messageId)}/attachments`, {
      body: JSON.stringify({ attachmentId: attachment.id }),
      method: 'POST',
    });
    await this.finalizeText(reply.messageId, caption);
  }

  private async finalizeText(messageId: string, content: string): Promise<void> {
    const chunks = splitUtf8(content, MAX_MESSAGE_CHUNK_BYTES);
    for (const [index, chunk] of chunks.entries()) {
      await this.api(`/bot/v1/messages/${encodeURIComponent(messageId)}/chunks`, {
        body: JSON.stringify({ content: chunk, index }),
        method: 'POST',
      });
    }
    await this.api(`/bot/v1/messages/${encodeURIComponent(messageId)}/finalize`, { method: 'POST' });
  }

  private async exchangeToken(): Promise<string> {
    const response = await this.request<{ accessToken: string }>('/bot/v1/auth/token', {
      body: JSON.stringify({ appId: this.wiscord.appId, appSecret: this.wiscord.appSecret }),
      method: 'POST',
    }, false);
    return response.accessToken;
  }

  private async api<T = unknown>(route: string, init: RequestInit): Promise<T> {
    try {
      return await this.request<T>(route, init, true);
    } catch (error) {
      if (!(error instanceof WiscordHttpError) || error.status !== 401) throw error;
      this.accessToken = await this.exchangeToken();
      return this.request<T>(route, init, true);
    }
  }

  private async apiResponse(route: string, init: RequestInit): Promise<Response> {
    const request = async () => {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${this.accessToken}`);
      const response = await fetch(`${this.wiscord.baseUrl}${route}`, { ...init, headers });
      if (!response.ok) throw new WiscordHttpError(response.status, (await response.text()).slice(0, 500));
      return response;
    };
    try {
      return await request();
    } catch (error) {
      if (!(error instanceof WiscordHttpError) || error.status !== 401) throw error;
      this.accessToken = await this.exchangeToken();
      return request();
    }
  }

  private async apiMultipart<T>(route: string, body: FormData): Promise<T> {
    const request = async () => {
      const response = await fetch(`${this.wiscord.baseUrl}${route}`, {
        body,
        headers: { authorization: `Bearer ${this.accessToken}` },
        method: 'POST',
      });
      if (!response.ok) throw new WiscordHttpError(response.status, (await response.text()).slice(0, 500));
      return await response.json() as T;
    };
    try {
      return await request();
    } catch (error) {
      if (!(error instanceof WiscordHttpError) || error.status !== 401) throw error;
      this.accessToken = await this.exchangeToken();
      return request();
    }
  }

  private async request<T>(route: string, init: RequestInit, authenticated: boolean): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body) headers.set('content-type', 'application/json');
    if (authenticated) headers.set('authorization', `Bearer ${this.accessToken}`);
    const response = await fetch(`${this.wiscord.baseUrl}${route}`, { ...init, headers });
    if (!response.ok) {
      const body = await response.text();
      throw new WiscordHttpError(response.status, body.slice(0, 500));
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
}

class WiscordHttpError extends Error {
  constructor(readonly status: number, body: string) {
    super(`Wiscord HTTP ${status}: ${body}`);
  }
}

class WiscordCheckpointStore {
  private state: WiscordCheckpoint = { lastAckedSequence: 0, pending: [], processedEventIds: [] };

  constructor(private readonly filePath: string) {}

  get lastAckedSequence(): number {
    return this.state.lastAckedSequence;
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<WiscordCheckpoint>;
      this.state = {
        lastAckedSequence: Number.isInteger(parsed.lastAckedSequence) ? parsed.lastAckedSequence! : 0,
        pending: Array.isArray(parsed.pending) ? parsed.pending : [],
        processedEventIds: Array.isArray(parsed.processedEventIds) ? parsed.processedEventIds : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.save();
    }
  }

  pendingEvents(): WiscordGatewayEvent[] {
    return this.state.pending.map((event) => structuredClone(event));
  }

  isProcessed(eventId: string): boolean {
    return this.state.processedEventIds.includes(eventId);
  }

  async record(event: WiscordGatewayEvent): Promise<void> {
    this.state.lastAckedSequence = Math.max(this.state.lastAckedSequence, event.sequence);
    if (!this.isProcessed(event.eventId) && !this.state.pending.some((candidate) => candidate.eventId === event.eventId)) {
      this.state.pending.push(structuredClone(event));
    }
    await this.save();
  }

  async complete(eventId: string): Promise<void> {
    this.state.pending = this.state.pending.filter((event) => event.eventId !== eventId);
    if (!this.isProcessed(eventId)) this.state.processedEventIds.push(eventId);
    this.state.processedEventIds = this.state.processedEventIds.slice(-MAX_PROCESSED_EVENT_IDS);
    await this.save();
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, this.filePath);
  }
}

function visibleAssistantMessage(result: CodexRunResult): string {
  const raw = result.agentMessages.at(-1) ?? '';
  const directive = extractBridgeFileSendDirective(raw);
  if (directive.request || directive.error || directive.caption) {
    return directive.cleanText.trim()
      || directive.caption?.trim()
      || raw.trim()
      || '本轮已完成，但 Codex 没有返回文本消息。';
  }
  return raw.trim() ? raw : '本轮已完成，但 Codex 没有返回文本消息。';
}

function createWiscordRuntime(
  message: WiscordMessage,
  binding: ChannelBinding,
  driverMode: 'legacy-exec' | 'app-server',
): ChannelRuntime {
  const now = new Date().toISOString();
  const task: PromptTask = {
    attachments: [],
    bindingChannelId: binding.channelId,
    conversationId: message.conversationId,
    effectivePrompt: message.content,
    engine: binding.engine,
    enqueuedAt: now,
    extraAddDirs: [],
    id: message.id,
    messageId: message.id,
    origin: 'user',
    prompt: message.content,
    requestedBy: message.author.id,
    requestedById: message.author.id,
    rootEffectivePrompt: message.content,
    rootPrompt: message.content,
  };
  const activeRun: ActiveRunState = {
    agentMessages: [],
    collabToolCalls: [],
    driverMode: binding.engine === 'claude' ? 'claude-cli' : driverMode,
    latestActivity: '已收到请求，正在启动 Codex',
    planItems: [],
    reasoningSummaries: [],
    startedAt: now,
    status: 'starting',
    stderr: [],
    task,
    timeline: ['🔄 已收到请求，正在启动 Codex'],
    updatedAt: now,
    usedResume: false,
  };

  return { activeRun, conversationId: message.conversationId, queue: [] };
}

function toGatewayUrl(baseUrl: string): string {
  const url = new URL('/bot/v1/gateway', `${baseUrl}/`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function splitUtf8(content: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const character of content) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (current && currentBytes + bytes > maxBytes) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += character;
    currentBytes += bytes;
  }
  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}
