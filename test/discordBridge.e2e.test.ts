import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { FakeChannel, FakeMessage, createUserMessage } from './helpers/fakeDiscord.js';
import { createBridgeTestRig } from './helpers/bridgeSetup.js';
import { cleanupDir, createWorkspace, makeTempDir, startStaticServer, waitFor } from './helpers/testUtils.js';

const fakeCodexCommand = path.resolve('test/fixtures/fake-codex.mjs');
const fakeAppServerCommand = path.resolve('test/fixtures/fake-codex-app-server.mjs');
const fakeFallbackCommand = path.resolve('test/fixtures/fake-codex-app-server-fallback.mjs');
const fakeAppServerWrapperCommand = path.resolve('test/fixtures/fake-codex-app-server-wrapper.mjs');
const fakeTurnFallbackCommand = path.resolve('test/fixtures/fake-codex-app-server-turn-fallback.mjs');
const fakeInitializeHangCommand = path.resolve('test/fixtures/fake-codex-app-server-initialize-hang.mjs');

async function dispatch(bridge: unknown, message: unknown): Promise<void> {
  await (bridge as any).handleMessage(message as any);
}

function findSent(channel: FakeChannel, pattern: RegExp): boolean {
  return channel.sent.some((message) => pattern.test(message.content));
}

function findSentFile(channel: FakeChannel, pattern?: RegExp): boolean {
  return channel.sent.some((message) => {
    if (message.sentFiles.length === 0) {
      return false;
    }

    if (!pattern) {
      return true;
    }

    return message.sentFiles.some((file) => {
      const value = typeof file === 'string' ? file : `${file.name ?? ''} ${file.attachment}`;
      return pattern.test(value);
    });
  });
}

async function readStateFile(rootDir: string): Promise<any> {
  return JSON.parse(await readFile(path.join(rootDir, 'data', 'state.json'), 'utf8'));
}

async function writeStateFile(rootDir: string, nextState: any): Promise<void> {
  await writeFile(path.join(rootDir, 'data', 'state.json'), JSON.stringify(nextState, null, 2), 'utf8');
}

test('bridge binds a root channel and reuses session on follow-up prompts', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-root-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, store, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-root', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
  assert.equal(store.getBinding(rootChannel.id)?.projectName, 'api');

  await dispatch(bridge, createUserMessage(rootChannel, 'first prompt'));
  await waitFor(() => findSent(rootChannel, /ok: first prompt/));

  const firstSession = store.getSession(rootChannel.id);
  assert.ok(firstSession?.codexThreadId);

  await dispatch(bridge, createUserMessage(rootChannel, '[command] second prompt'));
  await waitFor(() => findSent(rootChannel, /resumed=true/));

  const secondSession = store.getSession(rootChannel.id);
  assert.equal(secondSession?.codexThreadId, firstSession?.codexThreadId);
  await cleanupDir(rootDir);
});

test('bridge can drive manual sessions through app-server and reuse the same official thread', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-app-server-manual-');
  const workspace = await createWorkspace(rootDir);
  const logDir = path.join(rootDir, 'fake-app-server-logs');
  process.env.FAKE_CODEX_APP_SERVER_LOG_DIR = logDir;
  const { bridge, store, channels } = await (createBridgeTestRig as any)({
    rootDir,
    codexCommand: fakeAppServerCommand,
    driverMode: 'app-server',
  });
  const rootChannel = new FakeChannel('channel-app-server-manual', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, '[app-plan] first prompt'));
    await waitFor(() => rootChannel.sent.some((message) => /🤖 \*\*api\*\*/.test(message.content)
      && /app-server ok: \[app-plan\] first prompt/.test(message.content)), 15_000);

    const firstSession = store.getSession(rootChannel.id);
    assert.ok(firstSession?.codexThreadId);
    assert.equal((firstSession as any)?.driver, 'app-server');

    await dispatch(bridge, createUserMessage(rootChannel, 'second prompt'));
    await waitFor(() => rootChannel.sent.some((message) => /🤖 \*\*api\*\*/.test(message.content)
      && /app-server ok: second prompt/.test(message.content)), 15_000);

    const secondSession = store.getSession(rootChannel.id);
    assert.equal(secondSession?.codexThreadId, firstSession?.codexThreadId);
  } finally {
    await (bridge as any).stop?.();
    delete process.env.FAKE_CODEX_APP_SERVER_LOG_DIR;
    await cleanupDir(rootDir);
  }
});

test('bridge status defaults to app-server for a fresh app-server session before the first run', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-app-server-status-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeAppServerCommand,
    driverMode: 'app-server',
  });
  const rootChannel = new FakeChannel('channel-app-server-status', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, '!status', { userId: 'admin-user' }));

    await waitFor(() => rootChannel.sent.some((message) => /Codex Bridge 状态面板/.test(message.content)), 15_000);
    assert.ok(rootChannel.sent.some((message) => /驱动：app-server/.test(message.content)));
  } finally {
    await (bridge as any).stop?.();
    await cleanupDir(rootDir);
  }
});

test('bridge bind defaults match local full-access app-server execution settings', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-app-server-bind-defaults-');
  const workspace = await createWorkspace(rootDir);
  const logDir = path.join(rootDir, 'fake-app-server-bind-defaults-logs');
  process.env.FAKE_CODEX_APP_SERVER_LOG_DIR = logDir;
  const { bridge, store, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeAppServerCommand,
    driverMode: 'app-server',
  });
  const rootChannel = new FakeChannel('channel-app-server-bind-defaults', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));

    const binding = store.getBinding(rootChannel.id);
    assert.equal(binding?.codex.sandboxMode, 'danger-full-access');
    assert.equal(binding?.codex.approvalPolicy, 'never');
    assert.equal(binding?.codex.search, true);
    assert.ok(findSent(rootChannel, /执行模式：sandbox=`danger-full-access` · approval=`never` · search=on/));

    await dispatch(bridge, createUserMessage(rootChannel, 'check default app-server settings'));
    await waitFor(() => rootChannel.sent.some((message) => /app-server ok: check default app-server settings/.test(message.content)), 15_000);

    const logFiles = await readdir(logDir);
    const payloads = await Promise.all(logFiles.map(async (fileName) => JSON.parse(await readFile(path.join(logDir, fileName), 'utf8')) as {
      method: string;
      params: Record<string, any>;
    }));
    const threadStart = payloads.find((payload) => payload.method === 'thread/start');
    const turnStart = payloads.find((payload) => payload.method === 'turn/start');

    assert.ok(threadStart);
    assert.ok(turnStart);
    assert.equal(threadStart!.params.sandbox, 'danger-full-access');
    assert.equal(threadStart!.params.approvalPolicy, 'never');
    assert.equal(threadStart!.params.config.web_search, 'live');
    assert.equal(turnStart!.params.approvalPolicy, 'never');
    assert.equal(turnStart!.params.sandboxPolicy.type, 'dangerFullAccess');
  } finally {
    delete process.env.FAKE_CODEX_APP_SERVER_LOG_DIR;
    await (bridge as any).stop?.();
    await cleanupDir(rootDir);
  }
});


test('bridge resets existing Codex sessions when bind execution settings change', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-rebind-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, store, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-rebind', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannel, 'first prompt'));
  await waitFor(() => findSent(rootChannel, /ok: first prompt/));

  const firstSession = store.getSession(rootChannel.id);
  assert.ok(firstSession?.codexThreadId);

  await dispatch(
    bridge,
    createUserMessage(rootChannel, `!bind api "${workspace}" --sandbox danger-full-access --approval never --search on`, {
      userId: 'admin-user',
    }),
  );

  await dispatch(bridge, createUserMessage(rootChannel, '[command] after rebind'));
  await waitFor(() => findSent(rootChannel, /resumed=false/));
  await cleanupDir(rootDir);
});

test('bridge can inject guide prompts into an active run and continue on the same session', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-guide-');
  const workspace = await createWorkspace(rootDir);
  const logDir = path.join(rootDir, 'fake-codex-logs');
  process.env.FAKE_CODEX_LOG_DIR = logDir;
  const { bridge, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-guide', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, '[slow] first task'));
    await waitFor(() => (bridge as any).getDashboardData().some((entry: any) => entry.conversations.some((conversation: any) => conversation.status === 'running' || conversation.status === 'starting')));

    await dispatch(bridge, createUserMessage(rootChannel, '!guide 现在先优先检查 README，然后继续完成原任务', { userId: 'admin-user' }));
    await waitFor(() => findSent(rootChannel, /先处理中途引导，再继续原任务/));
    await waitFor(() => findSent(rootChannel, /resumed=true/), 15_000);
    await waitFor(() => findSent(rootChannel, /README/), 15_000);
    await waitFor(async () => {
      const logFiles = await readdir(logDir).catch(() => []);
      return logFiles.length >= 2;
    }, 15_000);

    const logFiles = await readdir(logDir);
    const payloads = await Promise.all(logFiles.map(async (fileName) => JSON.parse(await readFile(path.join(logDir, fileName), 'utf8')) as {
      args: { mode: string };
      prompt: string;
    }));
    const resumedPayload = payloads.find((payload) => payload.args.mode === 'resume');

    assert.ok(resumedPayload);
    assert.match(resumedPayload.prompt, /\[slow\] first task/);
    assert.match(resumedPayload.prompt, /现在先优先检查 README，然后继续完成原任务/);
    assert.match(resumedPayload.prompt, /请先处理下面的最新引导，再继续完成原始任务/);
    assert.ok(!findSent(rootChannel, /已加入队列/));
  } finally {
    delete process.env.FAKE_CODEX_LOG_DIR;
    await cleanupDir(rootDir);
  }
});

