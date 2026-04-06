import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { AdminWebServer } from '../src/webServer.js';
import { runCli } from '../src/cli.js';

import { createBridgeTestRig } from './helpers/bridgeSetup.js';
import { FakeChannel, createUserMessage } from './helpers/fakeDiscord.js';
import { cleanupDir, createWorkspace, makeTempDir, waitFor } from './helpers/testUtils.js';

const fakeCodexCommand = path.resolve('test/fixtures/fake-codex.mjs');

function createMemoryStream(): {
  write: (chunk: string) => void;
  toString: () => string;
  isTTY?: boolean;
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

class FakeTTYInput extends PassThrough {
  readonly isTTY = true;
  readonly rawModeChanges: boolean[] = [];

  setRawMode(mode: boolean) {
    this.rawModeChanges.push(mode);
    return this;
  }
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

test('runCli session resume buffers a bracketed multi-line paste and sends it as one turn on explicit enter', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-cli-resume-paste-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, config, channels, store } = await createBridgeTestRig({
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

  await (bridge as any).handleMessage(createUserMessage(rootChannel, 'first prompt'));
  await waitFor(() => rootChannel.sent.some((message) => /ok: first prompt/.test(message.content)), 15_000);

  const codexThreadId = store.getSession(rootChannel.id)?.codexThreadId;
  assert.ok(codexThreadId);

  const webServer = new AdminWebServer(config, bridge);
  await webServer.start();

  try {
    const resumeStdout = createMemoryStream();
    const resumeStderr = createMemoryStream();
    const ttyInput = new FakeTTYInput();

    const resumePromise = runCli(
      ['session', 'resume', codexThreadId!],
      {
        stdout: resumeStdout,
        stderr: resumeStderr,
        stdin: ttyInput as any,
        env: {
          CODEX_DISCORD_BRIDGE_WEB_ORIGIN: webServer.getOrigin(),
          CODEX_DISCORD_BRIDGE_WEB_AUTH_TOKEN: 'secret-token',
        },
      } as any,
    );

    await new Promise((resolve) => setImmediate(resolve));
    ttyInput.write('\x1b[200~line1\nline2\x1b[201~');

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.doesNotMatch(resumeStdout.toString(), /ok: line1/);

    ttyInput.write('\n');
    await waitFor(() => /ok: line1\nline2/.test(resumeStdout.toString()), 15_000);
    ttyInput.write('/exit\n');

    const resumeExitCode = await resumePromise;

    assert.equal(resumeExitCode, 0);
    assert.equal(resumeStderr.toString(), '');
    assert.equal((resumeStdout.toString().match(/ok:/g) ?? []).length, 1);
    assert.match(resumeStdout.toString(), /多行粘贴/);
    assert.deepEqual(ttyInput.rawModeChanges, [true, false]);
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

test('runCli can inspect and continue a session through the running bridge', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-cli-session-');
  const workspace = await createWorkspace(rootDir);
  const { bridge, config, store, channels } = await createBridgeTestRig({
    rootDir,
    codexCommand: fakeCodexCommand,
    webEnabled: true,
    webPort: 0,
    webAuthToken: 'secret-token',
  });

  const rootChannel = new FakeChannel('channel-cli-session', 'guild-1');
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
    const statusStdout = createMemoryStream();
    const statusStderr = createMemoryStream();
    const statusExitCode = await runCli(
      ['session', 'status', codexThreadId!],
      {
        stdout: statusStdout,
        stderr: statusStderr,
        env: {
          CODEX_DISCORD_BRIDGE_WEB_ORIGIN: webServer.getOrigin(),
          CODEX_DISCORD_BRIDGE_WEB_AUTH_TOKEN: 'secret-token',
        },
      },
    );

    assert.equal(statusExitCode, 0);
    assert.equal(statusStderr.toString(), '');
    assert.match(statusStdout.toString(), /Resume ID:/);
    assert.match(statusStdout.toString(), /bridgectl session resume/);

    const sendStdout = createMemoryStream();
    const sendStderr = createMemoryStream();
    const sendExitCode = await runCli(
      ['session', 'send', codexThreadId!, 'hello from cli'],
      {
        stdout: sendStdout,
        stderr: sendStderr,
        env: {
          CODEX_DISCORD_BRIDGE_WEB_ORIGIN: webServer.getOrigin(),
          CODEX_DISCORD_BRIDGE_WEB_AUTH_TOKEN: 'secret-token',
        },
      },
    );

    assert.equal(sendExitCode, 0);
    assert.equal(sendStderr.toString(), '');
    assert.match(sendStdout.toString(), /ok: hello from cli/);

    const resumeStdout = createMemoryStream();
    const resumeStderr = createMemoryStream();
    const resumeExitCode = await runCli(
      ['session', 'resume', codexThreadId!],
      {
        stdout: resumeStdout,
        stderr: resumeStderr,
        stdin: Readable.from(['hello from resume\n', '/exit\n']),
        env: {
          CODEX_DISCORD_BRIDGE_WEB_ORIGIN: webServer.getOrigin(),
          CODEX_DISCORD_BRIDGE_WEB_AUTH_TOKEN: 'secret-token',
        },
      } as any,
    );

    assert.equal(resumeExitCode, 0);
    assert.equal(resumeStderr.toString(), '');
    assert.match(resumeStdout.toString(), /进入本机会话继续模式/);
    assert.match(resumeStdout.toString(), /ok: hello from resume/);
    assert.match(resumeStdout.toString(), /已退出会话继续模式/);
  } finally {
    await webServer.stop();
    await cleanupDir(rootDir);
  }
});
