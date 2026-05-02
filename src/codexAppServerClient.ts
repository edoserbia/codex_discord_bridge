import { once } from 'node:events';
import { spawn } from 'node:child_process';
import net from 'node:net';

import type { AppConfig } from './config.js';
import type {
  AppServerTransport,
  AppServerPlanStep,
  AppServerTurnEvent,
  AppServerTurnInput,
  AppServerTurnResult,
  ChannelBinding,
  RunningAppServerTurn,
} from './types.js';

import { buildCodexChildEnv } from './codexChildEnv.js';
import { isIgnorableCodexStderrLine, normalizeCodexDiagnosticLine } from './codexDiagnostics.js';
import { resolveCodexConfigEntries } from './codexRunner.js';
import { uniqueStrings } from './utils.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timeout?: NodeJS.Timeout | undefined;
}

interface ActiveTurnState {
  threadId: string;
  turnId: string;
  onEvent: ((event: AppServerTurnEvent) => void | Promise<void>) | undefined;
  resolve: (result: AppServerTurnResult) => void;
  reject: (error: unknown) => void;
  done: Promise<AppServerTurnResult>;
  completed: boolean;
}

interface BufferedTurnEvent {
  event: AppServerTurnEvent;
  terminalResult?: AppServerTurnResult | undefined;
}

type AppServerWebSocket = {
  readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
};

export class CodexAppServerClient {
  private child: ReturnType<typeof spawn> | undefined;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly activeTurns = new Map<string, ActiveTurnState>();
  private readonly bufferedTurnEvents = new Map<string, BufferedTurnEvent[]>();
  private socket: AppServerWebSocket | undefined;
  private transportMode: Exclude<AppServerTransport, 'auto'> | undefined;
  private nextRequestId = 1;
  private stdoutBuffer = Buffer.alloc(0);
  private started = false;
  private startPromise: Promise<void> | undefined;
  private driverFailure: Error | undefined;
  private messageChain: Promise<void> = Promise.resolve();
  private childStderrBuffer = '';
  private recentChildStderr: string[] = [];
  private readonly pendingTurnFailureMessages = new Map<string, string[]>();

  constructor(private readonly config: AppConfig) {}

