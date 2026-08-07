import { randomBytes } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import WebSocket from 'ws';

import type { AppConfig } from '../src/config.js';
import type { CodexExecutionDriver, CodexRunHooks, RunningCodexJob } from '../src/codexRunner.js';
import { JsonStateStore } from '../src/store.js';
import type { ChannelBinding, CodexRunInput, CodexRunResult } from '../src/types.js';
import { WiscordCodexBridge } from '../src/wiscordBridge.js';

interface AuthResult {
  accessToken: string;
  user: { id: string; username: string };
}

interface GatewayEvent {
  data: Record<string, unknown>;
  eventId: string;
  sequence: number;
  type: string;
}

interface GatewayFrame {
  event?: GatewayEvent | undefined;
  op: string;
}

interface MessageView {
  author: { id: string; kind: string };
  content: string;
  id: string;
  status: string;
}

interface Checkpoint {
  lastAckedSequence: number;
  pending: GatewayEvent[];
  processedEventIds: string[];
}

const baseUrl = normalizeBaseUrl(process.env.WISCORD_BASE_URL ?? 'http://124.220.147.199:4580');
const password = 'Wiscord bridge smoke 2026!';
const username = `bridge_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
const fixtureFile = process.env.WISCORD_UI_FIXTURE_FILE?.trim();
const uiReplyPrefix = 'WISCORD_BRIDGE_UI_OK';
const finalMarkdown = [
  '# Wiscord Bridge public smoke',
  '',
  'This response verifies UTF-8 chunking, Markdown preservation, and one-message finalization.',
  '',
  ...Array.from({ length: 7_000 }, (_, index) => `- row ${index}: **complete** \`const bridge = "wiscord";\``),
].join('\n');

void run().catch((error) => {
  console.error(`Wiscord bridge smoke failed: ${sanitizeError(error)}`);
  process.exitCode = 1;
});

