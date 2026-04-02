import test from 'node:test';
import assert from 'node:assert/strict';

import { createBridgeTestRig } from './helpers/bridgeSetup.js';
import { FakeChannel, createUserMessage } from './helpers/fakeDiscord.js';
import { cleanupDir, createWorkspace, makeTempDir, waitFor } from './helpers/testUtils.js';

const fakeCodexCommand = new URL('./fixtures/fake-codex.mjs', import.meta.url).pathname;

async function dispatch(bridge: unknown, message: unknown): Promise<void> {
  await (bridge as any).handleMessage(message as any);
}

function findSent(channel: FakeChannel, pattern: RegExp): boolean {
  return channel.sent.some((message) => pattern.test(message.content));
}

test('bridge retries transient Discord final-reply send failures and still delivers the full reply', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-e2e-discord-final-retry-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
  const rootChannel = new FakeChannel('channel-discord-final-retry', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));

  const originalSend = rootChannel.send.bind(rootChannel);
  let failedAttempts = 0;

  (rootChannel as any).send = async (payload: any) => {
    const content = typeof payload === 'string' ? payload : payload?.content ?? '';

    if (typeof content === 'string' && content.includes('FINAL_CHUNK_MARKER') && failedAttempts < 2) {
      failedAttempts += 1;
      throw new Error('read ECONNRESET');
    }

    return originalSend(payload);
  };

  try {
    const longPrompt = `${'segment '.repeat(500)} FINAL_CHUNK_MARKER`;
    await dispatch(bridge, createUserMessage(rootChannel, longPrompt));
    await waitFor(() => findSent(rootChannel, /FINAL_CHUNK_MARKER/), 20_000);
    assert.equal(failedAttempts, 2);
  } finally {
    (rootChannel as any).send = originalSend;
    await cleanupDir(rootDir);
  }
});