  async start(startupWorkspacePath = process.cwd()): Promise<void> {
    if (this.started) {
      return;
    }

    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.driverFailure = undefined;
    this.messageChain = Promise.resolve();
    this.childStderrBuffer = '';
    this.recentChildStderr = [];
    this.pendingTurnFailureMessages.clear();
    this.transportMode = resolveAppServerTransport(this.config.codexAppServerTransport, this.config.codexCommand);

    const startup = this.startTransport(startupWorkspacePath);
    this.startPromise = startup;

    try {
      await startup;
      this.started = true;
    } catch (error) {
      this.failDriver(error);
      throw error;
    } finally {
      if (this.startPromise === startup) {
        this.startPromise = undefined;
      }
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    const socket = this.socket;
    this.child = undefined;
    this.socket = undefined;
    this.transportMode = undefined;
    this.started = false;
    this.stdoutBuffer = Buffer.alloc(0);
    this.driverFailure = undefined;
    this.childStderrBuffer = '';
    this.recentChildStderr = [];
    this.pendingTurnFailureMessages.clear();

    if (socket) {
      try {
        socket.close();
      } catch {
        // ignore close errors during shutdown
      }
    }

    if (child) {
      terminateChild(child);
      await once(child, 'exit').catch(() => undefined);
    }
  }

  async ensureThread(binding: ChannelBinding, existingThreadId: string | undefined): Promise<string> {
    await this.start(binding.workspacePath);

    const sharedParams = {
      cwd: binding.workspacePath,
      approvalPolicy: binding.codex.approvalPolicy,
      sandbox: binding.codex.sandboxMode,
      model: binding.codex.model ?? null,
      config: buildThreadConfig(binding),
      persistExtendedHistory: true,
    };

    const result = existingThreadId
      ? await this.request('thread/resume', {
        ...sharedParams,
        threadId: existingThreadId,
        experimentalRawEvents: false,
      })
      : await this.request('thread/start', {
        ...sharedParams,
        experimentalRawEvents: false,
      });

    const threadId = extractNestedString(result, ['thread', 'id']);
    if (!threadId) {
      throw new Error('app-server response missing thread id');
    }

    return threadId;
  }

  async startTurn(binding: ChannelBinding, threadId: string, input: AppServerTurnInput): Promise<RunningAppServerTurn> {
    await this.start(binding.workspacePath);

    const result = await this.request('turn/start', {
      threadId,
      cwd: binding.workspacePath,
      approvalPolicy: binding.codex.approvalPolicy,
      model: binding.codex.model ?? null,
      sandboxPolicy: buildSandboxPolicy(binding, input),
      input: [
        {
          type: 'text',
          text: input.prompt,
        },
        ...[...new Set(input.imagePaths)].map((imagePath) => ({
          type: 'localImage',
          path: imagePath,
        })),
      ],
    });

    const turnId = extractNestedString(result, ['turn', 'id']);
    if (!turnId) {
      throw new Error('app-server response missing turn id');
    }

    let resolveDone!: (result: AppServerTurnResult) => void;
    let rejectDone!: (error: unknown) => void;
    const done = new Promise<AppServerTurnResult>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const activeTurn: ActiveTurnState = {
      threadId,
      turnId,
      onEvent: input.onEvent,
      resolve: resolveDone,
      reject: rejectDone,
      done,
      completed: false,
    };
    this.activeTurns.set(turnId, activeTurn);

    await this.flushBufferedTurnEvents(turnId);

    if (this.driverFailure && !activeTurn.completed) {
      activeTurn.completed = true;
      this.activeTurns.delete(turnId);
      rejectDone(this.driverFailure);
    }

    return {
      turnId,
      done,
    };
  }

  async steerTurn(threadId: string, turnId: string, prompt: string): Promise<void> {
    await this.start();
    await this.request('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input: [
        {
          type: 'text',
          text: prompt,
        },
      ],
    });

