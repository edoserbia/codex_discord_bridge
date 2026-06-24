import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

import { FakeChannel, createUserMessage } from './helpers/fakeDiscord.js';
import { createBridgeTestRig } from './helpers/bridgeSetup.js';
import { cleanupDir, createWorkspace, makeTempDir, waitFor } from './helpers/testUtils.js';

const fakeCodexCommand = path.resolve('test/fixtures/fake-codex.mjs');
const fakeClaudeCommand = path.resolve('test/fixtures/fake-claude.mjs');

async function dispatch(bridge: unknown, message: unknown): Promise<void> {
  await (bridge as any).handleMessage(message as any);
}

function findSent(channel: FakeChannel, pattern: RegExp): boolean {
  return channel.sent.some((message) => pattern.test(message.content));
}

test('bridge can bind a channel to Claude as the default engine', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-claude-default-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, store, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeCodexCommand,
    claudeCommand: fakeClaudeCommand,
  });
  const rootChannel = new FakeChannel('channel-claude-default', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}" --engine claude`, { userId: 'admin-user' }));

    assert.equal(store.getBinding(rootChannel.id)?.engine, 'claude');

    await dispatch(bridge, createUserMessage(rootChannel, 'first prompt'));
    await waitFor(() => findSent(rootChannel, /Claude final: first prompt/), 5_000);

    const session = store.getSession(rootChannel.id);
    assert.equal(session?.codexThreadId, undefined);
    assert.ok(session?.claudeSessionId);
    assert.equal(session?.lastEngine, 'claude');
  } finally {
    await (bridge as any).stop?.();
    await cleanupDir(rootDir);
  }
});

test('bridge can override a Codex binding with a single Claude request without losing the Codex session', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-claude-override-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, store, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeCodexCommand,
    claudeCommand: fakeClaudeCommand,
  });
  const rootChannel = new FakeChannel('channel-claude-override', 'guild-1');
  channels.set(rootChannel.id, rootChannel);
  const claudeLogDir = path.join(rootDir, 'fake-claude-logs');
  process.env.FAKE_CLAUDE_LOG_DIR = claudeLogDir;

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    assert.equal(store.getBinding(rootChannel.id)?.engine, undefined);

    await dispatch(bridge, createUserMessage(rootChannel, 'codex first'));
    await waitFor(() => findSent(rootChannel, /ok: codex first/), 5_000);

    const codexThreadId = store.getSession(rootChannel.id)?.codexThreadId;
    assert.ok(codexThreadId);

    await dispatch(bridge, createUserMessage(rootChannel, '!claude claude second'));
    await waitFor(() => findSent(rootChannel, /\[Current user request\]\s+claude second/), 5_000);

    const sessionAfterClaude = store.getSession(rootChannel.id);
    assert.equal(sessionAfterClaude?.codexThreadId, codexThreadId);
    assert.ok(sessionAfterClaude?.claudeSessionId);
    assert.equal(sessionAfterClaude?.lastEngine, 'claude');

    const logFiles = await readdir(claudeLogDir);
    const latestLog = logFiles.sort().at(-1)!;
    const payload = JSON.parse(await readFile(path.join(claudeLogDir, latestLog), 'utf8')) as {
      prompt: string;
    };
    assert.match(payload.prompt, /Bridge cross-engine context/);
    assert.match(payload.prompt, /Previous engine: codex/);
    assert.match(payload.prompt, /Current engine: claude/);
    assert.match(payload.prompt, /- user: codex first/);
    assert.match(payload.prompt, /- assistant: ok: codex first/);
    assert.match(payload.prompt, /\[Current user request\]\nclaude second/);

    await dispatch(bridge, createUserMessage(rootChannel, '!reset', { userId: 'admin-user' }));
    const resetSession = store.getSession(rootChannel.id);
    assert.equal(resetSession?.codexThreadId, undefined);
    assert.equal(resetSession?.claudeSessionId, undefined);
    assert.equal(resetSession?.lastEngine, undefined);
  } finally {
    delete process.env.FAKE_CLAUDE_LOG_DIR;
    await (bridge as any).stop?.();
    await cleanupDir(rootDir);
  }
});

