import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { AdminWebServer } from '../src/webServer.js';

import { createBridgeTestRig } from './helpers/bridgeSetup.js';
import { FakeChannel } from './helpers/fakeDiscord.js';
import { cleanupDir, createWorkspace, makeTempDir } from './helpers/testUtils.js';

const fakeCodexCommand = path.resolve('test/fixtures/fake-codex.mjs');

test('web server can bind, inspect dashboard, reset conversation, and unbind', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-web-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, config, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeCodexCommand,
    webEnabled: true,
    webPort: 0,
  });

  const rootChannel = new FakeChannel('channel-root', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  const webServer = new AdminWebServer(config, bridge);
  await webServer.start();

  try {
    const bindResponse = await fetch(`${webServer.getOrigin()}/api/bindings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channelId: rootChannel.id,
        projectName: 'api',
        workspacePath: workspace,
      }),
    });
    assert.equal(bindResponse.status, 200);

    const dashboardResponse = await fetch(`${webServer.getOrigin()}/api/dashboard`);
    const dashboard = await dashboardResponse.json() as Array<{ binding: { channelId: string }; conversations: Array<{ conversationId: string }> }>;
    assert.equal(dashboard.length, 1);
    assert.equal(dashboard[0]?.binding.channelId, rootChannel.id);
    assert.equal(dashboard[0]?.conversations[0]?.conversationId, rootChannel.id);

    const resetResponse = await fetch(`${webServer.getOrigin()}/api/conversations/${rootChannel.id}/reset`, { method: 'POST' });
    assert.equal(resetResponse.status, 200);

    const deleteResponse = await fetch(`${webServer.getOrigin()}/api/bindings/${rootChannel.id}`, { method: 'DELETE' });
    assert.equal(deleteResponse.status, 200);
  } finally {
    await webServer.stop();
    await cleanupDir(rootDir);
  }
});