test('bridge routes !guide to app-server steer without synthetic wrapper prompts', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-app-server-guide-');
  const workspace = await createWorkspace(rootDir);
  const logDir = path.join(rootDir, 'fake-app-server-guide-logs');
  process.env.FAKE_CODEX_APP_SERVER_LOG_DIR = logDir;
  const { bridge, channels } = await (createBridgeTestRig as any)({
    rootDir,
    codexCommand: fakeAppServerCommand,
    driverMode: 'app-server',
  });
  const rootChannel = new FakeChannel('channel-app-server-guide', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, '[app-slow] first task'));
    await waitFor(() => (bridge as any).getDashboardData().some((entry: any) => entry.conversations.some((conversation: any) => conversation.status === 'running' || conversation.status === 'starting')), 15_000);

    await dispatch(bridge, createUserMessage(rootChannel, '!guide 现在先检查 README', { userId: 'admin-user' }));
    await waitFor(async () => {
      const files = await readdir(logDir).catch(() => []);
      return files.length >= 3;
    }, 15_000);

    const logFiles = await readdir(logDir);
    const payloads = await Promise.all(logFiles.map(async (fileName) => JSON.parse(await readFile(path.join(logDir, fileName), 'utf8')) as {
      method: string;
      params: Record<string, unknown>;
    }));
    const steerRequest = payloads.find((payload) => payload.method === 'turn/steer');

    assert.ok(steerRequest);
    assert.equal((steerRequest!.params.input as Array<{ text: string }>)[0]?.text, '现在先检查 README');
    assert.ok(!payloads.some((payload) => payload.method === 'turn/start'
      && JSON.stringify(payload.params).includes('请先处理下面的最新引导，再继续完成原始任务')));

    await dispatch(bridge, createUserMessage(rootChannel, '!cancel', { userId: 'admin-user' }));
    await waitFor(async () => {
      const latestLogFiles = await readdir(logDir).catch(() => []);
      const latestPayloads = await Promise.all(latestLogFiles.map(async (fileName) => JSON.parse(await readFile(path.join(logDir, fileName), 'utf8')) as {
        method: string;
        params: Record<string, unknown>;
      }));
      return latestPayloads.some((payload) => payload.method === 'turn/interrupt');
    }, 15_000);
    await waitFor(() => !(bridge as any).getDashboardData().some((entry: any) => entry.conversations.some((conversation: any) => ['starting', 'running'].includes(conversation.status))), 15_000);
  } finally {
    await (bridge as any).stop?.();
    delete process.env.FAKE_CODEX_APP_SERVER_LOG_DIR;
    await cleanupDir(rootDir);
  }
});

test('bridge keeps live reasoning, command, and subagent progress in app-server mode', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-app-server-progress-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeAppServerCommand,
    driverMode: 'app-server',
  });
  const rootChannel = new FakeChannel('channel-app-server-progress', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, '[app-rich] show me live progress'));

    await waitFor(() => rootChannel.sent.some((message) => /Codex 实时进度/.test(message.content)), 15_000);
    const progressMessage = rootChannel.sent.find((message) => /Codex 实时进度/.test(message.content));
    assert.ok(progressMessage);

    await waitFor(() => /Inspecting request and planning next steps\./.test(progressMessage!.content), 15_000);
    await waitFor(() => /当前命令：/.test(progressMessage!.content), 15_000);
    await waitFor(() => /子代理：/.test(progressMessage!.content), 15_000);
    assert.match(progressMessage!.content, /Inspecting request and planning next steps\./);
    assert.match(progressMessage!.content, /当前命令：/);
    assert.match(progressMessage!.content, /\/bin\/zsh -lc "pwd"/);
    assert.match(progressMessage!.content, /子代理：/);
    assert.match(progressMessage!.content, /拉起子代理/);
    assert.match(progressMessage!.content, /Investigate the login flow/);
    await waitFor(() => rootChannel.sent.some((message) => /🤖 \*\*api\*\*/.test(message.content)
      && /app-server ok: \[app-rich\] show me live progress/.test(message.content)), 15_000);
  } finally {
    await (bridge as any).stop?.();
    await cleanupDir(rootDir);
  }
});

test('bridge keeps streaming app-server deltas out of the process timeline while preserving the final answer', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-app-server-streaming-progress-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeAppServerCommand,
    driverMode: 'app-server',
  });
  const rootChannel = new FakeChannel('channel-app-server-streaming-progress', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, '[app-rich-stream] show step progress'));

    await waitFor(() => rootChannel.sent.some((message) => /Codex 实时进度/.test(message.content)), 15_000);
    const progressMessage = rootChannel.sent.find((message) => /Codex 实时进度/.test(message.content));
    assert.ok(progressMessage);

    await waitFor(() => /Inspecting request and planning next steps\./.test(progressMessage!.content), 15_000);
    await waitFor(() => /stream ok: \[app-rich-stream\] show step progress/.test(progressMessage!.content), 15_000);
    await waitFor(() => rootChannel.sent.some((message) => /🤖 \*\*api\*\*/.test(message.content)
      && /app-server stream ok: \[app-rich-stream\] show step progress/.test(message.content)), 15_000);

    assert.doesNotMatch(progressMessage!.content, /- \[\d{2}:\d{2}\] 🧠 /);
    assert.doesNotMatch(progressMessage!.content, /- \[\d{2}:\d{2}\] 💬 /);
    assert.match(progressMessage!.content, /- \[\d{2}:\d{2}\] ▶️ \/bin\/zsh -lc "pwd"/);
    assert.match(progressMessage!.content, /- \[\d{2}:\d{2}\] 🤝 /);
    assert.match(progressMessage!.content, /- \[\d{2}:\d{2}\] 🔄 本轮已完成/);
  } finally {
    await (bridge as any).stop?.();
    await cleanupDir(rootDir);
  }
});

test('bridge does not let slow Discord progress edits throttle app-server streaming turns', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-app-server-slow-discord-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeAppServerCommand,
    driverMode: 'app-server',
  });
  const rootChannel = new FakeChannel('channel-app-server-slow-discord', 'guild-1');
  channels.set(rootChannel.id, rootChannel);
  const originalEdit = FakeMessage.prototype.edit;

  FakeMessage.prototype.edit = async function slowEdit(this: FakeMessage, content: string): Promise<any> {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return originalEdit.call(this, content);
  };

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    const startedAt = Date.now();
    await dispatch(bridge, createUserMessage(rootChannel, '[app-rich-stream] show step progress'));

    await waitFor(() => rootChannel.sent.some((message) => /🤖 \*\*api\*\*/.test(message.content)
      && /app-server stream ok: \[app-rich-stream\] show step progress/.test(message.content)), 5_000);

    assert.ok(Date.now() - startedAt < 5_000);
  } finally {
    FakeMessage.prototype.edit = originalEdit;
    await (bridge as any).stop?.();
    await cleanupDir(rootDir);
  }
});

test('bridge reset interrupts the active app-server turn and clears persisted session state', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-app-server-reset-');
  const workspace = await createWorkspace(rootDir);
  const logDir = path.join(rootDir, 'fake-app-server-reset-logs');
  process.env.FAKE_CODEX_APP_SERVER_LOG_DIR = logDir;
  const { bridge, store, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeAppServerCommand,
    driverMode: 'app-server',
  });
  const rootChannel = new FakeChannel('channel-app-server-reset', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, '[app-slow] reset me'));
    await waitFor(() => (bridge as any).getDashboardData().some((entry: any) => entry.conversations.some((conversation: any) => ['starting', 'running'].includes(conversation.status))), 15_000);

    await dispatch(bridge, createUserMessage(rootChannel, '!reset', { userId: 'admin-user' }));
    await waitFor(async () => {
      const latestLogFiles = await readdir(logDir).catch(() => []);
      const latestPayloads = await Promise.all(latestLogFiles.map(async (fileName) => JSON.parse(await readFile(path.join(logDir, fileName), 'utf8')) as {
        method: string;
        params: Record<string, unknown>;
      }));
      const hasInterrupt = latestPayloads.some((payload) => payload.method === 'turn/interrupt');
      const runStopped = !(bridge as any).getDashboardData().some((entry: any) => entry.conversations.some((conversation: any) => ['starting', 'running', 'cancelled'].includes(conversation.status)));
      return hasInterrupt || runStopped;
    }, 15_000);
    await waitFor(() => !(bridge as any).getDashboardData().some((entry: any) => entry.conversations.some((conversation: any) => ['starting', 'running', 'cancelled'].includes(conversation.status))), 15_000);

    const session = store.getSession(rootChannel.id);
    assert.equal(session?.codexThreadId, undefined);
    assert.equal((session as any)?.driver, undefined);
  } finally {
    await (bridge as any).stop?.();
    delete process.env.FAKE_CODEX_APP_SERVER_LOG_DIR;
    await cleanupDir(rootDir);
  }
});

