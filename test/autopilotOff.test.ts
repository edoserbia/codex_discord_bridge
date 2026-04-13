import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { FakeChannel, createUserMessage } from './helpers/fakeDiscord.js';
import { createBridgeTestRig } from './helpers/bridgeSetup.js';
import { cleanupDir, createWorkspace, makeTempDir, waitFor } from './helpers/testUtils.js';

const fakeCodexCommand = path.resolve('test/fixtures/fake-codex.mjs');

async function dispatch(bridge: unknown, message: unknown): Promise<void> {
  await (bridge as any).handleMessage(message as any);
}

test('project-level autopilot off from Discord stops a running autopilot started by local control', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-autopilot-project-off-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, store, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-autopilot-project-off', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, '!autopilot server on', { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, '!autopilot project prompt [cancel] stop this autopilot when paused', { userId: 'admin-user' }));
    await dispatch(bridge, createUserMessage(rootChannel, '!autopilot project on', { userId: 'admin-user' }));

    const trigger = await (bridge as any).executeAutopilotControlCommand(
      { kind: 'autopilot', scope: 'project', action: 'run' },
      { projectName: 'api' },
    );
    assert.equal(trigger.ok, true);

    const autopilotProject = store.getAutopilotProject(rootChannel.id)!;
    const autopilotThread = channels.get(autopilotProject.threadChannelId!)!;

    await waitFor(() => autopilotThread.sent.some((message) => /Autopilot 已启动/.test(message.content)), 20_000);
    await waitFor(() => (bridge as any).getDashboardData().some((entry: any) => entry.binding.channelId === rootChannel.id
      && entry.conversations.some((conversation: any) => conversation.conversationId === autopilotThread.id
        && ['starting', 'running'].includes(conversation.status))), 15_000);

    await dispatch(bridge, createUserMessage(rootChannel, '!autopilot project off', { userId: 'admin-user' }));

    await waitFor(() => !(bridge as any).getDashboardData().some((entry: any) => entry.binding.channelId === rootChannel.id
      && entry.conversations.some((conversation: any) => conversation.conversationId === autopilotThread.id
        && ['starting', 'running', 'cancelled'].includes(conversation.status))), 15_000);
    await waitFor(() => store.getAutopilotProject(rootChannel.id)?.status === 'paused', 15_000);

    assert.equal(store.getAutopilotProject(rootChannel.id)?.enabled, false);
    assert.equal(store.getAutopilotProject(rootChannel.id)?.lastResultStatus, 'skipped');
    assert.ok(autopilotThread.sent.some((message) => /Autopilot 跳过/.test(message.content)));

    const startCountBeforeTick = autopilotThread.sent.filter((message) => /Autopilot 已启动/.test(message.content)).length;
    await (bridge as any).runAutopilotTick();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const startCountAfterTick = autopilotThread.sent.filter((message) => /Autopilot 已启动/.test(message.content)).length;
    assert.equal(startCountAfterTick, startCountBeforeTick);
  } finally {
    await cleanupDir(rootDir);
  }
});
