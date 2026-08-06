import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { FakeChannel, createUserMessage } from './helpers/fakeDiscord.js';
import { createBridgeTestRig } from './helpers/bridgeSetup.js';
import { cleanupDir, createWorkspace, makeTempDir, waitFor } from './helpers/testUtils.js';

const fakeAppServerCommand = path.resolve('test/fixtures/fake-codex-app-server.mjs');
const fakeClaudeCommand = path.resolve('test/fixtures/fake-claude.mjs');

async function dispatch(bridge: unknown, message: unknown): Promise<void> {
  await (bridge as any).handleMessage(message as any);
}

async function readAppServerRequests(logDir: string): Promise<Array<{ method: string; params: any }>> {
  const files = (await readdir(logDir)).sort();
  const requests: Array<{ method: string; params: any }> = [];

  for (const fileName of files) {
    const payload = JSON.parse(await readFile(path.join(logDir, fileName), 'utf8')) as { method: string; params?: any };
    if (payload.method === '$startup') {
      continue;
    }
    requests.push({
      method: payload.method,
      params: payload.params ?? null,
    });
  }

  return requests;
}

test('project model switch applies on the next turn without resetting the session', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-model-project-');
  const workspace = await createWorkspace(rootDir);
  const logDir = path.join(rootDir, 'fake-app-server-logs');
  const codexConfigPath = path.join(rootDir, '.codex', 'config.toml');
  await mkdir(path.dirname(codexConfigPath), { recursive: true });
  await writeFile(codexConfigPath, 'model = "gpt-global"\n', 'utf8');
  process.env.FAKE_CODEX_APP_SERVER_LOG_DIR = logDir;

  const { bridge, store, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeAppServerCommand,
    driverMode: 'app-server',
    codexConfigPath,
  } as any);
  const rootChannel = new FakeChannel('channel-model-project', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, 'first prompt'));
    await waitFor(() => rootChannel.sent.some((message) => /app-server ok: first prompt/.test(message.content)), 15_000);

    const firstSession = store.getSession(rootChannel.id);
    assert.ok(firstSession?.codexThreadId);

    await dispatch(bridge, createUserMessage(rootChannel, '!model project set gpt-5.5', { userId: 'admin-user' }));
    await waitFor(() => rootChannel.sent.some((message) => /gpt-5\.5/.test(message.content)), 15_000);
    assert.equal(store.getBinding(rootChannel.id)?.codex.model, 'gpt-5.5');

    await dispatch(bridge, createUserMessage(rootChannel, 'second prompt'));
    await waitFor(() => rootChannel.sent.some((message) => /app-server ok: second prompt/.test(message.content)), 15_000);

    const secondSession = store.getSession(rootChannel.id);
    assert.equal(secondSession?.codexThreadId, firstSession?.codexThreadId);

    const turnRequests = (await readAppServerRequests(logDir)).filter((entry) => entry.method === 'turn/start');
    assert.equal(turnRequests.at(-1)?.params?.model, 'gpt-5.5');
  } finally {
    await (bridge as any).stop?.();
    delete process.env.FAKE_CODEX_APP_SERVER_LOG_DIR;
    await cleanupDir(rootDir);
  }
});

test('global model switch rewrites config and overrides all bound projects without resetting sessions', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-model-global-');
  const workspaceA = await createWorkspace(path.join(rootDir, 'workspace-a'));
  const workspaceB = await createWorkspace(path.join(rootDir, 'workspace-b'));
  const logDir = path.join(rootDir, 'fake-app-server-logs');
  const codexConfigPath = path.join(rootDir, '.codex', 'config.toml');
  await mkdir(path.dirname(codexConfigPath), { recursive: true });
  await writeFile(codexConfigPath, 'model = "gpt-old"\n\n[profiles.default]\napproval_policy = "never"\n', 'utf8');
  process.env.FAKE_CODEX_APP_SERVER_LOG_DIR = logDir;

  const { bridge, store, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeAppServerCommand,
    driverMode: 'app-server',
    codexConfigPath,
  } as any);
  const firstChannel = new FakeChannel('channel-model-global-a', 'guild-1');
  const secondChannel = new FakeChannel('channel-model-global-b', 'guild-1');
  channels.set(firstChannel.id, firstChannel);
  channels.set(secondChannel.id, secondChannel);

  try {
    await dispatch(bridge, createUserMessage(firstChannel, `!bind api "${workspaceA}"`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(secondChannel, `!bind web "${workspaceB}" --model gpt-project`, { userId: 'admin-user' }));

    await dispatch(bridge, createUserMessage(firstChannel, 'first prompt'));
    await waitFor(() => firstChannel.sent.some((message) => /app-server ok: first prompt/.test(message.content)), 15_000);

    const firstSession = store.getSession(firstChannel.id);
    assert.ok(firstSession?.codexThreadId);

    await dispatch(bridge, createUserMessage(firstChannel, '!model set gpt-5.5', { userId: 'admin-user' }));
    await waitFor(() => firstChannel.sent.some((message) => /gpt-5\.5/.test(message.content)), 15_000);

    assert.equal(store.getBinding(firstChannel.id)?.codex.model, 'gpt-5.5');
    assert.equal(store.getBinding(secondChannel.id)?.codex.model, 'gpt-5.5');

    const rewrittenConfig = await readFile(codexConfigPath, 'utf8');
    assert.match(rewrittenConfig, /^model = "gpt-5\.5"/m);
    assert.match(rewrittenConfig, /\[profiles\.default\]/);

    await dispatch(bridge, createUserMessage(firstChannel, 'second prompt'));
    await waitFor(() => firstChannel.sent.some((message) => /app-server ok: second prompt/.test(message.content)), 15_000);

    const secondSession = store.getSession(firstChannel.id);
    assert.equal(secondSession?.codexThreadId, firstSession?.codexThreadId);

    const turnRequests = (await readAppServerRequests(logDir)).filter((entry) => entry.method === 'turn/start');
    assert.equal(turnRequests.at(-1)?.params?.model, 'gpt-5.5');
  } finally {
    await (bridge as any).stop?.();
    delete process.env.FAKE_CODEX_APP_SERVER_LOG_DIR;
    await cleanupDir(rootDir);
  }
});