test('bridge preserves native sessions when switching Codex to Claude and back to Codex', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-engine-roundtrip-');
  const workspace = await createWorkspace(rootDir);
  const codexLogDir = path.join(rootDir, 'fake-codex-logs');
  process.env.FAKE_CODEX_LOG_DIR = codexLogDir;

  const { bridge, store, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeCodexCommand,
    claudeCommand: fakeClaudeCommand,
  });
  const rootChannel = new FakeChannel('channel-engine-roundtrip', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));

    await dispatch(bridge, createUserMessage(rootChannel, 'codex first'));
    await waitFor(() => findSent(rootChannel, /ok: codex first/), 5_000);
    const codexThreadId = store.getSession(rootChannel.id)?.codexThreadId;
    assert.ok(codexThreadId);

    await dispatch(bridge, createUserMessage(rootChannel, '!claude claude second'));
    await waitFor(() => findSent(rootChannel, /\[Current user request\]\s+claude second/), 5_000);
    const claudeSessionId = store.getSession(rootChannel.id)?.claudeSessionId;
    assert.ok(claudeSessionId);

    await dispatch(bridge, createUserMessage(rootChannel, '!codex codex third'));
    await waitFor(() => findSent(rootChannel, /ok: \[Bridge cross-engine context\]/), 5_000);

    const finalSession = store.getSession(rootChannel.id);
    assert.equal(finalSession?.codexThreadId, codexThreadId);
    assert.equal(finalSession?.claudeSessionId, claudeSessionId);
    assert.equal(finalSession?.lastEngine, 'codex');

    const logFiles = await readdir(codexLogDir);
    const latestLog = logFiles.sort().at(-1)!;
    const payload = JSON.parse(await readFile(path.join(codexLogDir, latestLog), 'utf8')) as {
      args: { mode: string; resumeThreadId?: string };
      prompt: string;
    };
    assert.equal(payload.args.mode, 'resume');
    assert.equal(payload.args.resumeThreadId, codexThreadId);
    assert.match(payload.prompt, /Bridge cross-engine context/);
    assert.match(payload.prompt, /Previous engine: claude/);
    assert.match(payload.prompt, /Current engine: codex/);
    assert.match(payload.prompt, /\[Current user request\]\ncodex third/);
  } finally {
    delete process.env.FAKE_CODEX_LOG_DIR;
    await (bridge as any).stop?.();
    await cleanupDir(rootDir);
  }
});

test('bridge can approve a Claude permission request in Discord and retry the original task', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-claude-permission-approve-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeCodexCommand,
    claudeCommand: fakeClaudeCommand,
  });
  const rootChannel = new FakeChannel('channel-claude-permission-approve', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}" --engine claude --sandbox workspace-write --approval on-request`, { userId: 'admin-user' }));

    await dispatch(bridge, createUserMessage(rootChannel, '[permission] please run fake tool'));
    await waitFor(() => findSent(rootChannel, /Claude 需要权限/) && findSent(rootChannel, /!approve perm-fake/), 5_000);

    await dispatch(bridge, createUserMessage(rootChannel, '!approve perm-fake', { userId: 'admin-user' }));
    await waitFor(() => findSent(rootChannel, /已批准 Claude 权限/) && findSent(rootChannel, /Claude final: \[permission\] please run fake tool/), 5_000);

    const projectSettings = JSON.parse(await readFile(path.join(workspace, '.claude', 'settings.json'), 'utf8')) as {
      permissions?: { allow?: string[] };
    };
    assert.deepEqual(projectSettings.permissions?.allow, ['Bash(fake:*)']);
  } finally {
    await (bridge as any).stop?.();
    await cleanupDir(rootDir);
  }
});

test('bridge can deny a Claude permission request without writing project allow rules', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-claude-permission-deny-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeCodexCommand,
    claudeCommand: fakeClaudeCommand,
  });
  const rootChannel = new FakeChannel('channel-claude-permission-deny', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}" --engine claude --sandbox workspace-write --approval on-request`, { userId: 'admin-user' }));

    await dispatch(bridge, createUserMessage(rootChannel, '[permission] please run fake tool'));
    await waitFor(() => findSent(rootChannel, /Claude 需要权限/) && findSent(rootChannel, /!deny perm-fake/), 5_000);

    await dispatch(bridge, createUserMessage(rootChannel, '!deny perm-fake', { userId: 'admin-user' }));
    await waitFor(() => findSent(rootChannel, /已拒绝 Claude 权限/), 5_000);

    await assert.rejects(readFile(path.join(workspace, '.claude', 'settings.json'), 'utf8'), /ENOENT/);
    assert.equal(rootChannel.sent.filter((message) => /Claude final: \[permission\] please run fake tool/.test(message.content)).length, 0);
  } finally {
    await (bridge as any).stop?.();
    await cleanupDir(rootDir);
  }
});
