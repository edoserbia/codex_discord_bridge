import { createServer } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';

import type { AppConfig } from '../src/config.js';
import type { CodexExecutionDriver, CodexRunHooks, RunningCodexJob } from '../src/codexRunner.js';
import { JsonStateStore } from '../src/store.js';
import type { ChannelBinding, CodexRunInput, CodexRunResult } from '../src/types.js';
import { WiscordCodexBridge } from '../src/wiscordBridge.js';

test('Wiscord adapter preserves the Discord live-progress format and freezes the completed status before the final result', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wiscord-bridge-'));
  const workspace = path.join(root, 'workspace');
  const state = new JsonStateStore(path.join(root, 'state.json'));
  await state.load();

  const timeline: string[] = [];
  const edits: string[] = [];
  const progressChunks: Array<{ content: string; index: number }> = [];
  const chunks: Array<{ content: string; index: number }> = [];
  const finalizations: string[] = [];
  const sockets = new Set<WebSocket>();
  const finalMarkdown = `# Complete Wiscord result\n\n${'long markdown '.repeat(700)}`;
  let heartbeatCount = 0;
  let runnerStarts = 0;
  let createdReplies = 0;

  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    response.setHeader('content-type', 'application/json');

    if (request.method === 'POST' && request.url === '/bot/v1/auth/token') {
      assert.deepEqual(body, { appId: 'app_test', appSecret: 'wsc_test' });
      response.end(JSON.stringify({ accessToken: 'bot_access' }));
      return;
    }
    assert.equal(request.headers.authorization, 'Bearer bot_access');
    if (request.method === 'GET' && request.url === '/bot/v1/messages/msg_user') {
      response.end(JSON.stringify({
        author: { id: 'user_1', kind: 'user' },
        content: '!codex run the integration',
        conversationId: 'channel_1',
        guildId: 'guild_1',
        id: 'msg_user',
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/bot/v1/messages') {
      assert.deepEqual(body, { conversationId: 'channel_1' });
      createdReplies += 1;
      response.statusCode = 201;
      response.end(JSON.stringify({ messageId: createdReplies === 1 ? 'msg_progress' : 'msg_final' }));
      return;
    }
    if (request.method === 'PATCH' && request.url === '/bot/v1/messages/msg_progress') {
      edits.push(String(body.content));
      response.end(JSON.stringify({ id: 'msg_progress' }));
      return;
    }
    if (request.method === 'POST' && request.url === '/bot/v1/messages/msg_progress/chunks') {
      progressChunks.push({ content: String(body.content), index: Number(body.index) });
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method === 'POST' && request.url === '/bot/v1/messages/msg_final/chunks') {
      chunks.push({ content: String(body.content), index: Number(body.index) });
      response.statusCode = 204;
      response.end();
      return;
    }
    if (
      request.method === 'POST'
      && (request.url === '/bot/v1/messages/msg_progress/finalize' || request.url === '/bot/v1/messages/msg_final/finalize')
    ) {
      const messageId = request.url.includes('msg_progress') ? 'msg_progress' : 'msg_final';
      finalizations.push(messageId);
      response.end(JSON.stringify({ id: messageId, status: 'complete' }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ code: 'NOT_FOUND' }));
  });
  const gateway = new WebSocketServer({ server, path: '/bot/v1/gateway' });
  gateway.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (frame.op === 'IDENTIFY') {
        assert.equal(frame.token, 'bot_access');
        socket.send(JSON.stringify({ op: 'READY', heartbeatIntervalMs: 25, sessionId: 'session_1' }));
      } else if (frame.op === 'ACK') {
        timeline.push(`ack:${frame.eventId}`);
      } else if (frame.op === 'HEARTBEAT') {
        heartbeatCount += 1;
        socket.send(JSON.stringify({ op: 'HEARTBEAT_ACK', sequence: frame.sequence }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');

  const runner: CodexExecutionDriver = {
    start(_binding: ChannelBinding, input: CodexRunInput, existingThreadId: string | undefined, hooks: CodexRunHooks = {}): RunningCodexJob {
      runnerStarts += 1;
      timeline.push('runner:start');
      assert.match(input.prompt, /run the integration/);
      assert.equal(input.engine, 'codex');
      assert.equal(existingThreadId, undefined);
      const done = (async (): Promise<CodexRunResult> => {
        await hooks.onThreadStarted?.('codex_thread_1');
        await hooks.onActivity?.('Codex is working');
        await hooks.onReasoning?.('The Bridge should retain every event category.');
        await hooks.onTodoListChanged?.([
          { id: 'inspect', text: 'Inspect the existing Bridge output', completed: true },
          { id: 'adapt', text: 'Adapt the Wiscord transport', completed: false },
        ]);
        await hooks.onCollabToolChanged?.({
          agentsStates: { 'agent-1': { nickname: 'reviewer', status: 'running' } },
          id: 'call-1',
          receiverThreadIds: ['agent-1'],
          senderThreadId: 'codex_thread_1',
          status: 'in_progress',
          tool: 'spawn_agent',
        });
        await hooks.onCommandStarted?.('pnpm test');
        await hooks.onCommandCompleted?.('pnpm test', 'all tests passed', 0);
        await hooks.onAgentMessage?.(finalMarkdown);
        return {
          agentMessages: [finalMarkdown],
          commands: [],
          codexThreadId: 'codex_thread_1',
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
  const config = buildConfig(root, workspace, `http://127.0.0.1:${address.port}`);
  const bridge = new WiscordCodexBridge(config, state, runner);

  try {
    await bridge.start();
    const socket = await waitForValue(() => [...sockets][0]);
    const event = {
      op: 'EVENT',
      event: {
        conversationId: 'channel_1',
        data: { messageId: 'msg_user' },
        eventId: 'evt_1',
        guildId: 'guild_1',
        sequence: 1,
        type: 'MESSAGE_CREATE',
        version: 1,
      },
    };
    socket.send(JSON.stringify(event));
    await waitForValue(() => finalizations.includes('msg_final') ? true : undefined);
    socket.send(JSON.stringify(event));
    await waitForValue(() => heartbeatCount > 0 ? heartbeatCount : undefined);

    assert.equal(runnerStarts, 1);
    assert.ok(timeline.indexOf('ack:evt_1') < timeline.indexOf('runner:start'));
    assert.ok(edits.some((content) => content.includes('Codex is working')));
    assert.ok(edits.some((content) => content.includes('Codex Discord Bridge 实时进度')));
    assert.ok(edits.some((content) => content.includes('计划：')));
    assert.ok(edits.some((content) => content.includes('子代理：')));
    assert.ok(edits.some((content) => content.includes('分析摘要：最新')));
    assert.ok(edits.some((content) => content.includes('当前命令：')));
    assert.ok(edits.some((content) => content.includes('最新输出预览：')));
    assert.ok(edits.some((content) => /当前命令：\[\d{2}:\d{2}:\d{2}\] `pnpm test`/.test(content)));
    assert.ok(edits.some((content) => /最新输出预览：\[\d{2}:\d{2}:\d{2}\]/.test(content)));
    assert.equal(createdReplies, 2);
    assert.deepEqual(finalizations, ['msg_progress', 'msg_final']);
    const completedProgress = progressChunks.map((chunk) => chunk.content).join('');
    assert.match(completedProgress, /Codex Discord Bridge 实时进度/);
    assert.match(completedProgress, /状态：已完成/);
    assert.match(completedProgress, /最近更新：/);
    const reconstructed = chunks.sort((left, right) => left.index - right.index).map((chunk) => chunk.content).join('');
    assert.match(reconstructed, /最终总结/);
    assert.match(reconstructed, /Wiscord Test/);
    assert.match(reconstructed, /Complete Wiscord result/);
    assert.equal(state.getSession('channel_1')?.codexThreadId, 'codex_thread_1');
  } finally {
    await bridge.stop();
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { force: true, recursive: true });
  }
});

test('Wiscord adapter answers !help in a second channel from the installed guild', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wiscord-bridge-help-'));
  const workspace = path.join(root, 'workspace');
  const state = new JsonStateStore(path.join(root, 'state.json'));
  await state.load();

  const edits: string[] = [];
  const helpChunks: string[] = [];
  const sockets = new Set<WebSocket>();
  let createdReplies = 0;

  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST' && request.url === '/bot/v1/auth/token') {
      response.end(JSON.stringify({ accessToken: 'bot_access' }));
      return;
    }
    assert.equal(request.headers.authorization, 'Bearer bot_access');
    if (request.method === 'GET' && request.url === '/bot/v1/messages/msg_help') {
      response.end(JSON.stringify({
        author: { id: 'user_1', kind: 'user' },
        content: '!help',
        conversationId: 'channel_2',
        guildId: 'guild_1',
        id: 'msg_help',
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/bot/v1/messages') {
      createdReplies += 1;
      assert.deepEqual(body, { conversationId: 'channel_2' });
      response.statusCode = 201;
      response.end(JSON.stringify({ messageId: 'msg_help_reply' }));
      return;
    }
    if (request.method === 'PATCH' && request.url === '/bot/v1/messages/msg_help_reply') {
      edits.push(String(body.content));
      response.end(JSON.stringify({ id: 'msg_help_reply' }));
      return;
    }
    if (request.method === 'POST' && request.url === '/bot/v1/messages/msg_help_reply/chunks') {
      helpChunks.push(String(body.content));
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method === 'POST' && request.url === '/bot/v1/messages/msg_help_reply/finalize') {
      response.end(JSON.stringify({ id: 'msg_help_reply', status: 'complete' }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ code: 'NOT_FOUND' }));
  });
  const gateway = new WebSocketServer({ server, path: '/bot/v1/gateway' });
  gateway.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (frame.op === 'IDENTIFY') {
        socket.send(JSON.stringify({ op: 'READY', heartbeatIntervalMs: 25 }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');

  const runner: CodexExecutionDriver = {
    start(): RunningCodexJob {
      throw new Error('!help must not start Codex');
    },
  };
  const bridge = new WiscordCodexBridge(
    buildConfig(root, workspace, `http://127.0.0.1:${address.port}`),
    state,
    runner,
  );

  try {
    await bridge.start();
    const socket = await waitForValue(() => [...sockets][0]);
    socket.send(JSON.stringify({
      op: 'EVENT',
      event: {
        conversationId: 'channel_2',
        data: { messageId: 'msg_help' },
        eventId: 'evt_help',
        guildId: 'guild_1',
        sequence: 1,
        type: 'MESSAGE_CREATE',
        version: 1,
      },
    }));
    await waitForValue(() => createdReplies > 0 ? createdReplies : undefined);
    await waitForValue(() => helpChunks.some((content) => content.includes('!bind')) ? true : undefined);
    const help = helpChunks.join('');
    assert.match(help, /Codex Discord Bridge 帮助/);
    assert.match(help, /!model status/);
    assert.match(help, /!effort status/);
    assert.match(help, /!queue/);
    assert.match(help, /!guide/);
  } finally {
    await bridge.stop();
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { force: true, recursive: true });
  }
});

test('Wiscord adapter binds a second channel to an allowed workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wiscord-bridge-bind-'));
  const workspace = path.join(root, 'workspace');
  const state = new JsonStateStore(path.join(root, 'state.json'));
  await state.load();

  const edits: string[] = [];
  const bindChunks: string[] = [];
  const sockets = new Set<WebSocket>();
  let createdReplies = 0;
  const command = `!bind wiscord ${workspace}`;

  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST' && request.url === '/bot/v1/auth/token') {
      response.end(JSON.stringify({ accessToken: 'bot_access' }));
      return;
    }
    assert.equal(request.headers.authorization, 'Bearer bot_access');
    if (request.method === 'GET' && request.url === '/bot/v1/messages/msg_bind') {
      response.end(JSON.stringify({
        author: { id: 'user_1', kind: 'user' },
        content: command,
        conversationId: 'channel_2',
        guildId: 'guild_1',
        id: 'msg_bind',
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/bot/v1/messages') {
      createdReplies += 1;
      assert.deepEqual(body, { conversationId: 'channel_2' });
      response.statusCode = 201;
      response.end(JSON.stringify({ messageId: 'msg_bind_reply' }));
      return;
    }
    if (request.method === 'PATCH' && request.url === '/bot/v1/messages/msg_bind_reply') {
      edits.push(String(body.content));
      response.end(JSON.stringify({ id: 'msg_bind_reply' }));
      return;
    }
    if (request.method === 'POST' && request.url === '/bot/v1/messages/msg_bind_reply/chunks') {
      bindChunks.push(String(body.content));
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method === 'POST' && request.url === '/bot/v1/messages/msg_bind_reply/finalize') {
      response.end(JSON.stringify({ id: 'msg_bind_reply', status: 'complete' }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ code: 'NOT_FOUND' }));
  });
  const gateway = new WebSocketServer({ server, path: '/bot/v1/gateway' });
  gateway.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (frame.op === 'IDENTIFY') socket.send(JSON.stringify({ op: 'READY', heartbeatIntervalMs: 25 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const bridge = new WiscordCodexBridge(
    buildConfig(root, workspace, `http://127.0.0.1:${address.port}`),
    state,
    { start: () => { throw new Error('!bind must not start Codex'); } },
  );

  try {
    await bridge.start();
    const socket = await waitForValue(() => [...sockets][0]);
    socket.send(JSON.stringify({
      op: 'EVENT',
      event: {
        conversationId: 'channel_2',
        data: { messageId: 'msg_bind' },
        eventId: 'evt_bind',
        guildId: 'guild_1',
        sequence: 1,
        type: 'MESSAGE_CREATE',
        version: 1,
      },
    }));
    await waitForValue(() => createdReplies > 0 ? createdReplies : undefined);
    await waitForValue(() => state.getBinding('channel_2'));
    assert.equal(state.getBinding('channel_2')?.workspacePath, await realpath(workspace));
    await waitForValue(() => bindChunks.some((content) => content.includes('已绑定')) ? true : undefined);
  } finally {
    await bridge.stop();
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { force: true, recursive: true });
  }
});

function buildConfig(root: string, workspace: string, baseUrl: string): AppConfig {
  return {
    adminUserIds: new Set(['user_1']),
    allowedWorkspaceRoots: [root],
    claudeCommand: 'claude',
    claudeSettingsPath: path.join(root, 'claude.json'),
    codexAppServerInterruptTimeoutMs: 1_000,
    codexAppServerRequestTimeoutMs: 1_000,
    codexAppServerStartupTimeoutMs: 1_000,
    codexAppServerTransport: 'stdio',
    codexAppServerTurnTimeoutMs: 5_000,
    codexCommand: 'codex',
    codexDriverMode: 'app-server',
    codexMaxAttempts: 1,
    codexRateLimitBaseDelayMs: 1,
    codexRateLimitMaxAttempts: 1,
    codexRateLimitMaxDelayMs: 1,
    commandPrefix: '!',
    dataDir: root,
    defaultCodex: {
      addDirs: [],
      approvalPolicy: 'never',
      extraConfig: [],
      sandboxMode: 'danger-full-access',
      search: false,
      skipGitRepoCheck: true,
    },
    discordToken: 'discord-test',
    web: { bind: '127.0.0.1', enabled: false, port: 0 },
    wiscord: {
      adminUserIds: new Set(['user_1']),
      appId: 'app_test',
      appSecret: 'wsc_test',
      baseUrl,
      channelId: 'channel_1',
      guildId: 'guild_1',
      projectName: 'Wiscord Test',
      workspacePath: workspace,
    },
  };
}

async function readJson(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

async function waitForValue<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for value');
}