test('project model clear returns the binding to the global model and reports the source clearly', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-model-clear-');
  const workspace = await createWorkspace(rootDir);
  const codexConfigPath = path.join(rootDir, '.codex', 'config.toml');
  await mkdir(path.dirname(codexConfigPath), { recursive: true });
  await writeFile(codexConfigPath, 'model = "gpt-global"\n', 'utf8');

  const { bridge, store, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeAppServerCommand,
    driverMode: 'app-server',
    codexConfigPath,
  } as any);
  const rootChannel = new FakeChannel('channel-model-clear', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}" --model gpt-local`, { userId: 'admin-user' }));
    assert.equal(store.getBinding(rootChannel.id)?.codex.model, 'gpt-local');

    await dispatch(bridge, createUserMessage(rootChannel, '!model project clear', { userId: 'admin-user' }));
    await waitFor(() => rootChannel.sent.some((message) => /跟随全局/.test(message.content)), 15_000);
    assert.equal(store.getBinding(rootChannel.id)?.codex.model, undefined);

    await dispatch(bridge, createUserMessage(rootChannel, '!model project status', { userId: 'admin-user' }));
    await waitFor(() => rootChannel.sent.some((message) => /全局模型：`gpt-global`/.test(message.content)), 15_000);
    assert.ok(rootChannel.sent.some((message) => /项目模型：跟随全局/.test(message.content)));
  } finally {
    await (bridge as any).stop?.();
    await cleanupDir(rootDir);
  }
});

test('Claude model commands write global and project settings files and project override wins', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-claude-model-');
  const workspace = await createWorkspace(rootDir);
  const claudeSettingsPath = path.join(rootDir, '.claude', 'settings.json');
  const claudeLogDir = path.join(rootDir, 'fake-claude-logs');
  process.env.FAKE_CLAUDE_LOG_DIR = claudeLogDir;

  const { bridge, channels } = await createBridgeTestRig({
    rootDir,
    claudeCommand: fakeClaudeCommand,
    claudeSettingsPath,
  });
  const rootChannel = new FakeChannel('channel-claude-model', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}" --engine claude`, { userId: 'admin-user' }));

    await dispatch(bridge, createUserMessage(rootChannel, '!claude-model set claude-global', { userId: 'admin-user' }));
    await waitFor(() => rootChannel.sent.some((message) => /Claude 全局模型/.test(message.content) && /claude-global/.test(message.content)), 15_000);

    const globalSettings = JSON.parse(await readFile(claudeSettingsPath, 'utf8')) as { model?: string };
    assert.equal(globalSettings.model, 'claude-global');

    await dispatch(bridge, createUserMessage(rootChannel, '!claude-model project set claude-project', { userId: 'admin-user' }));
    await waitFor(() => rootChannel.sent.some((message) => /Claude 项目模型/.test(message.content) && /claude-project/.test(message.content)), 15_000);

    const projectSettingsPath = path.join(workspace, '.claude', 'settings.json');
    const projectSettings = JSON.parse(await readFile(projectSettingsPath, 'utf8')) as { model?: string };
    assert.equal(projectSettings.model, 'claude-project');

    await dispatch(bridge, createUserMessage(rootChannel, 'use claude project model'));
    await waitFor(() => rootChannel.sent.some((message) => /Claude final: use claude project model/.test(message.content)), 5_000);

    const logFiles = await readdir(claudeLogDir);
    const payload = JSON.parse(await readFile(path.join(claudeLogDir, logFiles.sort().at(-1)!), 'utf8')) as {
      args: {
        model?: string;
      };
    };
    assert.equal(payload.args.model, 'claude-project');
  } finally {
    delete process.env.FAKE_CLAUDE_LOG_DIR;
    await (bridge as any).stop?.();
    await cleanupDir(rootDir);
  }
});

