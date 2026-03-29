import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { AdminWebServer } from '../src/webServer.js';
import { runCli } from '../src/cli.js';

import { createBridgeTestRig } from './helpers/bridgeSetup.js';
import { FakeChannel } from './helpers/fakeDiscord.js';
import { cleanupDir, createWorkspace, makeTempDir } from './helpers/testUtils.js';

const fakeCodexCommand = path.resolve('test/fixtures/fake-codex.mjs');

function createMemoryStream(): {
  write: (chunk: string) => void;
  toString: () => string;
} {
  const chunks: string[] = [];
  return {
    write(chunk: string) {
      chunks.push(chunk);
    },
    toString() {
      return chunks.join('');
    },
  };
}

test('runCli sends project autopilot commands to the running bridge by explicit project name', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-cli-project-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, config, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeCodexCommand,
    webEnabled: true,
    webPort: 0,
    webAuthToken: 'secret-token',
  });

  const rootChannel = new FakeChannel('channel-api', 'guild-1');
  channels.set(rootChannel.id, rootChannel);
  await bridge.bindChannel({
    channelId: rootChannel.id,
    guildId: rootChannel.guildId,
    projectName: 'api',
    workspacePath: workspace,
  });

  const webServer = new AdminWebServer(config, bridge);
  await webServer.start();

  try {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      ['autopilot', 'project', 'status', '--project', 'api'],
      {
        stdout,
        stderr,
        env: {
          CODEX_DISCORD_BRIDGE_WEB_ORIGIN: webServer.getOrigin(),
          CODEX_DISCORD_BRIDGE_WEB_AUTH_TOKEN: 'secret-token',
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.equal(stderr.toString(), '');
    assert.match(stdout.toString(), /Autopilot 项目状态：\*\*api\*\*/);
  } finally {
    await webServer.stop();
    await cleanupDir(rootDir);
  }
});

test('runCli resolves the project from cwd when no explicit target is given', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-cli-cwd-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, config, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeCodexCommand,
    webEnabled: true,
    webPort: 0,
    webAuthToken: 'secret-token',
  });

  const rootChannel = new FakeChannel('channel-api', 'guild-1');
  channels.set(rootChannel.id, rootChannel);
  await bridge.bindChannel({
    channelId: rootChannel.id,
    guildId: rootChannel.guildId,
    projectName: 'api',
    workspacePath: workspace,
  });

  const webServer = new AdminWebServer(config, bridge);
  await webServer.start();

  try {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const exitCode = await runCli(
      ['autopilot', 'project', 'status'],
      {
        cwd: workspace,
        stdout,
        stderr,
        env: {
          CODEX_DISCORD_BRIDGE_WEB_ORIGIN: webServer.getOrigin(),
          CODEX_DISCORD_BRIDGE_WEB_AUTH_TOKEN: 'secret-token',
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.equal(stderr.toString(), '');
    assert.match(stdout.toString(), /Autopilot 项目状态：\*\*api\*\*/);
  } finally {
    await webServer.stop();
    await cleanupDir(rootDir);
  }
});

test('runCli reports a connection error when the bridge service is unavailable', async () => {
  const stdout = createMemoryStream();
  const stderr = createMemoryStream();

  const exitCode = await runCli(
    ['autopilot', 'status'],
    {
      stdout,
      stderr,
      env: {
        CODEX_DISCORD_BRIDGE_WEB_ORIGIN: 'http://127.0.0.1:9',
      },
    },
  );

  assert.equal(exitCode, 1);
  assert.equal(stdout.toString(), '');
  assert.match(stderr.toString(), /bridge 服务不可用|fetch failed|ECONNREFUSED/i);
});

test('runCli prints local autopilot help for the bare autopilot command', async () => {
  const stdout = createMemoryStream();
  const stderr = createMemoryStream();

  const exitCode = await runCli(
    ['autopilot'],
    {
      stdout,
      stderr,
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), '');
  assert.match(stdout.toString(), /bridgectl autopilot status/);
  assert.match(stdout.toString(), /--project <绑定项目名>/);
});
