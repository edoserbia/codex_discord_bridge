import path from 'node:path';

import { createBridgeTestRig } from '../test/helpers/bridgeSetup.js';
import { FakeChannel, createUserMessage } from '../test/helpers/fakeDiscord.js';
import { cleanupDir, createWorkspace, makeTempDir, waitFor } from '../test/helpers/testUtils.js';

async function main(): Promise<void> {
  const rootDir = await makeTempDir('codex-bridge-smoke-local-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: path.resolve('test/fixtures/fake-codex.mjs'),
  });

  const rootChannel = new FakeChannel('smoke-channel', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  try {
    await (bridge as any).handleMessage(createUserMessage(rootChannel, `!bind smoke "${workspace}"`, { userId: 'admin-user' }));
    await (bridge as any).handleMessage(createUserMessage(rootChannel, '[command] local smoke run'));

    await waitFor(() => rootChannel.sent.some((message) => /local smoke run/.test(message.content)));

    console.log('Local smoke succeeded.');
    console.log(`Workspace: ${workspace}`);
    console.log(`Messages sent: ${rootChannel.sent.length}`);
  } finally {
    await cleanupDir(rootDir);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