    await this.emitTurnEvent(turnId, {
      event: {
        type: 'turn.steered',
        threadId,
        turnId,
        prompt,
      },
    });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.start();
    await this.request('turn/interrupt', {
      threadId,
      turnId,
    });
  }

  async setThreadGoal(binding: ChannelBinding, threadId: string, objective: string): Promise<void> {
    await this.start(binding.workspacePath);
    await this.request('thread/goal/set', {
      threadId,
      objective,
      status: 'active',
    });
  }

  async clearThreadGoal(binding: ChannelBinding, threadId: string): Promise<void> {
    await this.start(binding.workspacePath);
    await this.request('thread/goal/clear', {
      threadId,
    });
  }

  private async startTransport(startupWorkspacePath: string): Promise<void> {
    const { command, argsPrefix } = resolveCommandInvocation(this.config.codexCommand);
    const startupTimeoutMs = this.getStartupTimeoutMs();

    if (this.transportMode === 'ws') {
      const port = await reserveLocalPort();
      const listenUrl = `ws://127.0.0.1:${port}`;
      const child = this.spawnAppServer(command, argsPrefix, listenUrl, startupWorkspacePath);
      this.child = child;
      await this.connectWebSocket(listenUrl, startupTimeoutMs);
    } else {
      const child = this.spawnAppServer(command, argsPrefix, 'stdio://', startupWorkspacePath);
      child.stdout?.on('data', (chunk: Buffer) => {
        this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
        this.processStdoutBuffer();
      });
      this.child = child;
    }

    await this.request('initialize', {
      clientInfo: {
        name: 'codex-discord-bridge',
        version: '0.3.3',
      },
      capabilities: {
        experimentalApi: true,
      },
    }, startupTimeoutMs);

    this.sendNotification('initialized');
  }

  private spawnAppServer(
    command: string,
    argsPrefix: string[],
    listenUrl: string,
    startupWorkspacePath: string,
  ): ReturnType<typeof spawn> {
    const child = spawn(command, [...argsPrefix, 'app-server', '--listen', listenUrl], {
      cwd: startupWorkspacePath,
      env: buildCodexChildEnv(startupWorkspacePath),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      this.appendChildStderrChunk(chunk);
    });

    child.on('error', (error) => {
      this.failDriver(error);
    });

    child.on('exit', (code, signal) => {
      const message = code !== null
        ? `app-server exited with code ${code}`
        : `app-server terminated by ${signal ?? 'unknown signal'}`;
      this.failDriver(new Error(message));
    });

    return child;
  }

  private async connectWebSocket(listenUrl: string, timeoutMs: number): Promise<void> {
    const WebSocketCtor = globalThis.WebSocket as undefined | (new (url: string) => AppServerWebSocket);
    if (!WebSocketCtor) {
      throw new Error('global WebSocket is unavailable in this Node runtime');
    }

    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;

    while (Date.now() < deadline) {
      try {
        const socket = await openWebSocket(WebSocketCtor, listenUrl, Math.min(1_000, Math.max(100, deadline - Date.now())));
        this.socket = socket;
        socket.onmessage = (event) => {
          const payload = parseWebSocketPayload(event.data);
          if (!payload) {
            return;
          }

          this.messageChain = this.messageChain
            .then(async () => {
              await this.handleMessage(payload);
            })
            .catch((error) => {
              this.failDriver(error);
            });
        };
        socket.onerror = () => {
          this.failDriver(new Error('app-server websocket transport error'));
        };
        socket.onclose = () => {
          const child = this.child;
          const exitCode = child?.exitCode;
          const signalCode = child?.signalCode;

          if (typeof exitCode === 'number') {
            this.failDriver(new Error(`app-server exited with code ${exitCode}`));
            return;
          }

          if (typeof signalCode === 'string' && signalCode.trim()) {
            this.failDriver(new Error(`app-server terminated by ${signalCode}`));
            return;
          }

          this.failDriver(new Error('app-server websocket transport closed'));
        };
        return;
      } catch (error) {
        lastError = error;
        await sleep(100);
      }
    }

    throw lastError instanceof Error
      ? new Error(`app-server websocket connect timed out after ${timeoutMs}ms: ${lastError.message}`)
      : new Error(`app-server websocket connect timed out after ${timeoutMs}ms`);
  }

  private processStdoutBuffer(): void {
    try {
      while (true) {
        const message = this.readNextStdoutMessage();
        if (!message) {
          return;
        }
        this.messageChain = this.messageChain
          .then(async () => {
            await this.handleMessage(message);
          })
          .catch((error) => {
            this.failDriver(error);
          });
      }
    } catch (error) {
      this.failDriver(error);
    }
  }

  private readNextStdoutMessage(): Record<string, unknown> | undefined {
    const framed = this.readContentLengthStdoutMessage();
    if (framed) {
      return framed;
    }

    return this.readNdjsonStdoutMessage();
  }

  private readContentLengthStdoutMessage(): Record<string, unknown> | undefined {
    const prefix = this.stdoutBuffer.subarray(0, 15).toString('utf8').toLowerCase();
    if (!prefix.startsWith('content-length')) {
      return undefined;
    }

    const headerEnd = this.stdoutBuffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      return undefined;
    }

    const headerText = this.stdoutBuffer.slice(0, headerEnd).toString('utf8');
    const lengthMatch = headerText.match(/content-length:\s*(\d+)/i);
    if (!lengthMatch) {
      throw new Error('app-server response missing Content-Length header');
    }

    const contentLength = Number.parseInt(lengthMatch[1]!, 10);
    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + contentLength;
    if (this.stdoutBuffer.length < messageEnd) {
      return undefined;
    }

    const payload = this.stdoutBuffer.slice(messageStart, messageEnd).toString('utf8');
    this.stdoutBuffer = this.stdoutBuffer.slice(messageEnd);
    return JSON.parse(payload) as Record<string, unknown>;
  }

  private readNdjsonStdoutMessage(): Record<string, unknown> | undefined {
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf('\n');
      if (newlineIndex < 0) {
        return undefined;
      }

      const line = this.stdoutBuffer.slice(0, newlineIndex).toString('utf8').replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

      if (!line.trim()) {
        continue;
      }

      return JSON.parse(line) as Record<string, unknown>;
    }
  }

  private async handleMessage(message: Record<string, unknown>): Promise<void> {
    if (typeof message.id === 'number') {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }

      this.pendingRequests.delete(message.id);
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }

      if (message.error) {
        pending.reject(message.error);
        return;
      }

      pending.resolve(message.result);
      return;
    }

    const method = typeof message.method === 'string' ? message.method : undefined;
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (!method) {
      return;
    }

    switch (method) {
      case 'error': {
        const messageText = extractAppServerFailureMessage(params);
        const target = this.resolveTurnReference(params);
        if (messageText && target) {
          this.rememberTurnFailureMessage(target.turnId, messageText);
        }
        break;
      }
      case 'turn/started': {
        const threadId = typeof params.threadId === 'string' ? params.threadId : '';
        const turnId = extractNestedString(params, ['turn', 'id']);
        if (threadId && turnId) {
          await this.emitTurnEvent(turnId, {
            event: {
              type: 'turn.started',
              threadId,
              turnId,
            },
          });
        }
        break;
      }
      case 'turn/completed': {
        const threadId = typeof params.threadId === 'string' ? params.threadId : '';
        const turnId = extractNestedString(params, ['turn', 'id']);
        const status = extractNestedString(params, ['turn', 'status']) ?? 'completed';
        if (threadId && turnId) {
          if (status === 'interrupted') {
            await this.emitTurnEvent(turnId, {
              event: {
                type: 'turn.interrupted',
                threadId,
                turnId,
              },
              terminalResult: {
                success: false,
                threadId,
                turnId,
                interrupted: true,
              },
            });
            break;
          }

          if (status === 'completed') {
            this.pendingTurnFailureMessages.delete(turnId);
            await this.emitTurnEvent(turnId, {
              event: {
                type: 'turn.completed',
                threadId,
                turnId,
              },
              terminalResult: {
                success: true,
                threadId,
                turnId,
                interrupted: false,
              },
            });
            break;
          }

          const message = combineFailureMessages(
            extractAppServerFailureMessage(params),
            this.consumeTurnFailureMessage(turnId),
            status !== 'failed' ? `app-server reported turn status ${status}` : undefined,
          );
          await this.emitTurnEvent(turnId, {
            event: {
              type: 'turn.failed',
              threadId,
              turnId,
              message,
            },
            terminalResult: {
              success: false,
              threadId,
              turnId,
              interrupted: false,
            },
          });
        }
        break;
      }
      case 'turn/plan/updated': {
        const threadId = typeof params.threadId === 'string' ? params.threadId : '';
        const turnId = typeof params.turnId === 'string' ? params.turnId : '';
        const rawPlan = Array.isArray(params.plan) ? params.plan : [];
        if (threadId && turnId) {
          await this.emitTurnEvent(turnId, {
            event: {
              type: 'plan.updated',
              threadId,
              turnId,
              plan: rawPlan.map(normalizePlanStep).filter((item): item is AppServerPlanStep => item !== undefined),
            },
          });
        }
        break;
      }
      case 'item/plan/delta': {
        const target = this.resolveTurnReference(params);
        const rawPlan = Array.isArray(params.plan) ? params.plan : Array.isArray(params.items) ? params.items : [];
        if (target && rawPlan.length > 0) {
          await this.emitTurnEvent(target.turnId, {
            event: {
              type: 'plan.updated',
              threadId: target.threadId,
              turnId: target.turnId,
              plan: rawPlan.map(normalizePlanStep).filter((item): item is AppServerPlanStep => item !== undefined),
            },
          });
        }
        break;
      }
      case 'item/started':
      case 'item.updated':
      case 'item/completed': {
        const threadId = typeof params.threadId === 'string' ? params.threadId : '';
        const turnId = typeof params.turnId === 'string' ? params.turnId : '';
        const item = (params.item ?? null) as Record<string, unknown> | null;
        if (threadId && turnId && item && !Array.isArray(item)) {
          await this.emitTurnEvent(turnId, {
            event: {
              type: method === 'item/started'
                ? 'item.started'
                : method === 'item.updated'
                  ? 'item.updated'
                  : 'item.completed',
              threadId,
              turnId,
              item,
            },
          });
        }
        break;
      }
      case 'item/commandExecution/outputDelta': {
        const threadId = typeof params.threadId === 'string' ? params.threadId : '';
        const turnId = typeof params.turnId === 'string' ? params.turnId : '';
        const itemId = typeof params.itemId === 'string' ? params.itemId : '';
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (threadId && turnId && itemId && delta) {
          await this.emitTurnEvent(turnId, {
            event: {
              type: 'command.output.delta',
              threadId,
              turnId,
              itemId,
              delta,
            },
          });
        }
        break;
      }
      case 'item/agentMessage/delta': {
        const threadId = typeof params.threadId === 'string' ? params.threadId : '';
        const turnId = typeof params.turnId === 'string' ? params.turnId : '';
        const itemId = typeof params.itemId === 'string' ? params.itemId : '';
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (threadId && turnId && itemId && delta) {
          await this.emitTurnEvent(turnId, {
            event: {
              type: 'agent.message.delta',
              threadId,
              turnId,
              itemId,
              delta,
            },
          });
        }
        break;
      }
      case 'item/reasoning/summaryTextDelta': {
        const threadId = typeof params.threadId === 'string' ? params.threadId : '';
        const turnId = typeof params.turnId === 'string' ? params.turnId : '';
        const itemId = typeof params.itemId === 'string' ? params.itemId : '';
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (threadId && turnId && itemId && delta) {
          await this.emitTurnEvent(turnId, {
            event: {
              type: 'reasoning.summary.delta',
              threadId,
              turnId,
              itemId,
              delta,
            },
          });
        }
        break;
      }
      case 'item/reasoning/summaryPartAdded':
      case 'item/reasoning/textDelta': {
        const target = this.resolveTurnReference(params);
        const itemId = typeof params.itemId === 'string' ? params.itemId : '';
        const delta = extractReasoningDelta(params);
        if (target && itemId && delta) {
          await this.emitTurnEvent(target.turnId, {
            event: {
              type: 'reasoning.summary.delta',
              threadId: target.threadId,
              turnId: target.turnId,
              itemId,
              delta,
            },
          });
        }
        break;
      }
      default:
        break;
    }
  }

  private async emitTurnEvent(turnId: string, entry: BufferedTurnEvent): Promise<void> {
    const activeTurn = this.activeTurns.get(turnId);
    if (!activeTurn) {
      const buffered = this.bufferedTurnEvents.get(turnId) ?? [];
      buffered.push(entry);
      this.bufferedTurnEvents.set(turnId, buffered);
      return;
    }

    if (activeTurn.onEvent) {
      await activeTurn.onEvent(entry.event);
    }

    if (entry.terminalResult) {
      this.finishTurn(turnId, entry.terminalResult);
    }
  }

  private finishTurn(turnId: string, result: AppServerTurnResult): void {
    const activeTurn = this.activeTurns.get(turnId);
    if (!activeTurn || activeTurn.completed) {
      return;
    }

    activeTurn.completed = true;
    this.activeTurns.delete(turnId);
    this.bufferedTurnEvents.delete(turnId);
    this.pendingTurnFailureMessages.delete(turnId);
    activeTurn.resolve(result);
  }

  private failDriver(error: unknown): void {
    const normalized = this.normalizeDriverFailure(error);
    const child = this.child;
    const socket = this.socket;
    this.driverFailure = normalized;
    this.started = false;
    this.startPromise = undefined;
    this.child = undefined;
    this.socket = undefined;
    this.transportMode = undefined;
    this.stdoutBuffer = Buffer.alloc(0);
    this.messageChain = Promise.resolve();
    this.pendingTurnFailureMessages.clear();

    for (const pending of this.pendingRequests.values()) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      pending.reject(normalized);
    }
    this.pendingRequests.clear();

    for (const turn of this.activeTurns.values()) {
      turn.reject(normalized);
    }
    this.activeTurns.clear();
    this.bufferedTurnEvents.clear();

    if (socket) {
      try {
        socket.close();
      } catch {
        // ignore close errors while failing transport
      }
    }

    if (child) {
      terminateChild(child);
    }
  }

  private appendChildStderrChunk(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (!text) {
      return;
    }

    const combined = `${this.childStderrBuffer}${text}`;
    const lines = combined.split(/\r?\n/);
    this.childStderrBuffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = normalizeCodexDiagnosticLine(rawLine);

      if (!line || isIgnorableCodexStderrLine(line)) {
        continue;
      }

      if (this.recentChildStderr.at(-1) === line) {
        continue;
      }

      this.recentChildStderr.push(line);
    }

    if (this.recentChildStderr.length > 20) {
      this.recentChildStderr.splice(0, this.recentChildStderr.length - 20);
    }
  }

  private normalizeDriverFailure(error: unknown): Error {
    if (this.childStderrBuffer.trim()) {
      this.appendChildStderrChunk('\n');
    }

    const baseError = error instanceof Error ? error : new Error(String(error));
    const normalizedMessage = normalizeCodexDiagnosticLine(baseError.message);
    const normalized = normalizedMessage === baseError.message ? baseError : new Error(normalizedMessage);
    const stderrTail = this.recentChildStderr
      .slice(-3)
      .filter((line) => line && !normalized.message.includes(line));

    if (stderrTail.length === 0) {
      return normalized;
    }

    return new Error(`${normalized.message}: ${stderrTail.join(' | ')}`);
  }

  private async flushBufferedTurnEvents(turnId: string): Promise<void> {
    const buffered = this.bufferedTurnEvents.get(turnId);
    if (!buffered || buffered.length === 0) {
      return;
    }

    this.bufferedTurnEvents.delete(turnId);
    for (const entry of buffered) {
      await this.emitTurnEvent(turnId, entry);

      if (entry.terminalResult) {
        return;
      }
    }
  }

  private async request(method: string, params: Record<string, unknown>, timeoutMs = this.getRequestTimeoutMs()): Promise<any> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;

    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = timeoutMs > 0
        ? setTimeout(() => {
          this.failDriver(new Error(`app-server ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs)
        : undefined;
      this.pendingRequests.set(id, { resolve, reject, timeout });
    });

    this.sendMessage(payload);
    return response;
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    const payload = params === undefined
      ? { jsonrpc: '2.0', method }
      : { jsonrpc: '2.0', method, params };
    this.sendMessage(payload);
  }

  private sendMessage(payload: Record<string, unknown>): void {
    const message = JSON.stringify(payload);

    if (this.transportMode === 'ws') {
      const socket = this.socket;
      if (!socket || socket.readyState !== 1) {
        throw new Error('app-server websocket transport is not connected');
      }
      socket.send(message);
      return;
    }

    const child = this.child;
    if (!child?.stdin) {
      throw new Error('app-server child process is not running');
    }

    child.stdin.write(`${message}\n`);
  }

  private getStartupTimeoutMs(): number {
    return Math.max(1, this.config.codexAppServerStartupTimeoutMs ?? 10_000);
  }

  private getRequestTimeoutMs(): number {
    return Math.max(1, this.config.codexAppServerRequestTimeoutMs ?? this.getStartupTimeoutMs());
  }

  private rememberTurnFailureMessage(turnId: string, message: string): void {
    const normalized = normalizeCodexDiagnosticLine(message);
    if (!normalized) {
      return;
    }

    const next = uniqueStrings([
      ...(this.pendingTurnFailureMessages.get(turnId) ?? []),
      normalized,
    ]);
    this.pendingTurnFailureMessages.set(turnId, next.slice(-3));
  }

  private consumeTurnFailureMessage(turnId: string): string | undefined {
    const messages = this.pendingTurnFailureMessages.get(turnId) ?? [];
    this.pendingTurnFailureMessages.delete(turnId);
    return messages.length > 0 ? messages.join(' | ') : undefined;
  }

  private resolveTurnReference(params: Record<string, unknown>): { threadId: string; turnId: string } | undefined {
    const turnId = extractNestedString(params, ['turn', 'id'])
      ?? (typeof params.turnId === 'string' ? params.turnId : undefined);
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;

    if (turnId && threadId) {
      return { threadId, turnId };
    }

    if (turnId) {
      const activeTurn = this.activeTurns.get(turnId);
      if (activeTurn) {
        return { threadId: activeTurn.threadId, turnId };
      }
    }

    if (threadId) {
      const matchingTurns = [...this.activeTurns.values()].filter((turn) => turn.threadId === threadId && !turn.completed);
      if (matchingTurns.length === 1) {
        return {
          threadId,
          turnId: matchingTurns[0]!.turnId,
        };
      }
    }

    if (this.activeTurns.size === 1) {
      const [onlyTurn] = this.activeTurns.values();
      if (onlyTurn && !onlyTurn.completed) {
        return {
          threadId: onlyTurn.threadId,
          turnId: onlyTurn.turnId,
        };
      }
    }

    return undefined;
  }
}

function normalizePlanStep(raw: unknown): AppServerPlanStep | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const candidate = raw as Record<string, unknown>;
  const step = extractPlanStepText(candidate);
  const rawStatus = typeof candidate.status === 'string' ? candidate.status.trim() : '';
  if (!step || !rawStatus) {
    return undefined;
  }

  if (rawStatus === 'completed') {
    return { step, status: 'completed' };
  }

  if (rawStatus === 'inProgress') {
    return { step, status: 'in_progress' };
  }

  return { step, status: 'pending' };
}

function extractPlanStepText(candidate: Record<string, unknown>): string {
  for (const key of ['step', 'text', 'title', 'content', 'task', 'description']) {
    const value = candidate[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

function extractReasoningDelta(params: Record<string, unknown>): string {
  for (const key of ['delta', 'text', 'summaryText', 'reasoningText']) {
    const value = params[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  const part = params.part;
  if (part && typeof part === 'object' && !Array.isArray(part)) {
    const candidate = part as Record<string, unknown>;
    for (const key of ['text', 'content', 'summaryText']) {
      const value = candidate[key];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
  }

  return '';
}

function buildThreadConfig(binding: ChannelBinding): Record<string, unknown> | null {
  const config: Record<string, unknown> = {};

  for (const entry of resolveCodexConfigEntries(binding.codex.extraConfig)) {
    applyConfigEntry(config, entry);
  }

  if (binding.codex.profile) {
    setNestedConfigValue(config, ['profile'], binding.codex.profile);
  }

  setNestedConfigValue(config, ['web_search'], binding.codex.search ? 'live' : 'disabled');

  return Object.keys(config).length > 0 ? config : null;
}

function buildSandboxPolicy(binding: ChannelBinding, input: AppServerTurnInput): Record<string, unknown> {
  if (binding.codex.sandboxMode === 'danger-full-access') {
    return { type: 'dangerFullAccess' };
  }

  if (binding.codex.sandboxMode === 'read-only') {
    return {
      type: 'readOnly',
      access: {
        type: 'fullAccess',
      },
      networkAccess: false,
    };
  }

  return {
    type: 'workspaceWrite',
    writableRoots: uniqueStrings([
      binding.workspacePath,
      ...binding.codex.addDirs,
      ...input.extraAddDirs,
    ]),
    readOnlyAccess: {
      type: 'fullAccess',
    },
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function applyConfigEntry(config: Record<string, unknown>, entry: string): void {
  const separatorIndex = entry.indexOf('=');
  if (separatorIndex < 0) {
    return;
  }

  const rawKey = entry.slice(0, separatorIndex).trim();
  const rawValue = entry.slice(separatorIndex + 1).trim();
  if (!rawKey) {
    return;
  }

  setNestedConfigValue(config, rawKey.split('.').filter(Boolean), parseConfigValue(rawValue));
}

function setNestedConfigValue(target: Record<string, unknown>, pathSegments: string[], value: unknown): void {
  if (pathSegments.length === 0) {
    return;
  }

  let current: Record<string, unknown> = target;

  for (const segment of pathSegments.slice(0, -1)) {
    const existing = current[segment];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      current[segment] = {};
    }

    current = current[segment] as Record<string, unknown>;
  }

  current[pathSegments.at(-1)!] = value;
}

function parseConfigValue(rawValue: string): unknown {
  const normalized = rawValue.trim();

  if (!normalized) {
    return '';
  }

  if (normalized === 'true') {
    return true;
  }

  if (normalized === 'false') {
    return false;
  }

  if (normalized === 'null') {
    return null;
  }

  if (/^-?\d+(?:\.\d+)?$/.test(normalized)) {
    return Number(normalized);
  }

  if ((normalized.startsWith('"') && normalized.endsWith('"'))
    || (normalized.startsWith('[') && normalized.endsWith(']'))
    || (normalized.startsWith('{') && normalized.endsWith('}'))) {
    try {
      return JSON.parse(normalized);
    } catch {
      return normalized;
    }
  }

  if (normalized.startsWith('\'') && normalized.endsWith('\'')) {
    return normalized.slice(1, -1);
  }

  return normalized;
}

function extractNestedString(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return typeof current === 'string' && current.trim() ? current.trim() : undefined;
}

function combineFailureMessages(...messages: Array<string | undefined>): string | undefined {
  const normalized = uniqueStrings(messages.map((message) => normalizeCodexDiagnosticLine(message ?? '')).filter(Boolean));
  return normalized.length > 0 ? normalized.join(' | ') : undefined;
}

function extractAppServerFailureMessage(value: unknown): string | undefined {
  return combineFailureMessages(
    extractNestedString(value, ['turn', 'error', 'message']),
    extractNestedString(value, ['turn', 'error']),
    extractNestedString(value, ['error', 'message']),
    extractNestedString(value, ['error']),
    extractNestedString(value, ['message']),
    extractNestedString(value, ['detail']),
  );
}

function resolveCommandInvocation(command: string): { command: string; argsPrefix: string[] } {
  if (/\.(?:[cm]?js|ts)$/i.test(command)) {
    return {
      command: process.execPath,
      argsPrefix: [command],
    };
  }

  return {
    command,
    argsPrefix: [],
  };
}

export function resolveAppServerTransport(
  configuredTransport: AppServerTransport | undefined,
  _command: string,
): Exclude<AppServerTransport, 'auto'> {
  if (configuredTransport === 'stdio' || configuredTransport === 'ws') {
    return configuredTransport;
  }

  return 'stdio';
}

function parseWebSocketPayload(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === 'string') {
    return JSON.parse(raw) as Record<string, unknown>;
  }

  if (raw instanceof ArrayBuffer) {
    return JSON.parse(Buffer.from(raw).toString('utf8')) as Record<string, unknown>;
  }

  if (ArrayBuffer.isView(raw)) {
    return JSON.parse(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')) as Record<string, unknown>;
  }

  return undefined;
}

async function openWebSocket(
  WebSocketCtor: new (url: string) => AppServerWebSocket,
  listenUrl: string,
  timeoutMs: number,
): Promise<AppServerWebSocket> {
  return await new Promise<AppServerWebSocket>((resolve, reject) => {
    const socket = new WebSocketCtor(listenUrl);
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // ignore close errors on timeout
      }
      reject(new Error(`websocket connect timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.onopen = () => {
      clearTimeout(timer);
      resolve(socket);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error('websocket connect failed'));
    };
  });
}

async function reserveLocalPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to reserve local app-server port')));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function terminateChild(child: ReturnType<typeof spawn>): void {
  if (child.killed) {
    return;
  }

  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }

    setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, 5_000).unref();
    return;
  }

  child.kill('SIGTERM');
}
