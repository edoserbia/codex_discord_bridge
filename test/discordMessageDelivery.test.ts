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
  const prompt = 'transient final reply test';

  await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));

  const originalSend = rootChannel.send.bind(rootChannel);
  let failedAttempts = 0;

  (rootChannel as any).send = async (payload: any) => {
    const content = typeof payload === 'string' ? payload : payload?.content ?? '';

    if (typeof content === 'string'
      && content.includes('🤖 **api**')
      && content.includes(`ok: ${prompt}`)
      && failedAttempts < 2) {
      failedAttempts += 1;
      throw new Error('read ECONNRESET');
    }

    return originalSend(payload);
  };

  try {
    await dispatch(bridge, createUserMessage(rootChannel, prompt));
    await waitFor(() => rootChannel.sent.some((message) => /🤖 \*\*api\*\*/.test(message.content)
      && /ok: transient final reply test/.test(message.content)), 20_000);
    assert.equal(failedAttempts, 2);
  } finally {
    (rootChannel as any).send = originalSend;
    await (bridge as any).stop?.();
    await cleanupDir(rootDir);
  }
});

for (const failure of [
  {
    label: 'EPIPE',
    createError: () => {
      const error = new Error('write EPIPE') as Error & { code?: string };
      error.code = 'EPIPE';
      return error;
    },
  },
  {
    label: 'aborted',
    createError: () => new Error('This operation was aborted'),
  },
]) {
  test(`bridge defers final replies for transient Discord errors (${failure.label}) and flushes them after recovery`, { concurrency: false }, async () => {
    const rootDir = await makeTempDir(`codex-bridge-e2e-discord-deferred-${failure.label}-`);
    const workspace = await createWorkspace(rootDir);
    const { bridge, store, channels } = await createBridgeTestRig({ rootDir, codexCommand: fakeCodexCommand });
    const rootChannel = new FakeChannel(`channel-discord-deferred-${failure.label}`, 'guild-1');
    channels.set(rootChannel.id, rootChannel);

    try {
      await dispatch(bridge, createUserMessage(rootChannel, `!bind api "${workspace}"`, { userId: 'admin-user' }));

      const originalSend = rootChannel.send.bind(rootChannel);
      const failUntil = Date.now() + 5_000;

      rootChannel.send = async (payload: any): Promise<any> => {
        const content = typeof payload === 'string' ? payload : payload?.content ?? '';

        if (typeof content === 'string' && /ok: deferred reply/.test(content) && Date.now() < failUntil) {
          throw failure.createError();
        }

        return originalSend(payload);
      };

      await dispatch(bridge, createUserMessage(rootChannel, `deferred reply ${failure.label} test`));
      await waitFor(() => rootChannel.sent.some((message) => /🤖 \*\*api\*\*/.test(message.content)
        && new RegExp(`ok: deferred reply ${failure.label} test`).test(message.content)), 20_000);
      await waitFor(() => (((store.getRuntimeState(rootChannel.id) as any)?.pendingReplies?.length ?? 0) === 0), 20_000);
    } finally {
      await (bridge as any).stop?.();
      await cleanupDir(rootDir);
    }
  });
}
