import { once } from 'node:events';
import { spawn } from 'node:child_process';

import type { AppConfig } from './config.js';
import type {
  AppServerPlanStep,
  AppServerTurnEvent,
  AppServerTurnInput,
  AppServerTurnResult,
  ChannelBinding,
  RunningAppServerTurn,
} from './types.js';

import { resolveCodexConfigEntries } from './codexRunner.js';
import { uniqueStrings } from './utils.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
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

export class CodexAppServerClient {
  private child: ReturnType<typeof spawn> | undefined;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly activeTurns = new Map<string, ActiveTurnState>();
  private readonly bufferedTurnEvents = new Map<string, BufferedTurnEvent[]>();
  private nextRequestId = 1;
  private stdoutBuffer = Buffer.alloc(0);
  private started = false;
  private startPromise: Promise<void> | undefined;
  private driverFailure: Error | undefined;
  private messageChain: Promise<void> = Promise.resolve();

  constructor(private readonly config: AppConfig) {}

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.driverFailure = undefined;
    const startup = (async () => {
      const { command, argsPrefix } = resolveCommandInvocation(this.config.codexCommand);
      const child = spawn(command, [...argsPrefix, 'app-server', '--listen', 'stdio://'], {
        cwd: process.cwd(),
        env: buildCodexChildEnv(process.cwd()),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });

      child.stdout.on('data', (chunk: Buffer) => {
        this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
        this.processStdoutBuffer();
      });

      child.stderr.on('data', () => {
        // The initial client test contract does not assert stderr handling yet.
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

      this.child = child;
      this.messageChain = Promise.resolve();

      try {
        await this.request('initialize', {
          clientInfo: {
            name: 'codex-discord-bridge',
            version: '0.3.3',
          },
          capabilities: {
            experimentalApi: true,
          },
        });
        this.started = true;
      } catch (error) {
        this.failDriver(error);
        throw error;
      }
    })();

    this.startPromise = startup.finally(() => {
      if (this.startPromise === guardedStartup) {
        this.startPromise = undefined;
      }
    });

    const guardedStartup = this.startPromise;
    await guardedStartup;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.started = false;
    this.stdoutBuffer = Buffer.alloc(0);

    if (!child) {
      return;
    }

    terminateChild(child);
    await once(child, 'exit').catch(() => undefined);
  }

  async ensureThread(binding: ChannelBinding, existingThreadId: string | undefined): Promise<string> {
    await this.start();

    const sharedParams = {
      cwd: binding.workspacePath,
      approvalPolicy: binding.codex.approvalPolicy,
      sandbox: binding.codex.sandboxMode,
      model: binding.codex.model ?? null,
      config: buildThreadConfig(binding),
      persistExtendedHistory: true,
    };

    const result = existingThreadId
      ? await this.request('thread/resume', { ...sharedParams, threadId: existingThreadId })
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
    await this.start();

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

  private processStdoutBuffer(): void {
    try {
      while (true) {
        const headerEnd = this.stdoutBuffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) {
          return;
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
          return;
        }

        const payload = this.stdoutBuffer.slice(messageStart, messageEnd).toString('utf8');
        this.stdoutBuffer = this.stdoutBuffer.slice(messageEnd);
        const message = JSON.parse(payload) as Record<string, unknown>;
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

  private async handleMessage(message: Record<string, unknown>): Promise<void> {
    if (typeof message.id === 'number') {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }

      this.pendingRequests.delete(message.id);

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

          await this.emitTurnEvent(turnId, {
            event: {
              type: 'turn.failed',
              threadId,
              turnId,
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
      case 'item/started':
      case 'item/completed': {
        const threadId = typeof params.threadId === 'string' ? params.threadId : '';
        const turnId = typeof params.turnId === 'string' ? params.turnId : '';
        const item = (params.item ?? null) as Record<string, unknown> | null;
        if (threadId && turnId && item && !Array.isArray(item)) {
          await this.emitTurnEvent(turnId, {
            event: {
              type: method === 'item/started' ? 'item.started' : 'item.completed',
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
    activeTurn.resolve(result);
  }

  private failDriver(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    const child = this.child;
    this.driverFailure = normalized;
    this.started = false;
    this.startPromise = undefined;
    this.child = undefined;
    this.stdoutBuffer = Buffer.alloc(0);
    this.messageChain = Promise.resolve();

    for (const pending of this.pendingRequests.values()) {
      pending.reject(normalized);
    }
    this.pendingRequests.clear();

    for (const turn of this.activeTurns.values()) {
      turn.reject(normalized);
    }
    this.activeTurns.clear();
    this.bufferedTurnEvents.clear();

    if (child) {
      terminateChild(child);
    }
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

  private async request(method: string, params: Record<string, unknown>): Promise<any> {
    const child = this.child;
    if (!child?.stdin) {
      throw new Error('app-server child process is not running');
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;

    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const message = JSON.stringify(payload);
    const framed = `Content-Length: ${Buffer.byteLength(message, 'utf8')}\r\n\r\n${message}`;

    const response = new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });

    child.stdin.write(framed);
    return response;
  }
}

function normalizePlanStep(raw: unknown): AppServerPlanStep | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const candidate = raw as Record<string, unknown>;
  const step = typeof candidate.step === 'string' ? candidate.step.trim() : '';
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

function buildCodexChildEnv(workspacePath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PWD: workspacePath,
  };

  const blockedExactKeys = new Set([
    'CODEX_CI',
    'CODEX_SHELL',
    'CODEX_THREAD_ID',
  ]);

  for (const key of Object.keys(env)) {
    if (key.startsWith('CODEX_TUNNING_')) {
      continue;
    }

    if (key === 'CODEX_HOME' || key === 'CODEX_CONFIG_HOME') {
      continue;
    }

    if (blockedExactKeys.has(key) || key.startsWith('CODEX_INTERNAL_')) {
      delete env[key];
    }
  }

  return env;
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
