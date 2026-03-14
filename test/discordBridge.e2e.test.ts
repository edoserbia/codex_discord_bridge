import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { FakeChannel, createUserMessage } from './helpers/fakeDiscord.js';
import { createBridgeTestRig } from './helpers/bridgeSetup.js';
import { cleanupDir, createWorkspace, makeTempDir, startStaticServer, waitFor } from './helpers/testUtils.js';

const fakeCodexCommand = path.resolve('test/fixtures/fake-codex.mjs');

async function dispatch(bridge: unknown, message: unknown): Promise<void> {
  await (bridge as any).handleMessage(message as any);
}

function findSent(channel: FakeChannel, pattern: RegExp): boolean {
  return channel.sent.some((message) => pattern.test(message.content));
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

  assert.ok(rootChannel.sent.some((message) => /Codex 实时进度/.test(message.content)));
  assert.ok(rootChannel.sent.some((message) => /Create a short plan/.test(message.content)));
  await cleanupDir(rootDir);
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
  } finally {
    delete process.env.FAKE_CODEX_LOG_DIR;
    await staticServer.close();
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
