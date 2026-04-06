import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { AdminWebServer } from '../src/webServer.js';
import * as webServerModule from '../src/webServer.js';

import { createBridgeTestRig } from './helpers/bridgeSetup.js';
import { FakeChannel, createUserMessage } from './helpers/fakeDiscord.js';
import { cleanupDir, createWorkspace, makeTempDir, waitFor } from './helpers/testUtils.js';

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

test('web server executes autopilot commands through the local control API', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-web-autopilot-api-');
  const workspaceA = await createWorkspace(path.join(rootDir, 'workspace-a'));
  const workspaceB = await createWorkspace(path.join(rootDir, 'workspace-b'));
  const { bridge, config, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeCodexCommand,
    webEnabled: true,
    webPort: 0,
    webAuthToken: 'secret-token',
  });

  const apiChannel = new FakeChannel('channel-api', 'guild-1');
  const webChannel = new FakeChannel('channel-web', 'guild-1');
  channels.set(apiChannel.id, apiChannel);
  channels.set(webChannel.id, webChannel);

  await bridge.bindChannel({
    channelId: apiChannel.id,
    guildId: apiChannel.guildId,
    projectName: 'api',
    workspacePath: workspaceA,
  });
  await bridge.bindChannel({
    channelId: webChannel.id,
    guildId: webChannel.guildId,
    projectName: 'web',
    workspacePath: workspaceB,
  });

  const webServer = new AdminWebServer(config, bridge);
  await webServer.start();

  try {
    const serviceResponse = await fetch(`${webServer.getOrigin()}/api/autopilot/command`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        commandText: '!autopilot server on',
      }),
    });

    assert.equal(serviceResponse.status, 200);
    const servicePayload = await serviceResponse.json() as { ok: boolean; message: string };
    assert.equal(servicePayload.ok, true);
    assert.match(servicePayload.message, /已开启当前 bridge 进程里所有已绑定项目的服务级 Autopilot/);

    const projectResponse = await fetch(`${webServer.getOrigin()}/api/autopilot/command`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        commandText: '!autopilot project on',
        projectName: 'api',
      }),
    });

    assert.equal(projectResponse.status, 200);
    const projectPayload = await projectResponse.json() as {
      ok: boolean;
      message: string;
      resolvedTarget?: { projectName: string; channelId: string; mode: string };
    };
    assert.equal(projectPayload.ok, true);
    assert.equal(projectPayload.resolvedTarget?.projectName, 'api');
    assert.equal(projectPayload.resolvedTarget?.channelId, apiChannel.id);
    assert.equal(projectPayload.resolvedTarget?.mode, 'project');
    assert.match(projectPayload.message, /已更新 \*\*api\*\* 的项目级 Autopilot 设置/);

    const cwdResponse = await fetch(`${webServer.getOrigin()}/api/autopilot/command`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        commandText: '!autopilot project status',
        cwd: workspaceB,
      }),
    });

    assert.equal(cwdResponse.status, 200);
    const cwdPayload = await cwdResponse.json() as {
      ok: boolean;
      message: string;
      resolvedTarget?: { projectName: string; mode: string };
    };
    assert.equal(cwdPayload.ok, true);
    assert.equal(cwdPayload.resolvedTarget?.projectName, 'web');
    assert.equal(cwdPayload.resolvedTarget?.mode, 'cwd');
    assert.match(cwdPayload.message, /Autopilot 项目状态：\*\*web\*\*/);
  } finally {
    await webServer.stop();
    await cleanupDir(rootDir);
  }
});

test('web server resolves and continues a session by codex thread id', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-web-session-api-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, config, store, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeCodexCommand,
    webEnabled: true,
    webPort: 0,
    webAuthToken: 'secret-token',
  });

  const rootChannel = new FakeChannel('channel-session-api', 'guild-1');
  channels.set(rootChannel.id, rootChannel);
  await bridge.bindChannel({
    channelId: rootChannel.id,
    guildId: rootChannel.guildId,
    projectName: 'api',
    workspacePath: workspace,
  });

  await (bridge as any).handleMessage(createUserMessage(rootChannel, 'first prompt'));
  await waitFor(() => rootChannel.sent.some((message) => /ok: first prompt/.test(message.content)), 15_000);

  const codexThreadId = store.getSession(rootChannel.id)?.codexThreadId;
  assert.ok(codexThreadId);

  const webServer = new AdminWebServer(config, bridge);
  await webServer.start();

  try {
    const statusResponse = await fetch(`${webServer.getOrigin()}/api/sessions/by-codex-thread/${encodeURIComponent(codexThreadId!)}`, {
      headers: { authorization: 'Bearer secret-token' },
    });
    assert.equal(statusResponse.status, 200);
    const statusPayload = await statusResponse.json() as {
      codexThreadId: string;
      conversationId: string;
      bindingChannelId: string;
      projectName: string;
      workspacePath: string;
    };
    assert.equal(statusPayload.codexThreadId, codexThreadId);
    assert.equal(statusPayload.conversationId, rootChannel.id);
    assert.equal(statusPayload.bindingChannelId, rootChannel.id);
    assert.equal(statusPayload.projectName, 'api');
    assert.equal(statusPayload.workspacePath, store.getBinding(rootChannel.id)?.workspacePath);

    const sendResponse = await fetch(`${webServer.getOrigin()}/api/sessions/by-codex-thread/${encodeURIComponent(codexThreadId!)}/send`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        prompt: 'hello from web api',
      }),
    });
    assert.equal(sendResponse.status, 200);
    const sendPayload = await sendResponse.json() as {
      ok: boolean;
      assistantMessage: string;
      codexThreadId: string;
    };
    assert.equal(sendPayload.ok, true);
    assert.equal(sendPayload.codexThreadId, codexThreadId);
    assert.match(sendPayload.assistantMessage, /ok: hello from web api/);
    assert.equal(store.getSession(rootChannel.id)?.codexThreadId, codexThreadId);
  } finally {
    await webServer.stop();
    await cleanupDir(rootDir);
  }
});

test('web server builds concrete local and lan access urls instead of exposing 0.0.0.0', { concurrency: false }, async () => {
  const urls = ((webServerModule as any).buildWebAccessUrls?.({
    bind: '0.0.0.0',
    port: 3769,
    authToken: 'secret-token',
  }, {
    address: '0.0.0.0',
    port: 3769,
  }, {
    lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    en0: [{ family: 'IPv4', address: '192.168.50.8', internal: false }],
  }) ?? []) as Array<{ label: string; url: string }>;

  assert.ok(urls.some((entry) => entry.label === '本机' && entry.url === 'http://127.0.0.1:3769/?token=secret-token'));
  assert.ok(urls.some((entry) => entry.label === '局域网' && entry.url === 'http://192.168.50.8:3769/?token=secret-token'));
  assert.ok(urls.every((entry) => !entry.url.includes('0.0.0.0')));
});
