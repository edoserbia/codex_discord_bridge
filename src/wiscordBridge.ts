import { promises as fs } from 'node:fs';
import path from 'node:path';

import WebSocket from 'ws';

import type { AppConfig, WiscordBridgeConfig } from './config.js';
import type { CodexExecutionDriver, CodexRunHooks } from './codexRunner.js';
import { extractBridgeFileSendDirective } from './bridgeFileSendProtocol.js';
import { formatFailureReply } from './formatters.js';
import { appendBridgeProjectContext } from './projectContext.js';
import { JsonStateStore } from './store.js';
import type { ChannelBinding, CodexRunResult } from './types.js';

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
  private eventQueue: Promise<void> = Promise.resolve();
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
    await this.eventQueue;
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
    this.eventQueue = this.eventQueue.then(async () => {
      try {
        await this.processEvent(event);
        await this.checkpoint.complete(event.eventId);
      } catch (error) {
        console.error(`[wiscord] event processing failed event=${event.eventId}`, error);
      } finally {
        this.scheduledEventIds.delete(event.eventId);
      }
    });
  }

  private async processEvent(event: WiscordGatewayEvent): Promise<void> {
    if (
      event.type !== 'MESSAGE_CREATE'
      || event.guildId !== this.wiscord.guildId
      || event.conversationId !== this.wiscord.channelId
    ) {
      return;
    }
    const messageId = typeof event.data.messageId === 'string' ? event.data.messageId : '';
    if (!messageId) return;
    const message = await this.api<WiscordMessage>(`/bot/v1/messages/${encodeURIComponent(messageId)}`, { method: 'GET' });
    if (
      message.author.kind !== 'user'
      || message.guildId !== this.wiscord.guildId
      || message.conversationId !== this.wiscord.channelId
      || !message.content.trim()
    ) {
      return;
    }
    await this.runMessage(message);
  }

  private async runMessage(message: WiscordMessage): Promise<void> {
    const binding = this.store.getBinding(this.wiscord.channelId);
    if (!binding) throw new Error(`Wiscord binding is missing for ${this.wiscord.channelId}`);
    const session = await this.store.ensureSession(binding.channelId, message.conversationId);
    const reply = await this.api<{ messageId: string }>('/bot/v1/messages', {
      body: JSON.stringify({ conversationId: message.conversationId }),
      method: 'POST',
    });
    await this.editMessage(reply.messageId, '已收到请求，正在启动 Codex…');

    let progressChain = Promise.resolve();
    const updateProgress = (content: string) => {
      progressChain = progressChain.then(() => this.editMessage(reply.messageId, content));
      return progressChain;
    };
    const hooks: CodexRunHooks = {
      onActivity: async (activity) => updateProgress(`正在处理\n\n${activity}`),
      onAgentMessage: async (content) => updateProgress(content),
      onThreadStarted: async (threadId) => {
        await this.store.updateSession(message.conversationId, {
          codexThreadId: threadId,
          lastEngine: 'codex',
        }, binding.channelId);
      },
    };
    const job = this.runner.start(
      binding,
      {
        imagePaths: [],
        extraAddDirs: [],
        prompt: appendBridgeProjectContext(message.content, binding),
      },
      session.codexThreadId,
      hooks,
    );
    const result = await job.done;
    await progressChain;
    await this.store.updateSession(message.conversationId, {
      codexThreadId: result.codexThreadId ?? session.codexThreadId,
      driver: job.driverMode === 'app-server' || job.driverMode === 'legacy-exec' ? job.driverMode : undefined,
      lastEngine: result.engine ?? 'codex',
      lastPromptBy: message.author.id,
      lastRunAt: new Date().toISOString(),
    }, binding.channelId);

    const finalContent = result.success
      ? visibleAssistantMessage(result)
      : formatFailureReply(binding, message.author.id, result);
    const chunks = splitUtf8(finalContent, MAX_MESSAGE_CHUNK_BYTES);
    for (const [index, content] of chunks.entries()) {
      await this.api(`/bot/v1/messages/${encodeURIComponent(reply.messageId)}/chunks`, {
        body: JSON.stringify({ content, index }),
        method: 'POST',
      });
    }
    await this.api(`/bot/v1/messages/${encodeURIComponent(reply.messageId)}/finalize`, { method: 'POST' });
  }

  private async editMessage(messageId: string, content: string): Promise<void> {
    await this.api(`/bot/v1/messages/${encodeURIComponent(messageId)}`, {
      body: JSON.stringify({ content }),
      method: 'PATCH',
    });
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