test('bridge posts timestamped fallback activation and recovery notices when app-server degrades', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-app-server-fallback-');
  const workspace = await createWorkspace(rootDir);
  process.env.FAKE_CODEX_APP_SERVER_FALLBACK_STATE_FILE = path.join(rootDir, 'app-server-fallback-state');
  const { bridge, store, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeFallbackCommand,
    driverMode: 'app-server',
  });
  const rootChannel = new FakeChannel('channel-app-server-fallback', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, 'first prompt'));
    await waitFor(() => rootChannel.sent.some((message) => /\[\d{2}:\d{2}\].*legacy-exec.*fallback/i.test(message.content)), 15_000);
    await waitFor(() => rootChannel.sent.some((message) => /ok: first prompt/.test(message.content)), 15_000);

    let session = store.getSession(rootChannel.id);
    assert.equal(session?.driver, 'legacy-exec');
    assert.equal(session?.fallbackActive, true);

    await dispatch(bridge, createUserMessage(rootChannel, 'second prompt'));
    await waitFor(() => rootChannel.sent.some((message) => /\[\d{2}:\d{2}\].*app-server.*恢复/i.test(message.content)), 15_000);
    await waitFor(() => rootChannel.sent.some((message) => /app-server ok: second prompt/.test(message.content)), 15_000);

    session = store.getSession(rootChannel.id);
    assert.equal(session?.driver, 'app-server');
    assert.equal(session?.fallbackActive, false);
  } finally {
    await (bridge as any).stop?.();
    delete process.env.FAKE_CODEX_APP_SERVER_FALLBACK_STATE_FILE;
    await cleanupDir(rootDir);
  }
});

test('bridge surfaces actionable fallback guidance for obsolete full-permission Codex config errors', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-app-server-config-compat-');
  const workspace = await createWorkspace(rootDir);
  process.env.FAKE_CODEX_APP_SERVER_FALLBACK_STATE_FILE = path.join(rootDir, 'app-server-fallback-state');
  process.env.FAKE_CODEX_APP_SERVER_FALLBACK_STDERR = '\u001b[2m2026-03-21T14:45:04.295261Z\u001b[0m \u001b[31mERROR\u001b[0m codex_app_server: Permissions profile `full` does not define any recognized filesystem entries for this version of Codex. Filesystem access will remain restricted. Upgrade Codex if this profile expects filesystem permissions.';
  const { bridge, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeFallbackCommand,
    driverMode: 'app-server',
  });
  const rootChannel = new FakeChannel('channel-app-server-config-compat', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, 'first prompt'));

    await waitFor(() => rootChannel.sent.some((message) => /default_permissions="full"/.test(message.content)), 15_000);

    const fallbackNotice = rootChannel.sent.find((message) => /default_permissions="full"/.test(message.content));
    assert.ok(fallbackNotice);
    assert.match(fallbackNotice.content, /\[permissions\.full\]/);
    assert.doesNotMatch(fallbackNotice.content, /\u001b\[/);
  } finally {
    await (bridge as any).stop?.();
    delete process.env.FAKE_CODEX_APP_SERVER_FALLBACK_STATE_FILE;
    delete process.env.FAKE_CODEX_APP_SERVER_FALLBACK_STDERR;
    await cleanupDir(rootDir);
  }
});

test('bridge progress cards keep the current driver mode visible and render named subagents', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-app-server-progress-driver-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeAppServerCommand,
    driverMode: 'app-server',
  });
  const rootChannel = new FakeChannel('channel-app-server-progress-driver', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, '[app-rich] show me progress'));

    await waitFor(() => rootChannel.sent.some((message) => /🛰️ \*\*Codex 实时进度\*\*/.test(message.content)
      && /驱动：app-server/.test(message.content)
      && /auth-scout/.test(message.content)), 15_000);
  } finally {
    await (bridge as any).stop?.();
    await cleanupDir(rootDir);
  }
});

test('bridge keeps legacy fallback mode visible in the live progress card after refreshes', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-progress-fallback-sticky-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeTurnFallbackCommand,
    driverMode: 'app-server',
  });
  const rootChannel = new FakeChannel('channel-progress-fallback-sticky', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, '[cancel] first prompt'));

    await waitFor(() => rootChannel.sent.some((message) => /🛰️ \*\*Codex 实时进度\*\*/.test(message.content)
      && /驱动：legacy-exec（fallback）/.test(message.content)), 15_000);
  } finally {
    await dispatch(bridge, createUserMessage(rootChannel, '!cancel', { userId: 'admin-user' })).catch(() => undefined);
    await (bridge as any).stop?.();
    await cleanupDir(rootDir);
  }
});

test('bridge falls back when app-server dies after creating a thread but before the turn engages', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-app-server-turn-fallback-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, store, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeTurnFallbackCommand,
    driverMode: 'app-server',
  });
  const rootChannel = new FakeChannel('channel-app-server-turn-fallback', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, 'first prompt'));

    await waitFor(() => rootChannel.sent.some((message) => /\[\d{2}:\d{2}\].*legacy-exec.*fallback/i.test(message.content)), 15_000);
    await waitFor(() => rootChannel.sent.some((message) => /ok: first prompt/.test(message.content)), 15_000);

    const session = store.getSession(rootChannel.id);
    assert.equal(session?.driver, 'legacy-exec');
    assert.equal(session?.fallbackActive, true);
  } finally {
    await (bridge as any).stop?.();
    await cleanupDir(rootDir);
  }
});

test('bridge falls back when app-server initialize hangs so queued messages do not stay blocked forever', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-app-server-initialize-timeout-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, store, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeInitializeHangCommand,
    driverMode: 'app-server',
    appServerStartupTimeoutMs: 200,
  });
  const rootChannel = new FakeChannel('channel-app-server-initialize-timeout', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, 'first prompt'));

    await waitFor(() => rootChannel.sent.some((message) => /\[\d{2}:\d{2}\].*legacy-exec.*fallback/i.test(message.content)), 15_000);
    await waitFor(() => rootChannel.sent.some((message) => /ok: first prompt/.test(message.content)), 15_000);

    const session = store.getSession(rootChannel.id);
    assert.equal(session?.driver, 'legacy-exec');
    assert.equal(session?.fallbackActive, true);
  } finally {
    await (bridge as any).stop?.();
    await cleanupDir(rootDir);
  }
});

test('bridge falls back to queued guidance instead of native steer after the active run switches to legacy fallback', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-app-server-fallback-guide-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeTurnFallbackCommand,
    driverMode: 'app-server',
  });
  const rootChannel = new FakeChannel('channel-app-server-fallback-guide', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, '[cancel] first prompt'));
    await waitFor(() => rootChannel.sent.some((message) => /\[\d{2}:\d{2}\].*legacy-exec.*fallback/i.test(message.content)), 15_000);
    await waitFor(() => (bridge as any).getDashboardData().some((entry: any) => entry.conversations.some((conversation: any) => ['starting', 'running'].includes(conversation.status))), 15_000);

    const sentCountBeforeGuide = rootChannel.sent.length;
    await dispatch(bridge, createUserMessage(rootChannel, '!guide 现在先检查 README', { userId: 'admin-user' }));

    await waitFor(() => rootChannel.sent
      .slice(sentCountBeforeGuide)
      .some((message) => /正在中断当前步骤，先处理中途引导，再继续原任务/.test(message.content)), 15_000);
    assert.ok(!rootChannel.sent
      .slice(sentCountBeforeGuide)
      .some((message) => /继续在当前轮次处理中途引导/.test(message.content)));
  } finally {
    await (bridge as any).stop?.();
    await cleanupDir(rootDir);
  }
});

test('bridge keeps app-server active outside git repos when skipGitRepoCheck is enabled', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-app-server-non-git-fallback-');
  const workspace = await createWorkspace(rootDir, { git: false });
  const logDir = path.join(rootDir, 'fake-app-server-non-git-logs');
  process.env.FAKE_CODEX_APP_SERVER_LOG_DIR = logDir;
  const { bridge, store, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeAppServerWrapperCommand,
    driverMode: 'app-server',
  });
  const rootChannel = new FakeChannel('channel-app-server-non-git-fallback', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, 'first prompt'));

    await waitFor(() => rootChannel.sent.some((message) => /app-server ok: first prompt/.test(message.content)), 15_000);

    const session = store.getSession(rootChannel.id);
    assert.equal(session?.driver, 'app-server');
    assert.notEqual(session?.fallbackActive, true);

    assert.ok(!rootChannel.sent.some((message) => /\[\d{2}:\d{2}\].*legacy-exec.*fallback/i.test(message.content)));

    const appServerLogs = await readdir(logDir).catch(() => []);
    assert.ok(appServerLogs.length > 0);
  } finally {
    await (bridge as any).stop?.();
    delete process.env.FAKE_CODEX_APP_SERVER_LOG_DIR;
    await cleanupDir(rootDir);
  }
});