test('generic model commands follow the bound Claude engine', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-model-engine-aware-');
  const workspace = await createWorkspace(rootDir);
  const codexConfigPath = path.join(rootDir, '.codex', 'config.toml');
  const claudeSettingsPath = path.join(rootDir, '.claude', 'settings.json');
  await mkdir(path.dirname(codexConfigPath), { recursive: true });
  await writeFile(codexConfigPath, 'model = "gpt-global"\n', 'utf8');

  const { bridge, store, channels } = await createBridgeTestRig({
    rootDir,
    claudeCommand: fakeClaudeCommand,
    codexConfigPath,
    claudeSettingsPath,
  });
  const rootChannel = new FakeChannel('channel-model-engine-aware', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}" --engine claude --model gpt-binding`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, '!claude-model set claude-global', { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, '!claude-model project set claude-project', { userId: 'admin-user' }));

    await dispatch(bridge, createUserMessage(rootChannel, '!model project status', { userId: 'admin-user' }));
    await waitFor(() => rootChannel.sent.some((message) => /Claude 项目模型/.test(message.content) && /claude-project/.test(message.content)), 15_000);
    assert.ok(rootChannel.sent.every((message) => !/Codex 项目模型/.test(message.content) || !/gpt-binding/.test(message.content)));

    await dispatch(bridge, createUserMessage(rootChannel, '!model project set claude-next', { userId: 'admin-user' }));
    const projectSettingsPath = path.join(workspace, '.claude', 'settings.json');
    const projectSettings = JSON.parse(await readFile(projectSettingsPath, 'utf8')) as { model?: string };
    assert.equal(projectSettings.model, 'claude-next');
    assert.equal(store.getBinding(rootChannel.id)?.codex.model, 'gpt-binding');

    await dispatch(bridge, createUserMessage(rootChannel, '!model set claude-global-next', { userId: 'admin-user' }));
    const globalSettings = JSON.parse(await readFile(claudeSettingsPath, 'utf8')) as { model?: string };
    assert.equal(globalSettings.model, 'claude-global-next');

    await dispatch(bridge, createUserMessage(rootChannel, '!model project clear', { userId: 'admin-user' }));
    const clearedSettings = JSON.parse(await readFile(projectSettingsPath, 'utf8')) as { model?: string };
    assert.equal(clearedSettings.model, undefined);
  } finally {
    await (bridge as any).stop?.();
    await cleanupDir(rootDir);
  }
});

test('explicit Codex global model updates do not mutate Claude bindings', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-model-engine-filter-');
  const codexWorkspace = await createWorkspace(path.join(rootDir, 'codex-workspace'));
  const claudeWorkspace = await createWorkspace(path.join(rootDir, 'claude-workspace'));
  const codexConfigPath = path.join(rootDir, '.codex', 'config.toml');
  await mkdir(path.dirname(codexConfigPath), { recursive: true });
  await writeFile(codexConfigPath, 'model = "gpt-old"\n', 'utf8');

  const { bridge, store, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeAppServerCommand,
    claudeCommand: fakeClaudeCommand,
    driverMode: 'app-server',
    codexConfigPath,
  } as any);
  const codexChannel = new FakeChannel('channel-model-engine-filter-codex', 'guild-1');
  const claudeChannel = new FakeChannel('channel-model-engine-filter-claude', 'guild-1');
  channels.set(codexChannel.id, codexChannel);
  channels.set(claudeChannel.id, claudeChannel);

  try {
    await dispatch(bridge, createUserMessage(codexChannel, `!bind api "${codexWorkspace}" --engine codex`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(claudeChannel, `!bind web "${claudeWorkspace}" --engine claude --model claude-codex-metadata`, { userId: 'admin-user' }));

    await dispatch(bridge, createUserMessage(codexChannel, '!model codex set gpt-next', { userId: 'admin-user' }));

    assert.equal(store.getBinding(codexChannel.id)?.codex.model, 'gpt-next');
    assert.equal(store.getBinding(claudeChannel.id)?.codex.model, 'claude-codex-metadata');
    assert.match(await readFile(codexConfigPath, 'utf8'), /^model = "gpt-next"/m);
  } finally {
    await (bridge as any).stop?.();
    await cleanupDir(rootDir);
  }
});

test('Claude status panel renders the Claude effective model', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-model-status-claude-');
  const workspace = await createWorkspace(rootDir);
  const claudeSettingsPath = path.join(rootDir, '.claude', 'settings.json');
  const { bridge, channels } = await createBridgeTestRig({
    rootDir,
    claudeCommand: fakeClaudeCommand,
    claudeSettingsPath,
  });
  const rootChannel = new FakeChannel('channel-model-status-claude', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}" --engine claude`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, '!claude-model set claude-status-model', { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, '!status', { userId: 'admin-user' }));

    await waitFor(() => rootChannel.sent.some((message) => /Codex Discord Bridge 状态面板/.test(message.content)
      && /模型：.*claude-status-model/.test(message.content)), 15_000);
  } finally {
    await (bridge as any).stop?.();
    await cleanupDir(rootDir);
  }
});
