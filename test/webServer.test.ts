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

test('web server supports bearer auth and browser token bootstrap cookie', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-web-auth-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, config, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeCodexCommand,
    webEnabled: true,
    webPort: 0,
    webAuthToken: 'secret-token',
  });

  const rootChannel = new FakeChannel('channel-auth', 'guild-1');
  channels.set(rootChannel.id, rootChannel);

  const webServer = new AdminWebServer(config, bridge);
  await webServer.start();

  try {
    const unauthorizedResponse = await fetch(`${webServer.getOrigin()}/api/dashboard`);
    assert.equal(unauthorizedResponse.status, 401);

    const invalidBootstrapResponse = await fetch(`${webServer.getOrigin()}/?token=wrong-token`, { redirect: 'manual' });
    assert.equal(invalidBootstrapResponse.status, 401);

    const bindResponse = await fetch(`${webServer.getOrigin()}/api/bindings`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        channelId: rootChannel.id,
        projectName: 'api-auth',
        workspacePath: workspace,
      }),
    });
    assert.equal(bindResponse.status, 200);

    const bearerDashboardResponse = await fetch(`${webServer.getOrigin()}/api/dashboard`, {
      headers: { authorization: 'Bearer secret-token' },
    });
    assert.equal(bearerDashboardResponse.status, 200);

    const bootstrapResponse = await fetch(`${webServer.getOrigin()}/?token=secret-token`, { redirect: 'manual' });
    assert.equal(bootstrapResponse.status, 302);
    assert.equal(bootstrapResponse.headers.get('location'), '/');

    const setCookie = bootstrapResponse.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /codex_bridge_auth=secret-token/);
    const cookieHeader = setCookie.split(';', 1)[0];

    const cookieDashboardResponse = await fetch(`${webServer.getOrigin()}/api/dashboard`, {
      headers: { cookie: cookieHeader },
    });
    assert.equal(cookieDashboardResponse.status, 200);

    const dashboard = await cookieDashboardResponse.json() as Array<{ binding: { channelId: string } }>;
    assert.equal(dashboard.length, 1);
    assert.equal(dashboard[0]?.binding.channelId, rootChannel.id);
  } finally {
    await webServer.stop();
    await cleanupDir(rootDir);
  }
});