test('bridge does not announce app-server recovery when a fallback session falls back again before engagement', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-app-server-repeated-fallback-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, store, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeTurnFallbackCommand,
    driverMode: 'app-server',
  });
  const rootChannel = new FakeChannel('channel-app-server-repeated-fallback', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, 'first prompt'));
    await waitFor(() => rootChannel.sent.some((message) => /\[\d{2}:\d{2}\].*legacy-exec.*fallback/i.test(message.content)), 15_000);
    await waitFor(() => rootChannel.sent.some((message) => /ok: first prompt/.test(message.content)), 15_000);

    const recoveryNoticeCountBefore = rootChannel.sent.filter((message) => /app-server.*恢复/.test(message.content)).length;

    await dispatch(bridge, createUserMessage(rootChannel, 'second prompt'));
    await waitFor(() => rootChannel.sent.some((message) => /ok: second prompt/.test(message.content)), 15_000);

    const recoveryNoticeCountAfter = rootChannel.sent.filter((message) => /app-server.*恢复/.test(message.content)).length;
    assert.equal(recoveryNoticeCountAfter, recoveryNoticeCountBefore);

    const session = store.getSession(rootChannel.id);
    assert.equal(session?.driver, 'legacy-exec');
    assert.equal(session?.fallbackActive, true);
  } finally {
    await (bridge as any).stop?.();
    await cleanupDir(rootDir);
  }
});

test('bridge returns tokenized web access links via !web', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-web-command-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeCodexCommand,
    webEnabled: true,
    webBind: '0.0.0.0',
    webPort: 3769,
    webAuthToken: 'secret-token',
  });
  const rootChannel = new FakeChannel('channel-web-command', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, '!web', { userId: 'admin-user' }));

    await waitFor(() => rootChannel.sent.some((message) => /\?token=secret-token/.test(message.content)), 15_000);
    assert.ok(rootChannel.sent.some((message) => /127\.0\.0\.1:3769/.test(message.content)));
  } finally {
    await (bridge as any).stop?.();
    await cleanupDir(rootDir);
  }
});

test('bridge allows binding in a regular channel under a Discord category', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-category-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, store, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const categoryChildChannel = new FakeChannel('channel-category-child', 'guild-1', 'category-1', false);
  channels.set(categoryChildChannel.id, categoryChildChannel);

  await dispatch(bridge, createUserMessage(categoryChildChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));

  assert.equal(store.getBinding(categoryChildChannel.id)?.projectName, 'api');
  assert.ok(!findSent(categoryChildChannel, /请在主频道执行 `!bind`/));
  await cleanupDir(rootDir);
});

test('bridge gives Discord threads their own Codex session under the parent binding', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-thread-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, store, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-root', 'guild-1');
  const threadChannel = new FakeChannel('thread-1', 'guild-1', 'channel-root', true);
  channels.set(rootChannel.id, rootChannel);
  channels.set(threadChannel.id, threadChannel);

  await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(threadChannel, '[command] thread task'));
  await waitFor(() => findSent(threadChannel, /thread task/));

  const threadSession = store.getSession(threadChannel.id);
  assert.equal(threadSession?.bindingChannelId, rootChannel.id);
  assert.ok(threadSession?.codexThreadId);
  assert.ok(threadChannel.sent.some((message) => /Discord 线程会话/.test(message.content)));
  await cleanupDir(rootDir);
});

test('bridge creates an autopilot thread and pinned entry card on bind', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-autopilot-bind-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, store, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-autopilot-root', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));

  const autopilotProject = store.getAutopilotProject(rootChannel.id);
  assert.ok(autopilotProject?.threadChannelId);
  assert.equal(autopilotProject?.enabled, false);
  assert.ok(rootChannel.sent.some((message) => /Autopilot 入口/.test(message.content)));
  assert.ok(rootChannel.sent.some((message) => message.pinned));
  assert.ok(rootChannel.sent.some((message) => /项目级调度默认暂停/.test(message.content)));

  const autopilotThread = channels.get(autopilotProject!.threadChannelId!);
  assert.ok(autopilotThread);
  assert.ok(autopilotThread!.sent.some((message) => /Autopilot 线程/.test(message.content)));
  await cleanupDir(rootDir);
});

test('bridge reset cancels a run that is still waiting to attach its real job handle', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-reset-pending-job-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, store, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-reset-pending-job', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));

    (bridge as any).client.channels.fetch = async (channelId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      return channels.get(channelId) ?? null;
    };

    const promptDispatch = dispatch(bridge, createUserMessage(rootChannel, '[slow] first prompt'));
    await waitFor(() => (bridge as any).getDashboardData().some((entry: any) => entry.conversations.some((conversation: any) => conversation.status === 'starting')), 15_000);

    await dispatch(bridge, createUserMessage(rootChannel, '!reset', { userId: 'admin-user' }));
    await waitFor(() => rootChannel.sent.some((message) => /Codex 上下文已重置/.test(message.content)), 15_000);

    await promptDispatch;
    await new Promise((resolve) => setTimeout(resolve, 3_500));

    assert.ok(!rootChannel.sent.some((message) => /ok: \[slow\] first prompt/.test(message.content)));
    assert.equal(store.getSession(rootChannel.id)?.codexThreadId, undefined);
    assert.ok(!(bridge as any).getDashboardData().some((entry: any) => entry.conversations.some((conversation: any) => ['starting', 'running'].includes(conversation.status))));
  } finally {
    await (bridge as any).stop?.();
    await cleanupDir(rootDir);
  }
});

test('autopilot help is available in unbound channels and server commands apply to all bound projects', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-autopilot-help-');
  const workspaceA = await createWorkspace(path.join(rootDir, 'a'));
  const workspaceB = await createWorkspace(path.join(rootDir, 'b'));
  const { bridge, store, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannelA = new FakeChannel('channel-autopilot-help-a', 'guild-1');
  const rootChannelB = new FakeChannel('channel-autopilot-help-b', 'guild-2');
  const controlChannel = new FakeChannel('channel-autopilot-help-control', 'guild-9');
  channels.set(rootChannelA.id, rootChannelA);
  channels.set(rootChannelB.id, rootChannelB);
  channels.set(controlChannel.id, controlChannel);

  await dispatch(bridge, createUserMessage(rootChannelA, `!bind aaa "${workspaceA}"`, { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannelB, `!bind bbb "${workspaceB}"`, { userId: 'admin-user' }));

  await dispatch(bridge, createUserMessage(controlChannel, '!autopilot'));
  assert.ok(controlChannel.sent.some((message) => /Autopilot 使用说明/.test(message.content)));

  await dispatch(bridge, createUserMessage(controlChannel, '!autopilot status'));
  assert.ok(controlChannel.sent.some((message) => /Autopilot 服务级状态/.test(message.content)));
  assert.ok(controlChannel.sent.some((message) => /已绑定项目：2/.test(message.content)));
  assert.equal(store.getAutopilotService('guild-1')?.parallelism, 5);
  assert.equal(store.getAutopilotService('guild-2')?.parallelism, 5);

  await dispatch(bridge, createUserMessage(controlChannel, '!autopilot server on', { userId: 'admin-user' }));
  assert.equal(store.getAutopilotService('guild-1')?.enabled, true);
  assert.equal(store.getAutopilotService('guild-2')?.enabled, true);

  await dispatch(bridge, createUserMessage(controlChannel, '!autopilot server concurrency 2', { userId: 'admin-user' }));
  assert.equal(store.getAutopilotService('guild-1')?.parallelism, 2);
  assert.equal(store.getAutopilotService('guild-2')?.parallelism, 2);
  assert.ok(controlChannel.sent.some((message) => /服务级 Autopilot 并行数设置为 2/.test(message.content)));

  await dispatch(bridge, createUserMessage(controlChannel, '!autopilot server off', { userId: 'admin-user' }));
  assert.equal(store.getAutopilotService('guild-1')?.enabled, false);
  assert.equal(store.getAutopilotService('guild-2')?.enabled, false);
  await cleanupDir(rootDir);
});

test('project-level autopilot commands update interval, prompt, and enabled state', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-autopilot-project-cmd-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, store, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-autopilot-project-cmd', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannel, '!autopilot project interval 30m', { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannel, '!autopilot project prompt 优先补测试和稳定性，不要做大功能', { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannel, '!autopilot project on', { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannel, '!autopilot project status', { userId: 'admin-user' }));

  const autopilotProject = store.getAutopilotProject(rootChannel.id);
  assert.equal(autopilotProject?.intervalMs, 30 * 60 * 1000);
  assert.equal(autopilotProject?.enabled, true);
  assert.match(autopilotProject?.brief ?? '', /优先补测试和稳定性/);
  assert.ok(rootChannel.sent.some((message) => /已更新 \*\*api\*\* 的项目级 Autopilot 设置/.test(message.content)));
  assert.ok(rootChannel.sent.some((message) => /Autopilot 项目状态：\*\*api\*\*/.test(message.content)));
  assert.ok(rootChannel.sent.some((message) => /Prompt：优先补测试和稳定性，不要做大功能/.test(message.content)));
  assert.ok(rootChannel.sent.some((message) => /调度周期：30m/.test(message.content)));
  await cleanupDir(rootDir);
});