async function run(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'wiscord-public-smoke-'));
  const workspacePath = path.join(root, 'workspace');
  const state = new JsonStateStore(path.join(root, 'state.json'));
  const client = new HttpClient(baseUrl);
  const checks: string[] = [];
  let bridge: WiscordCodexBridge | undefined;
  let gateway: UserGateway | undefined;
  let guildId = '';
  let runnerInput: CodexRunInput | undefined;
  let runnerStarts = 0;

  try {
    await state.load();
    const health = await client.request<{ status: string }>('/health/ready', {}, false);
    assert(health.status === 'ready', 'public server is not ready');
    checks.push('public readiness');

    const registered = await client.request<AuthResult>('/api/v1/auth/register', {
      body: JSON.stringify({ deviceName: 'Codex Discord Bridge smoke', password, username }),
      method: 'POST',
    }, false);
    client.accessToken = registered.accessToken;

    const guild = await client.request<{ id: string }>('/api/v1/guilds', {
      body: JSON.stringify({ name: `Bridge smoke ${username}` }),
      method: 'POST',
    });
    guildId = guild.id;
    const channel = await client.request<{ id: string }>(`/api/v1/guilds/${guild.id}/channels`, {
      body: JSON.stringify({ name: `bridge-${username.slice(-8)}`, topic: 'Bridge public smoke' }),
      method: 'POST',
    });
    const bot = await client.request<{ id: string; appSecret?: string }>('/api/v1/bot-applications', {
      body: JSON.stringify({ name: `Bridge smoke ${username}` }),
      method: 'POST',
    });
    assert(Boolean(bot.appSecret), 'Bot Secret was not returned at creation');
    await client.request(`/api/v1/bot-applications/${bot.id}/installations`, {
      body: JSON.stringify({ guildId: guild.id }),
      method: 'POST',
    });
    checks.push('registration and Bot provisioning');

    gateway = await UserGateway.connect(toWebSocketUrl(`${baseUrl}/api/v1/gateway`), client.accessToken);
    await gateway.waitFor((frame) => frame.op === 'READY', 'user Gateway READY');

    const runner: CodexExecutionDriver = {
      start(
        _binding: ChannelBinding,
        input: CodexRunInput,
        existingThreadId: string | undefined,
        hooks: CodexRunHooks = {},
      ): RunningCodexJob {
        runnerStarts += 1;
        runnerInput = input;
        if (runnerStarts === 1) {
          assert(existingThreadId === undefined, 'first public smoke unexpectedly resumed a thread');
        } else {
          assert(
            existingThreadId === 'wiscord-public-smoke-thread',
            'UI smoke did not resume the persisted Bridge thread',
          );
        }
        const userPrompt = input.prompt.split('\n\nBridge 项目上下文：', 1)[0] ?? input.prompt;
        const responseContent = userPrompt.startsWith('bridge-ui-')
          ? `# Wiscord Bridge UI Reply\n\n${uiReplyPrefix}: ${userPrompt}`
          : finalMarkdown;
        const done = (async (): Promise<CodexRunResult> => {
          await hooks.onThreadStarted?.('wiscord-public-smoke-thread');
          await hooks.onActivity?.(
            userPrompt.startsWith('bridge-ui-')
              ? `Wiscord Bridge UI progress: ${userPrompt}`
              : 'Wiscord bridge smoke progress: 50%',
          );
          await delay(200);
          return {
            agentMessages: [responseContent],
            commands: [],
            codexThreadId: 'wiscord-public-smoke-thread',
            engine: 'codex',
            exitCode: 0,
            planItems: [],
            reasoning: [],
            signal: null,
            stderr: [],
            success: true,
            turnCompleted: true,
            usedResume: false,
          };
        })();
        return { cancel() {}, done, driverMode: 'app-server', pid: undefined };
      },
    };

    const config = buildConfig(root, workspacePath, {
      appId: bot.id,
      appSecret: bot.appSecret!,
      channelId: channel.id,
      guildId: guild.id,
    });
    bridge = new WiscordCodexBridge(config, state, runner);
    await bridge.start();
    await gateway.waitFor(
      (frame) => frame.op === 'EVENT' && frame.event?.type === 'BOT_STATUS' && frame.event.data.status === 'online',
      'Bot online presence',
    );
    checks.push('Bot Gateway READY and online presence');

    if (fixtureFile) {
      await writeFile(fixtureFile, `${JSON.stringify({
        baseUrl,
        channelId: channel.id,
        expectedReplyPrefix: uiReplyPrefix,
        guildId: guild.id,
        password,
        username,
      }, null, 2)}\n`, { mode: 0o600 });
      console.log(`Wiscord UI Bridge fixture ready: ${fixtureFile}`);
      await waitForFile(`${fixtureFile}.stop`, 60 * 60_000);
      return;
    }

    const prompt = `public bridge prompt ${username}`;
    const userMessage = await client.request<{ id: string; status: string }>(
      `/api/v1/conversations/${channel.id}/messages`,
      {
        body: JSON.stringify({ clientNonce: `${username}-prompt`, content: prompt }),
        method: 'POST',
      },
    );
    assert(userMessage.status === 'waiting_for_bot', 'user message did not enter the Bot queue');

    const progress = await gateway.waitFor(
      (frame) => frame.op === 'EVENT'
        && frame.event?.type === 'MESSAGE_UPDATE'
        && typeof frame.event.data.content === 'string'
        && frame.event.data.content.includes('Wiscord bridge smoke progress: 50%'),
      'Bridge progress update',
      20_000,
    );
    const botMessageId = String(progress.event?.data.id ?? '');
    assert(Boolean(botMessageId), 'progress update did not include a Bot message ID');
    checks.push('Gateway ACK, message fetch, and progress PATCH');

    const completedProgress = await gateway.waitFor(
      (frame) => frame.op === 'EVENT'
        && frame.event?.type === 'MESSAGE_UPDATE'
        && frame.event.data.id === botMessageId
        && frame.event.data.status === 'complete'
        && typeof frame.event.data.content === 'string'
        && frame.event.data.content.includes('Codex Discord Bridge 实时进度')
        && frame.event.data.content.includes('状态：已完成'),
      'completed Discord-format progress panel',
      30_000,
    );
    assert(Boolean(completedProgress.event), 'completed progress event was not received');
    const completedFinal = await gateway.waitFor(
      (frame) => frame.op === 'EVENT'
        && frame.event?.type === 'MESSAGE_UPDATE'
        && frame.event.data.id !== botMessageId
        && frame.event.data.status === 'complete'
        && typeof frame.event.data.content === 'string'
        && frame.event.data.content.includes('最终总结')
        && frame.event.data.content.includes(finalMarkdown),
      'one complete Discord-format final summary',
      30_000,
    );
    const finalMessageId = String(completedFinal.event?.data.id ?? '');
    assert(Boolean(finalMessageId), 'final summary did not include a Bot message ID');
    if (!fixtureFile) {
      await bridge.stop();
      bridge = undefined;
    }

    assert(runnerStarts === 1, `runner started ${runnerStarts} times`);
    assert(runnerInput?.prompt.includes(prompt), 'runner did not receive the user message content');
    const history = await client.request<{ items: MessageView[] }>(
      `/api/v1/conversations/${channel.id}/messages`,
    );
    const progressMessages = history.items.filter((message) => message.id === botMessageId);
    assert(progressMessages.length === 1, 'Bridge progress response did not retain one message ID');
    assert(progressMessages[0]?.author.kind === 'bot', 'progress response is not authored by the Bot');
    assert(progressMessages[0]?.content.includes('状态：已完成'), 'progress response did not preserve the completed status');
    assert(progressMessages[0]?.status === 'complete', 'progress Bot message is not complete');
    const finalMessages = history.items.filter((message) => message.id === finalMessageId);
    assert(finalMessages.length === 1, 'Bridge final response did not retain one message ID');
    assert(finalMessages[0]?.author.kind === 'bot', 'final response is not authored by the Bot');
    assert(finalMessages[0]?.content.includes(finalMarkdown), 'final Markdown was not preserved in the summary');
    assert(finalMessages[0]?.status === 'complete', 'final Bot message is not complete');

    const botAuth = await client.request<{ accessToken: string }>('/bot/v1/auth/token', {
      body: JSON.stringify({ appId: bot.id, appSecret: bot.appSecret }),
      method: 'POST',
    }, false);
    const chunkStatus = await client.request<{ indexes: number[] }>(
      `/bot/v1/messages/${finalMessageId}/chunks/status`,
      { headers: { authorization: `Bearer ${botAuth.accessToken}` } },
      false,
    );
    assert(chunkStatus.indexes.length >= 2, 'long response was not split into multiple UTF-8 chunks');

    const checkpoint = JSON.parse(
      await readFile(path.join(root, 'wiscord-checkpoint.json'), 'utf8'),
    ) as Checkpoint;
    assert(checkpoint.lastAckedSequence > 0, 'Gateway sequence was not durably acknowledged');
    assert(checkpoint.pending.length === 0, 'processed Gateway event remains pending');
    assert(checkpoint.processedEventIds.length > 0, 'processed Gateway event was not recorded');
    assert(state.getSession(channel.id)?.codexThreadId === 'wiscord-public-smoke-thread', 'Codex thread was not persisted');
    checks.push('multi-chunk one-message Markdown finalization');
    checks.push('durable checkpoint and Codex thread persistence');

    console.log(JSON.stringify({
      ok: true,
      baseUrl,
      checks: checks.map((name) => ({ name, status: 'passed' })),
      resources: {
        botApplicationId: bot.id,
        botMessageId: finalMessageId,
        channelId: channel.id,
        guildId: guild.id,
        userId: registered.user.id,
      },
    }, null, 2));

  } finally {
    await bridge?.stop().catch(() => undefined);
    gateway?.close();
    if (guildId) {
      await client.request(`/api/v1/guilds/${guildId}`, { method: 'DELETE' }).catch(() => undefined);
    }
    if (fixtureFile) {
      await rm(fixtureFile, { force: true }).catch(() => undefined);
      await rm(`${fixtureFile}.stop`, { force: true }).catch(() => undefined);
    }
    await rm(root, { force: true, recursive: true });
  }
}

