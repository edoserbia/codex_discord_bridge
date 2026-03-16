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