test('project-level autopilot run command triggers an immediate run and refreshes the next cycle time', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-autopilot-project-run-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, store, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-autopilot-project-run', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannel, '!autopilot server on', { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannel, '!autopilot project on', { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannel, '!autopilot project interval 30m', { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannel, '!autopilot project run', { userId: 'admin-user' }));

  const autopilotProject = store.getAutopilotProject(rootChannel.id)!;
  const autopilotThread = channels.get(autopilotProject.threadChannelId!)!;

  assert.ok(rootChannel.sent.some((message) => /已触发当前项目立即执行 1 次 Autopilot/.test(message.content)));
  await waitFor(() => autopilotThread.sent.some((message) => /Autopilot 已启动/.test(message.content)), 20_000);
  await waitFor(() => autopilotThread.sent.some((message) => /Autopilot 本轮结束/.test(message.content)), 25_000);
  assert.ok(store.getAutopilotProject(rootChannel.id)?.lastRunAt);
  assert.ok(autopilotThread.sent.some((message) => /看板变化：/.test(message.content)));
  assert.ok(autopilotThread.sent.some((message) => /新增 DONE · 补齐会话恢复相关测试/.test(message.content)));

  const boardJson = JSON.parse(await readFile(path.join(workspace, '.codex', 'autopilot', 'board.json'), 'utf8'));
  assert.equal(boardJson.items.filter((item: { status: string }) => item.status === 'done').length, 1);
  assert.equal(boardJson.items.filter((item: { status: string }) => item.status === 'ready').length, 2);
  const boardMarkdown = await readFile(path.join(workspace, 'docs', 'AUTOPILOT_BOARD.md'), 'utf8');
  assert.match(boardMarkdown, /补齐会话恢复相关测试/);

  await dispatch(bridge, createUserMessage(rootChannel, '!autopilot project status', { userId: 'admin-user' }));
  assert.ok(rootChannel.sent.some((message) => /下次运行：20\d\d-\d\d-\d\dT/.test(message.content)));
  await cleanupDir(rootDir);
});

test('autopilot thread natural-language messages update project direction instead of running codex', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-autopilot-brief-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, store, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-autopilot-brief-root', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
  const autopilotProject = store.getAutopilotProject(rootChannel.id)!;
  const autopilotThread = channels.get(autopilotProject.threadChannelId!)!;

  await dispatch(
    bridge,
    createUserMessage(
      autopilotThread,
      '优先补测试和稳定性，不要做大功能，部署脚本和权限逻辑先不要动。',
      { userId: 'admin-user' },
    ),
  );

  assert.match(store.getAutopilotProject(rootChannel.id)?.brief ?? '', /优先补测试和稳定性/);
  assert.ok(autopilotThread.sent.some((message) => /已更新当前项目的 Autopilot Prompt/.test(message.content)));
  assert.equal(store.getSession(autopilotThread.id), undefined);
  await cleanupDir(rootDir);
});