function buildConfig(
  dataDir: string,
  workspacePath: string,
  wiscord: { appId: string; appSecret: string; channelId: string; guildId: string },
): AppConfig {
  return {
    adminUserIds: new Set(),
    allowedWorkspaceRoots: [workspacePath],
    claudeCommand: 'claude',
    claudeSettingsPath: path.join(dataDir, 'claude-settings.json'),
    codexAppServerInterruptTimeoutMs: 1_000,
    codexAppServerRequestTimeoutMs: 1_000,
    codexAppServerStartupTimeoutMs: 1_000,
    codexAppServerTransport: 'stdio',
    codexAppServerTurnTimeoutMs: 30_000,
    codexCommand: 'codex',
    codexDriverMode: 'app-server',
    codexMaxAttempts: 1,
    codexRateLimitBaseDelayMs: 1,
    codexRateLimitMaxAttempts: 1,
    codexRateLimitMaxDelayMs: 1,
    commandPrefix: '!',
    dataDir,
    defaultCodex: {
      addDirs: [],
      approvalPolicy: 'never',
      extraConfig: [],
      sandboxMode: 'danger-full-access',
      search: false,
      skipGitRepoCheck: true,
    },
    discordToken: 'unused-by-wiscord-smoke',
    web: { bind: '127.0.0.1', enabled: false, port: 0 },
    wiscord: {
      ...wiscord,
      baseUrl,
      projectName: 'Wiscord public smoke',
      workspacePath,
    },
  };
}