test('autopilot respects a single-slot concurrency setting and posts timestamped project-thread progress', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-autopilot-run-');
  const workspaceA = await createWorkspace(path.join(rootDir, 'a'));
  const workspaceB = await createWorkspace(path.join(rootDir, 'b'));
  const { bridge, store, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannelA = new FakeChannel('channel-autopilot-a', 'guild-1');
  const rootChannelB = new FakeChannel('channel-autopilot-b', 'guild-1');
  channels.set(rootChannelA.id, rootChannelA);
  channels.set(rootChannelB.id, rootChannelB);

  await dispatch(bridge, createUserMessage(rootChannelA, `!bind aaa "${workspaceA}"`, { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannelB, `!bind bbb "${workspaceB}"`, { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannelA, '!autopilot server on', { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannelA, '!autopilot server concurrency 1', { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannelA, '!autopilot project prompt 优先补测试和稳定性，不要做大功能', { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannelA, '!autopilot project on', { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannelB, '!autopilot project on', { userId: 'admin-user' }));

  const projectA = store.getAutopilotProject(rootChannelA.id)!;
  const projectB = store.getAutopilotProject(rootChannelB.id)!;
  const threadA = channels.get(projectA.threadChannelId!)!;
  const threadB = channels.get(projectB.threadChannelId!)!;

  await (bridge as any).runAutopilotTick();
  await waitFor(() => threadA.sent.some((message) => /Autopilot 已启动/.test(message.content)));
  assert.ok(threadA.sent.some((message) => /Prompt：优先补测试和稳定性，不要做大功能/.test(message.content)));
  assert.ok(!threadA.sent.some((message) => /本轮目标：/.test(message.content)));
  await (bridge as any).runAutopilotTick();

  assert.ok(!threadB.sent.some((message) => /Autopilot 已启动/.test(message.content)));
  await waitFor(() => threadA.sent.some((message) => /Autopilot 本轮结束/.test(message.content)), 25_000);
  assert.ok(threadA.sent.some((message) => /\[\d{2}:\d{2}\]/.test(message.content)));
  await waitFor(() => threadA.sent.some((message) => /Codex 实时进度/.test(message.content)), 15_000);
  await waitFor(() => threadA.sent.some((message) => /当前命令：/.test(message.content)), 15_000);
  await waitFor(() => threadA.sent.some((message) => /请求：优先补测试和稳定性，不要做大功能/.test(message.content)), 15_000);
  assert.ok(threadA.sent.some((message) => /看板变化：/.test(message.content)));
  assert.ok(threadA.sent.some((message) => /任务看板：Ready 2 · Doing 0 · Blocked 0 · Done 1 · Deferred 1/.test(message.content)));

  await (bridge as any).runAutopilotTick();
  await waitFor(() => threadB.sent.some((message) => /Autopilot 已启动/.test(message.content)), 20_000);
  await waitFor(() => threadB.sent.some((message) => /Autopilot 本轮结束/.test(message.content)), 25_000);
  await cleanupDir(rootDir);
});

test('autopilot uses configurable parallelism and does not block or get blocked by manual project codex runs', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-autopilot-parallel-');
  const workspaceA = await createWorkspace(path.join(rootDir, 'parallel-a'));
  const workspaceB = await createWorkspace(path.join(rootDir, 'parallel-b'));
  const { bridge, store, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannelA = new FakeChannel('channel-autopilot-parallel-a', 'guild-1');
  const rootChannelB = new FakeChannel('channel-autopilot-parallel-b', 'guild-1');
  channels.set(rootChannelA.id, rootChannelA);
  channels.set(rootChannelB.id, rootChannelB);

  await dispatch(bridge, createUserMessage(rootChannelA, `!bind aaa "${workspaceA}"`, { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannelB, `!bind bbb "${workspaceB}"`, { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannelA, '!autopilot server on', { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannelA, '!autopilot server concurrency 2', { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannelA, '!autopilot project on', { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannelB, '!autopilot project on', { userId: 'admin-user' }));

  const projectA = store.getAutopilotProject(rootChannelA.id)!;
  const projectB = store.getAutopilotProject(rootChannelB.id)!;
  const threadA = channels.get(projectA.threadChannelId!)!;
  const threadB = channels.get(projectB.threadChannelId!)!;

  await dispatch(bridge, createUserMessage(rootChannelA, '[slow] manual root task'));
  await waitFor(() => (
    bridge as any
  ).getDashboardData().some((entry: any) => entry.binding.channelId === rootChannelA.id
    && entry.conversations.some((conversation: any) => conversation.conversationId === rootChannelA.id
      && ['starting', 'running'].includes(conversation.status))), 15_000);

  await (bridge as any).runAutopilotTick();
  await waitFor(() => threadA.sent.some((message) => /Autopilot 已启动/.test(message.content)), 20_000);
  await waitFor(() => threadB.sent.some((message) => /Autopilot 已启动/.test(message.content)), 20_000);
  await waitFor(() => rootChannelA.sent.some((message) => /ok: \[slow\] manual root task/.test(message.content)), 15_000);
  await waitFor(() => threadA.sent.some((message) => /Autopilot 本轮结束/.test(message.content)), 25_000);
  await waitFor(() => threadB.sent.some((message) => /Autopilot 本轮结束/.test(message.content)), 25_000);
  assert.equal(store.getAutopilotService('guild-1')?.parallelism, 2);
  await cleanupDir(rootDir);
});

test('bridge posts live progress with reasoning summary and plan updates', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-progress-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-progress', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannel, '[plan] show me live progress'));
  await waitFor(() => findSent(rootChannel, /Codex 实时进度/));
  await waitFor(() => findSent(rootChannel, /计划：/));
  await waitFor(() => findSent(rootChannel, /分析摘要：/));
  await waitFor(() => findSent(rootChannel, /最近更新：\[\d{2}:\d{2}\]/));

  assert.ok(rootChannel.sent.some((message) => /Codex 实时进度/.test(message.content)));
  assert.ok(rootChannel.sent.some((message) => /Create a short plan/.test(message.content)));
  assert.ok(rootChannel.sent.some((message) => /\[\d{2}:\d{2}\] 🔄 Codex 正在分析请求/.test(message.content)));
  await cleanupDir(rootDir);
});

test('bridge updates plan checkmarks live when todo items complete', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-plan-live-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-plan-live', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannel, '[plan-live] show checkmarks'));

  await waitFor(() => rootChannel.sent.some((message) => /Codex 实时进度/.test(message.content) && /- □ Patch code/.test(message.content)), 15_000);
  const progressMessage = rootChannel.sent.find((message) => /Codex 实时进度/.test(message.content));
  assert.ok(progressMessage);

  await waitFor(() => /- ✓ Patch code/.test(progressMessage!.content), 15_000);
  assert.match(progressMessage!.content, /- ✓ Run tests/);
  assert.match(progressMessage!.content, /- ✓ Inspect files/);
  await cleanupDir(rootDir);
});

test('bridge keeps final plan checkmarks when the todo list finishes right before turn completion', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-plan-fast-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-plan-fast', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannel, '[plan-fast] show the final checkmarks'));

  await waitFor(() => rootChannel.sent.some((message) => /Codex 实时进度/.test(message.content)), 15_000);
  const progressMessage = rootChannel.sent.find((message) => /Codex 实时进度/.test(message.content));
  assert.ok(progressMessage);

  await waitFor(() => findSent(rootChannel, /ok: \[plan-fast\] show the final checkmarks/), 15_000);
  assert.match(progressMessage!.content, /- ✓ Inspect files/);
  assert.match(progressMessage!.content, /- ✓ Patch code/);
  assert.match(progressMessage!.content, /- ✓ Run tests/);
  await cleanupDir(rootDir);
});

test('bridge keeps final plan checkmarks when completion lands inside the refresh throttle window', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-plan-race-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-plan-race', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannel, '[plan-race] show the final checkmarks'));

  await waitFor(
    () => rootChannel.sent.some((message) => /Codex 实时进度/.test(message.content) && /- □ Patch code/.test(message.content)),
    15_000,
  );
  const progressMessage = rootChannel.sent.find((message) => /Codex 实时进度/.test(message.content));
  assert.ok(progressMessage);

  await waitFor(() => findSent(rootChannel, /ok: \[plan-race\] show the final checkmarks/), 15_000);
  assert.match(progressMessage!.content, /- ✓ Inspect files/);
  assert.match(progressMessage!.content, /- ✓ Patch code/);
  assert.match(progressMessage!.content, /- ✓ Run tests/);
  await cleanupDir(rootDir);
});

test('bridge shows subagent activity in live progress updates', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-subagent-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-subagent', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannel, '[subagent] coordinate a helper'));

  await waitFor(
    () => rootChannel.sent.some((message) => /Codex 实时进度/.test(message.content) && /子代理：/.test(message.content)),
    20_000,
  );
  const progressMessage = rootChannel.sent.find((message) => /Codex 实时进度/.test(message.content) && /子代理：/.test(message.content));
  assert.ok(progressMessage);
  await waitFor(() => /等待子代理/.test(progressMessage!.content), 20_000);
  assert.match(progressMessage!.content, /拉起子代理/);
  assert.match(progressMessage!.content, /等待子代理/);
  assert.match(progressMessage!.content, /Investigate the login flow/);
  await waitFor(() => findSent(rootChannel, /subagent ok; helper agent coordinated successfully/), 20_000);
  await cleanupDir(rootDir);
});

test('bridge survives Discord send failures without crashing the process', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-discord-socket-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, store, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-discord-socket', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));

  const originalSend = rootChannel.send.bind(rootChannel);
  (rootChannel as any).send = async () => {
    throw new Error('simulated discord socket closed');
  };

  try {
    const message = createUserMessage(rootChannel, 'run despite discord send failure');
    (bridge as any).client.emit('messageCreate', message);

    await waitFor(() => Boolean(store.getSession(rootChannel.id)?.codexThreadId), 15_000);
    await waitFor(() => !(bridge as any).getDashboardData().some((entry: any) => entry.conversations.some((conversation: any) => conversation.status === 'running' || conversation.status === 'starting')), 15_000);
  } finally {
    (rootChannel as any).send = originalSend;
    await cleanupDir(rootDir);
  }
});

test('bridge retries flaky codex exec exits and does not surface ignorable warning noise', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-retry-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-retry', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannel, '[flaky-exit] please finish this task'));
  await waitFor(() => findSent(rootChannel, /ok: \[flaky-exit\] please finish this task/), 15_000);

  assert.ok(!rootChannel.sent.some((message) => /failed to clean up stale arg0 temp dirs/.test(message.content)));
  assert.ok(!rootChannel.sent.some((message) => /执行失败，exitCode=1 signal=null/.test(message.content)));
  await cleanupDir(rootDir);
});

test('bridge retries transient Codex JSON stream failures on the same session and succeeds', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-json-transient-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, store, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-json-transient', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannel, '[json-transient] please finish this task'));
  await waitFor(() => findSent(rootChannel, /ok: \[json-transient\] please finish this task/), 15_000);

  const session = store.getSession(rootChannel.id);
  assert.ok(session?.codexThreadId);
  assert.ok(rootChannel.sent.some((message) => /Codex 连接中断，bridge 正在继续当前会话并自动重试/.test(message.content)));
  assert.ok(!rootChannel.sent.some((message) => /执行失败，exitCode=1 signal=null/.test(message.content)));
  await cleanupDir(rootDir);
});

test('bridge drops a stale resumed Codex session and retries with a fresh session', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-resume-stale-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, store, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-resume-stale', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannel, 'first prompt'));
  await waitFor(() => findSent(rootChannel, /ok: first prompt/), 15_000);

  const firstSession = store.getSession(rootChannel.id);
  assert.ok(firstSession?.codexThreadId);

  await dispatch(bridge, createUserMessage(rootChannel, '[resume-stale] please recover this session'));
  await waitFor(() => findSent(rootChannel, /ok: \[resume-stale\] please recover this session/), 15_000);

  const secondSession = store.getSession(rootChannel.id);
  assert.ok(secondSession?.codexThreadId);
  assert.notEqual(secondSession?.codexThreadId, firstSession?.codexThreadId);
  assert.ok(!rootChannel.sent.some((message) => /执行失败，exitCode=1 signal=null/.test(message.content)));
  await cleanupDir(rootDir);
});

test('bridge drops stale sessions when Codex reports a structured resume failure', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-json-stale-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, store, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-json-stale', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannel, 'first prompt'));
  await waitFor(() => findSent(rootChannel, /ok: first prompt/), 15_000);

  const firstSession = store.getSession(rootChannel.id);
  assert.ok(firstSession?.codexThreadId);

  await dispatch(bridge, createUserMessage(rootChannel, '[json-stale-session] please recover this session'));
  await waitFor(() => findSent(rootChannel, /ok: \[json-stale-session\] please recover this session/), 15_000);

  const secondSession = store.getSession(rootChannel.id);
  assert.ok(secondSession?.codexThreadId);
  assert.notEqual(secondSession?.codexThreadId, firstSession?.codexThreadId);
  assert.ok(rootChannel.sent.some((message) => /检测到 Codex 会话可能损坏，bridge 正在丢弃当前会话并重试/.test(message.content)));
  await cleanupDir(rootDir);
});

test('bridge retries zero-exit incomplete turns instead of failing immediately', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-zero-exit-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-zero-exit', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannel, '[zero-exit-no-turn] please finish this task'));
  await waitFor(() => findSent(rootChannel, /ok: \[zero-exit-no-turn\] please finish this task/), 15_000);

  assert.ok(rootChannel.sent.some((message) => /Codex 异常退出，bridge 正在自动重试一次/.test(message.content)));
  assert.ok(!rootChannel.sent.some((message) => /执行失败，exitCode=0 signal=null/.test(message.content)));
  await cleanupDir(rootDir);
});

test('bridge falls back to a fresh session after both fresh-start and resumed retry fail', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-fresh-resume-stale-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, store, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-fresh-resume-stale', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
  await dispatch(bridge, createUserMessage(rootChannel, '[fresh-then-resume-stale] please recover this session'));
  await waitFor(() => findSent(rootChannel, /ok: \[fresh-then-resume-stale\] please recover this session/), 15_000);

  const session = store.getSession(rootChannel.id);
  assert.ok(session?.codexThreadId);
  assert.ok(!rootChannel.sent.some((message) => /执行失败，exitCode=1 signal=null/.test(message.content)));
  await cleanupDir(rootDir);
});

test('bridge persists active runtime snapshots while a task is running', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-runtime-persist-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-runtime-persist', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, '[slow] persist this active run'));

    await waitFor(async () => {
      const state = await readStateFile(rootDir);
      const runtime = state.runtimes?.[rootChannel.id];
      return runtime?.activeRun?.task?.prompt === '[slow] persist this active run';
    }, 15_000);

    await waitFor(() => findSent(rootChannel, /ok: \[slow\] persist this active run/), 15_000);
  } finally {
    await cleanupDir(rootDir);
  }
});

test('bridge restores interrupted work on startup, announces recovery, and prioritizes it before queued prompts', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-startup-recovery-');
  const workspace = await createWorkspace(rootDir);
  const logDir = path.join(rootDir, 'fake-recovery-logs');
  process.env.FAKE_CODEX_LOG_DIR = logDir;
  const firstRig = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-startup-recovery', 'guild-1');
  firstRig.channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(firstRig.bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    const originalMessage = createUserMessage(rootChannel, '[command] interrupted first task');
    const queuedMessage = createUserMessage(rootChannel, 'second queued task');

    await firstRig.store.updateSession(rootChannel.id, {
      codexThreadId: 'thread-recover-1',
      driver: 'legacy-exec',
    }, rootChannel.id);

    const state = await readStateFile(rootDir);
    state.runtimes = {
      [rootChannel.id]: {
        conversationId: rootChannel.id,
        queue: [
          {
            id: 'queued-normal-task',
            prompt: 'second queued task',
            effectivePrompt: 'second queued task',
            rootPrompt: 'second queued task',
            rootEffectivePrompt: 'second queued task',
            requestedBy: queuedMessage.author.username,
            requestedById: queuedMessage.author.id,
            messageId: queuedMessage.id,
            enqueuedAt: '2026-03-21T00:00:01.000Z',
            bindingChannelId: rootChannel.id,
            conversationId: rootChannel.id,
            attachments: [],
            extraAddDirs: [],
            origin: 'user',
          },
        ],
        activeRun: {
          task: {
            id: 'interrupted-active-task',
            prompt: '[command] interrupted first task',
            effectivePrompt: '[command] interrupted first task',
            rootPrompt: '[command] interrupted first task',
            rootEffectivePrompt: '[command] interrupted first task',
            requestedBy: originalMessage.author.username,
            requestedById: originalMessage.author.id,
            messageId: originalMessage.id,
            enqueuedAt: '2026-03-21T00:00:00.000Z',
            bindingChannelId: rootChannel.id,
            conversationId: rootChannel.id,
            attachments: [],
            extraAddDirs: [],
            origin: 'user',
          },
          driverMode: 'legacy-exec',
          status: 'running',
          startedAt: '2026-03-21T00:00:00.000Z',
          updatedAt: '2026-03-21T00:00:02.000Z',
          latestActivity: '命令执行完成',
          currentCommand: '/bin/zsh -lc "ls -la"',
          lastCommandOutput: 'file-a\nfile-b\n',
          agentMessages: [],
          reasoningSummaries: ['先检查仓库状态，再继续原始任务。'],
          planItems: [
            { text: 'Inspect files', completed: true },
            { text: 'Continue task', completed: false },
          ],
          collabToolCalls: [],
          timeline: ['[00:00] 已收到请求', '[00:01] ✅ /bin/zsh -lc "ls -la" (0)'],
          stderr: [],
          usedResume: true,
          codexThreadId: 'thread-recover-1',
        },
      },
    };
    await writeStateFile(rootDir, state);

    const secondRig = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
    secondRig.channels.set(rootChannel.id, rootChannel);

    await secondRig.bridge.start();

    await waitFor(() => findSent(rootChannel, /检测到上次任务中断/), 15_000);
    await waitFor(() => findSent(rootChannel, /正在自动恢复/), 15_000);
    await waitFor(() => findSent(rootChannel, /ok: second queued task/), 15_000);

    const logFiles = (await readdir(logDir)).sort();
    const payloads = await Promise.all(logFiles.map(async (fileName) => JSON.parse(await readFile(path.join(logDir, fileName), 'utf8')) as {
      prompt: string;
      args: { mode: string };
    }));

    assert.ok(payloads.length >= 2);
    assert.match(payloads[0]!.prompt, /\[command\] interrupted first task/);
    assert.match(payloads[0]!.prompt, /不要从头重复已经完成的步骤|继续沿用当前会话里已经获得的上下文/);
    assert.match(payloads[1]!.prompt, /^second queued task(?:\n|$)/);
    assert.match(payloads[1]!.prompt, /BRIDGE_SEND_FILE/);
  } finally {
    delete process.env.FAKE_CODEX_LOG_DIR;
    await cleanupDir(rootDir);
  }
});

test('bridge cancels an automatically recovered task with !cancel', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-recovery-cancel-');
  const workspace = await createWorkspace(rootDir);
  const firstRig = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-recovery-cancel', 'guild-1');
  firstRig.channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(firstRig.bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    const originalMessage = createUserMessage(rootChannel, '[cancel] interrupted recovery task');

    await firstRig.store.updateSession(rootChannel.id, {
      codexThreadId: 'thread-recover-cancel',
      driver: 'legacy-exec',
    }, rootChannel.id);

    const state = await readStateFile(rootDir);
    state.runtimes = {
      [rootChannel.id]: {
        conversationId: rootChannel.id,
        queue: [],
        activeRun: {
          task: {
            id: 'recovery-cancel-task',
            prompt: '[cancel] interrupted recovery task',
            effectivePrompt: '[cancel] interrupted recovery task',
            rootPrompt: '[cancel] interrupted recovery task',
            rootEffectivePrompt: '[cancel] interrupted recovery task',
            requestedBy: originalMessage.author.username,
            requestedById: originalMessage.author.id,
            messageId: originalMessage.id,
            enqueuedAt: '2026-03-21T00:00:00.000Z',
            bindingChannelId: rootChannel.id,
            conversationId: rootChannel.id,
            attachments: [],
            extraAddDirs: [],
            origin: 'user',
          },
          driverMode: 'legacy-exec',
          status: 'running',
          startedAt: '2026-03-21T00:00:00.000Z',
          updatedAt: '2026-03-21T00:00:01.000Z',
          latestActivity: '正在执行命令',
          currentCommand: '/bin/echo waiting',
          agentMessages: [],
          reasoningSummaries: [],
          planItems: [],
          collabToolCalls: [],
          timeline: ['[00:00] 任务中断'],
          stderr: [],
          usedResume: true,
          codexThreadId: 'thread-recover-cancel',
        },
      },
    };
    await writeStateFile(rootDir, state);

    const secondRig = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
    secondRig.channels.set(rootChannel.id, rootChannel);
    await secondRig.bridge.start();

    await waitFor(() => (secondRig.bridge as any).getDashboardData().some((entry: any) => entry.conversations.some((c: any) => c.status === 'running' || c.status === 'starting')), 15_000);
    await dispatch(secondRig.bridge, createUserMessage(rootChannel, '!cancel', { userId: 'admin-user' }));

    await waitFor(() => findSent(rootChannel, /已发送取消信号给当前 Codex 任务/), 15_000);
    await waitFor(() => findSent(rootChannel, /执行失败/), 15_000);
    assert.ok(!findSent(rootChannel, /ok: \[cancel\] interrupted recovery task/));
  } finally {
    await cleanupDir(rootDir);
  }
});

test('bridge can insert a queued prompt into the active task with !queue insert', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-queue-insert-');
  const workspace = await createWorkspace(rootDir);
  const logDir = path.join(rootDir, 'fake-queue-insert-logs');
  process.env.FAKE_CODEX_LOG_DIR = logDir;
  const { bridge, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-queue-insert', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, '[slow] first task'));
    await waitFor(() => (bridge as any).getDashboardData().some((entry: any) => entry.conversations.some((c: any) => c.status === 'running' || c.status === 'starting')), 15_000);

    await dispatch(bridge, createUserMessage(rootChannel, 'second task'));
    await dispatch(bridge, createUserMessage(rootChannel, 'third task'));
    await waitFor(() => findSent(rootChannel, /已加入队列/), 15_000);

    await dispatch(bridge, createUserMessage(rootChannel, '!queue insert 2', { userId: 'admin-user' }));

    await waitFor(() => findSent(rootChannel, /插入当前工作|当前工作/), 15_000);
    await waitFor(() => findSent(rootChannel, /ok: second task/), 15_000);
    await waitFor(async () => {
      const files = await readdir(logDir).catch(() => []);
      return files.length >= 3;
    }, 15_000);

    const payloads = await Promise.all((await readdir(logDir)).sort().map(async (fileName) => JSON.parse(await readFile(path.join(logDir, fileName), 'utf8')) as {
      prompt: string;
      args: { mode: string };
    }));

    assert.ok(payloads.length >= 3);
    assert.match(payloads[1]!.prompt, /\[slow\] first task/);
    assert.match(payloads[1]!.prompt, /third task/);
    assert.match(payloads[2]!.prompt, /^second task(?:\n|$)/);
    assert.match(payloads[2]!.prompt, /BRIDGE_SEND_FILE/);
  } finally {
    delete process.env.FAKE_CODEX_LOG_DIR;
    await cleanupDir(rootDir);
  }
});

test('bridge downloads attachments and forwards image files to codex -i', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-attach-');
  const workspace = await createWorkspace(rootDir);
  const logDir = path.join(rootDir, 'fake-codex-logs');
  process.env.FAKE_CODEX_LOG_DIR = logDir;

  const { bridge, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-root', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  const staticServer = await startStaticServer({
    '/note.txt': { body: 'hello attachment', contentType: 'text/plain' },
    '/pic.png': { body: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png' },
  });

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));

    const attachments = new Map([
      ['a', { name: 'note.txt', url: `${staticServer.origin}/note.txt`, contentType: 'text/plain', size: 16 }],
      ['b', { name: 'pic.png', url: `${staticServer.origin}/pic.png`, contentType: 'image/png', size: 4 }],
    ]);

    await dispatch(bridge, createUserMessage(rootChannel, '[attachments] inspect these files', { attachments }));
    await waitFor(() => findSent(rootChannel, /attachments ok/));

    const logFiles = await readdir(logDir);
    assert.ok(logFiles.length > 0);
    const latestLog = logFiles.sort().at(-1)!;
    const payload = JSON.parse(await readFile(path.join(logDir, latestLog), 'utf8')) as {
      args: { images: string[]; addDirs: string[] };
      prompt: string;
    };

    assert.equal(payload.args.images.length, 1);
    assert.ok(payload.args.addDirs.length >= 1);
    assert.match(payload.prompt, /note\.txt/);
    assert.match(payload.prompt, /pic\.png/);
    assert.equal(await readFile(path.join(workspace, 'inbox', 'note.txt'), 'utf8'), 'hello attachment');
    assert.deepEqual(
      await readFile(path.join(workspace, 'inbox', 'pic.png')),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
  } finally {
    delete process.env.FAKE_CODEX_LOG_DIR;
    await staticServer.close();
    await cleanupDir(rootDir);
  }
});