class HttpClient {
  accessToken = '';

  constructor(private readonly origin: string) {}

  async request<T = unknown>(route: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    if (authenticated && this.accessToken) headers.set('authorization', `Bearer ${this.accessToken}`);
    const response = await fetch(`${this.origin}${route}`, { ...init, headers });
    const body = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} ${route}: ${body.slice(0, 300)}`);
    return (body ? JSON.parse(body) : undefined) as T;
  }
}

class UserGateway {
  private readonly queue: GatewayFrame[] = [];
  private readonly waiters: Array<{
    predicate: (frame: GatewayFrame) => boolean;
    resolve: (frame: GatewayFrame) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as GatewayFrame;
      const waiter = this.waiters.find((candidate) => candidate.predicate(frame));
      if (!waiter) {
        this.queue.push(frame);
        return;
      }
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    });
    socket.on('close', () => {
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('user Gateway closed before expected event'));
      }
    });
  }

  static async connect(url: string, accessToken: string): Promise<UserGateway> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('user Gateway open timeout')), 10_000);
      socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const connection = new UserGateway(socket);
    socket.send(JSON.stringify({ op: 'AUTHENTICATE', token: accessToken }));
    return connection;
  }

  async waitFor(
    predicate: (frame: GatewayFrame) => boolean,
    label: string,
    timeoutMs = 10_000,
  ): Promise<GatewayFrame> {
    const queued = this.queue.find(predicate);
    if (queued) {
      this.queue.splice(this.queue.indexOf(queued), 1);
      return queued;
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        reject,
        resolve,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error(`timed out waiting for ${label}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  close(): void {
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close(1000, 'smoke complete');
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('WISCORD_BASE_URL must use http or https');
  }
  return url.toString().replace(/\/$/, '');
}

function toWebSocketUrl(value: string): string {
  const url = new URL(value);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await access(filePath);
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error(`timed out waiting for UI smoke stop file: ${filePath}`);
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(
    /(?:appSecret|accessToken|refreshToken|password|token)["'\s]*[:=]["'\s]*[^\s,"'}]+/gi,
    '$1=<redacted>',
  );
}