test('bridge send file flow returns a workspace file to Discord for a natural-language request', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-send-file-');
  const workspace = await createWorkspace(rootDir);
  const reportPath = path.join(workspace, 'report.pdf');
  const { bridge, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-send-file', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await writeFile(reportPath, 'pdf payload', 'utf8');
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));

    await dispatch(bridge, createUserMessage(rootChannel, '把 report.pdf 发给我'));
    await waitFor(() => findSentFile(rootChannel, /report\.pdf/), 3_000);
  } finally {
    await cleanupDir(rootDir);
  }
});

test('bridge lists numbered candidates instead of auto-sending when multiple files match', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-send-file-candidates-');
  const workspace = await createWorkspace(rootDir);
  const inboxDir = path.join(workspace, 'inbox');
  const exportDir = path.join(workspace, 'exports');
  const { bridge, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-send-file-candidates', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await mkdir(inboxDir, { recursive: true });
    await mkdir(exportDir, { recursive: true });
    await writeFile(path.join(inboxDir, 'report.pdf'), 'inbox payload', 'utf8');
    await writeFile(path.join(exportDir, 'report.pdf'), 'export payload', 'utf8');
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));

    await dispatch(bridge, createUserMessage(rootChannel, '把 report.pdf 发给我'));
    await waitFor(() => findSent(rootChannel, /找到多个匹配文件|发第 2 个|!sendfile 2/), 3_000);
    assert.equal(findSentFile(rootChannel, /report\.pdf/), false);
  } finally {
    await cleanupDir(rootDir);
  }
});

test('bridge sends the chosen candidate after a numbered follow-up', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-send-file-select-');
  const workspace = await createWorkspace(rootDir);
  const inboxDir = path.join(workspace, 'inbox');
  const exportDir = path.join(workspace, 'exports');
  const exportFile = path.join(exportDir, 'report.pdf');
  const { bridge, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-send-file-select', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await mkdir(inboxDir, { recursive: true });
    await mkdir(exportDir, { recursive: true });
    await writeFile(path.join(inboxDir, 'report.pdf'), 'inbox payload', 'utf8');
    await writeFile(exportFile, 'export payload', 'utf8');
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));

    await dispatch(bridge, createUserMessage(rootChannel, '把 report.pdf 发给我'));
    await waitFor(() => findSent(rootChannel, /找到多个匹配文件|发第 2 个|!sendfile 2/), 3_000);

    await dispatch(bridge, createUserMessage(rootChannel, '发第 2 个'));
    await waitFor(() => findSentFile(rootChannel, /report\.pdf/), 3_000);
    assert.ok(rootChannel.sent.some((message) => message.sentFiles.some((file) => {
      const value = typeof file === 'string' ? file : file.attachment;
      return value.endsWith(path.join('exports', 'report.pdf'));
    })));
  } finally {
    await cleanupDir(rootDir);
  }
});

test('bridge sendfile command returns a workspace file to Discord', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-sendfile-command-');
  const workspace = await createWorkspace(rootDir);
  const reportPath = path.join(workspace, 'report.pdf');
  const { bridge, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-sendfile-command', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await writeFile(reportPath, 'pdf payload', 'utf8');
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));

    await dispatch(bridge, createUserMessage(rootChannel, '!sendfile report.pdf'));
    await waitFor(() => findSentFile(rootChannel, /report\.pdf/), 3_000);
  } finally {
    await cleanupDir(rootDir);
  }
});

test('bridge sends Discord attachments using the selected file basename as the outgoing name', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-sendfile-name-');
  const workspace = await createWorkspace(rootDir);
  const reportPath = path.join(workspace, 'Quarterly Report 终稿.pdf');
  const { bridge, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-sendfile-name', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await writeFile(reportPath, 'pdf payload', 'utf8');
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));

    await dispatch(bridge, createUserMessage(rootChannel, '!sendfile "Quarterly Report 终稿.pdf"'));
    await waitFor(() => findSentFile(rootChannel, /Quarterly Report 终稿\.pdf/), 3_000);

    assert.ok(rootChannel.sent.some((message) => message.sentFiles.some((file) => (
      typeof file !== 'string' && file.name === 'Quarterly Report 终稿.pdf'
    ))));
  } finally {
    await cleanupDir(rootDir);
  }
});

test('bridge sendfile command can select a numbered candidate', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-sendfile-select-command-');
  const workspace = await createWorkspace(rootDir);
  const inboxDir = path.join(workspace, 'inbox');
  const exportDir = path.join(workspace, 'exports');
  const { bridge, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-sendfile-select-command', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await mkdir(inboxDir, { recursive: true });
    await mkdir(exportDir, { recursive: true });
    await writeFile(path.join(inboxDir, 'report.pdf'), 'inbox payload', 'utf8');
    await writeFile(path.join(exportDir, 'report.pdf'), 'export payload', 'utf8');
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));

    await dispatch(bridge, createUserMessage(rootChannel, '把 report.pdf 发给我'));
    await waitFor(() => findSent(rootChannel, /找到多个匹配文件|发第 2 个|!sendfile 2/), 3_000);

    await dispatch(bridge, createUserMessage(rootChannel, '!sendfile 2'));
    await waitFor(() => findSentFile(rootChannel, /report\.pdf/), 3_000);
    assert.ok(rootChannel.sent.some((message) => message.sentFiles.some((file) => {
      const value = typeof file === 'string' ? file : file.attachment;
      return value.endsWith(path.join('exports', 'report.pdf'));
    })));
  } finally {
    await cleanupDir(rootDir);
  }
});

test('bridge can upload a file requested by a Codex file-send marker', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-codex-send-file-');
  const workspace = await createWorkspace(rootDir);
  const reportPath = path.join(workspace, 'report.pdf');
  const { bridge, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-codex-send-file', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await writeFile(reportPath, 'pdf payload', 'utf8');
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));

    await dispatch(bridge, createUserMessage(rootChannel, '[bridge-send-file] generate and deliver the report'));
    await waitFor(() => findSentFile(rootChannel, /report\.pdf/), 3_000);
  } finally {
    await cleanupDir(rootDir);
  }
});

test('bridge prompt includes the Codex file-send protocol instructions', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-file-send-prompt-');
  const workspace = await createWorkspace(rootDir);
  const logDir = path.join(rootDir, 'fake-codex-logs');
  process.env.FAKE_CODEX_LOG_DIR = logDir;

  const { bridge, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-file-send-prompt', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, '生成 report.pdf 然后发给我'));
    await waitFor(() => findSent(rootChannel, /ok: 生成 report\.pdf 然后发给我/), 3_000);

    const logFiles = await readdir(logDir);
    assert.ok(logFiles.length > 0);
    const latestLog = logFiles.sort().at(-1)!;
    const payload = JSON.parse(await readFile(path.join(logDir, latestLog), 'utf8')) as {
      prompt: string;
    };

    assert.match(payload.prompt, /BRIDGE_SEND_FILE/);
    assert.match(payload.prompt, /如果用户要求把文件发回 Discord/);
  } finally {
    delete process.env.FAKE_CODEX_LOG_DIR;
    await cleanupDir(rootDir);
  }
});

test('bridge handles queueing, cancellation, reset, and unbind', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-queue-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, store, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-root', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));

  await dispatch(bridge, createUserMessage(rootChannel, '[slow] first task'));
  await dispatch(bridge, createUserMessage(rootChannel, 'second task'));
  await waitFor(() => findSent(rootChannel, /已加入队列/));
  await waitFor(() => findSent(rootChannel, /ok: \[slow\] first task/), 15_000);
  await waitFor(() => findSent(rootChannel, /ok: second task/), 15_000);
  await waitFor(() => !(bridge as any).getDashboardData().some((entry: any) => entry.conversations.some((c: any) => c.status === 'running' || c.status === 'starting')));

  await dispatch(bridge, createUserMessage(rootChannel, '[cancel] long task'));
  await waitFor(() => (bridge as any).getDashboardData().some((entry: any) => entry.conversations.some((c: any) => c.status === 'running' || c.status === 'starting')));
  await dispatch(bridge, createUserMessage(rootChannel, '!cancel', { userId: 'admin-user' }));
  await waitFor(() => findSent(rootChannel, /执行失败/), 15_000);

  await dispatch(bridge, createUserMessage(rootChannel, '!reset', { userId: 'admin-user' }));
  assert.equal(store.getSession(rootChannel.id)?.codexThreadId, undefined);

  await dispatch(bridge, createUserMessage(rootChannel, '!unbind', { userId: 'admin-user' }));
  assert.equal(store.getBinding(rootChannel.id), undefined);
  await cleanupDir(rootDir);
});
