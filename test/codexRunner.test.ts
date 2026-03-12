import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

import type { AppConfig } from '../src/config.js';
import type { ChannelBinding } from '../src/types.js';

import { CodexRunner } from '../src/codexRunner.js';

import { cleanupDir, createWorkspace, makeTempDir, waitFor } from './helpers/testUtils.js';

const fakeCodexCommand = path.resolve('test/fixtures/fake-codex.mjs');

function makeConfig(rootDir: string, codexCommand = fakeCodexCommand): AppConfig {
  return {
    discordToken: 'test-token',
    commandPrefix: '!',
    dataDir: path.join(rootDir, 'data'),
    codexCommand,
    allowedWorkspaceRoots: [rootDir],
    adminUserIds: new Set(),
    defaultCodex: {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      search: false,
      skipGitRepoCheck: true,
      addDirs: [],
      extraConfig: [],
    },
    web: {
      enabled: false,
      bind: '127.0.0.1',
      port: 0,
      authToken: undefined,
    },
  };
}

function makeBinding(workspacePath: string): ChannelBinding {
  return {
    channelId: 'channel-1',
    guildId: 'guild-1',
    projectName: 'api',
    workspacePath,
    codex: {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      search: false,
      skipGitRepoCheck: true,
      addDirs: [],
      extraConfig: [],
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test('runner handles simple execution and thread creation', async () => {
  const rootDir = await makeTempDir('codex-runner-simple-');
  const workspace = await createWorkspace(rootDir);
  const runner = new CodexRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);
  const activities: string[] = [];

  const job = runner.start(binding, { prompt: 'hello world', imagePaths: [], extraAddDirs: [] }, undefined, {
    onActivity: async (activity) => { activities.push(activity); },
  });
  const result = await job.done;

  assert.equal(result.success, true);
  assert.ok(result.codexThreadId);
  assert.match(result.agentMessages.at(-1) ?? '', /hello world/);
  assert.ok(activities.includes('Codex 正在分析请求'));
  await cleanupDir(rootDir);
});

test('runner surfaces reasoning and todo list updates', async () => {
  const rootDir = await makeTempDir('codex-runner-plan-');
  const workspace = await createWorkspace(rootDir);
  const runner = new CodexRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);
  const reasoning: string[] = [];
  const planSnapshots: Array<Array<{ text: string; completed: boolean }>> = [];

  const result = await runner.start(binding, { prompt: '[plan] inspect', imagePaths: [], extraAddDirs: [] }, undefined, {
    onReasoning: async (message) => { reasoning.push(message); },
    onTodoListChanged: async (items) => { planSnapshots.push(items.map((item) => ({ ...item }))); },
  }).done;

  assert.equal(result.success, true);
  assert.ok(reasoning.length >= 1);
  assert.ok(planSnapshots.length >= 2);
  assert.equal(planSnapshots.at(-1)?.every((item) => item.completed), true);
  await cleanupDir(rootDir);
});

test('runner handles resume and command events', async () => {
  const rootDir = await makeTempDir('codex-runner-resume-');
  const workspace = await createWorkspace(rootDir);
  const runner = new CodexRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);
  const startedCommands: string[] = [];

  const result = await runner.start(binding, { prompt: '[command] run', imagePaths: [], extraAddDirs: [] }, 'thread-existing', {
    onCommandStarted: async (command) => { startedCommands.push(command); },
  }).done;

  assert.equal(result.success, true);
  assert.equal(result.usedResume, true);
  assert.equal(result.codexThreadId, 'thread-existing');
  assert.equal(result.commands.length, 1);
  assert.equal(startedCommands.length, 1);
  await cleanupDir(rootDir);
});

test('runner orders global and exec arguments for real Codex CLI compatibility', async () => {
  const rootDir = await makeTempDir('codex-runner-argv-');
  const workspace = await createWorkspace(rootDir);
  const logDir = path.join(rootDir, 'fake-codex-logs');
  process.env.FAKE_CODEX_LOG_DIR = logDir;

  const runner = new CodexRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);
  binding.codex.sandboxMode = 'danger-full-access';
  binding.codex.search = true;

  try {
    const result = await runner.start(binding, { prompt: 'hello argv', imagePaths: [], extraAddDirs: [] }, undefined).done;
    assert.equal(result.success, true);

    const logFiles = await readdir(logDir);
    assert.ok(logFiles.length > 0);
    const payload = JSON.parse(await readFile(path.join(logDir, logFiles.sort().at(-1)!), 'utf8')) as {
      argv: string[];
    };

    const execIndex = payload.argv.indexOf('exec');
    assert.ok(execIndex >= 0);
    assert.deepEqual(payload.argv.slice(0, 3), ['-a', 'never', '--search']);
    assert.ok(payload.argv.indexOf('-s') > execIndex);
    assert.ok(payload.argv.indexOf('-C') > execIndex);
  } finally {
    delete process.env.FAKE_CODEX_LOG_DIR;
    await cleanupDir(rootDir);
  }
});

test('runner strips nested codex desktop env vars before spawning child codex', async () => {
  const rootDir = await makeTempDir('codex-runner-env-');
  const workspace = await createWorkspace(rootDir);
  const logDir = path.join(rootDir, 'fake-codex-logs');
  process.env.FAKE_CODEX_LOG_DIR = logDir;

  const previous = {
    CODEX_CI: process.env.CODEX_CI,
    CODEX_SHELL: process.env.CODEX_SHELL,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE,
  };

  process.env.CODEX_CI = '1';
  process.env.CODEX_SHELL = '1';
  process.env.CODEX_THREAD_ID = 'desktop-thread';
  process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'Codex Desktop';

  const runner = new CodexRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);

  try {
    const result = await runner.start(binding, { prompt: 'hello env', imagePaths: [], extraAddDirs: [] }, undefined).done;
    assert.equal(result.success, true);

    const logFiles = await readdir(logDir);
    assert.ok(logFiles.length > 0);
    const payload = JSON.parse(await readFile(path.join(logDir, logFiles.sort().at(-1)!), 'utf8')) as {
      env: Record<string, string | undefined>;
    };

    assert.equal(payload.env.PWD, workspace);
    assert.equal(payload.env.CODEX_CI, undefined);
    assert.equal(payload.env.CODEX_SHELL, undefined);
    assert.equal(payload.env.CODEX_THREAD_ID, undefined);
    assert.equal(payload.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, undefined);
  } finally {
    delete process.env.FAKE_CODEX_LOG_DIR;

    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    await cleanupDir(rootDir);
  }
});

test('runner uses dangerous bypass for resume when binding requests danger-full-access', async () => {
  const rootDir = await makeTempDir('codex-runner-resume-danger-');
  const workspace = await createWorkspace(rootDir);
  const logDir = path.join(rootDir, 'fake-codex-logs');
  process.env.FAKE_CODEX_LOG_DIR = logDir;

  const runner = new CodexRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);
  binding.codex.sandboxMode = 'danger-full-access';

  try {
    const result = await runner.start(binding, { prompt: 'hello resume danger', imagePaths: [], extraAddDirs: [] }, 'thread-danger', undefined).done;
    assert.equal(result.success, true);

    const logFiles = await readdir(logDir);
    assert.ok(logFiles.length > 0);
    const payload = JSON.parse(await readFile(path.join(logDir, logFiles.sort().at(-1)!), 'utf8')) as {
      argv: string[];
    };

    const resumeIndex = payload.argv.indexOf('resume');
    assert.ok(resumeIndex >= 0);
    assert.ok(payload.argv.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(payload.argv.indexOf('--dangerously-bypass-approvals-and-sandbox') > resumeIndex);
  } finally {
    delete process.env.FAKE_CODEX_LOG_DIR;
    await cleanupDir(rootDir);
  }
});

test('runner propagates stderr and failures', async () => {
  const rootDir = await makeTempDir('codex-runner-fail-');
  const workspace = await createWorkspace(rootDir);
  const runner = new CodexRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);

  const result = await runner.start(binding, { prompt: '[fail] run', imagePaths: [], extraAddDirs: [] }, undefined).done;

  assert.equal(result.success, false);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr.join('\n'), /intentional fake failure/);
  await cleanupDir(rootDir);
});

test('runner survives command-not-found startup errors', async () => {
  const rootDir = await makeTempDir('codex-runner-spawn-');
  const workspace = await createWorkspace(rootDir);
  const runner = new CodexRunner(makeConfig(rootDir, path.join(rootDir, 'missing-codex')));
  const binding = makeBinding(workspace);

  const result = await runner.start(binding, { prompt: 'hello', imagePaths: [], extraAddDirs: [] }, undefined).done;

  assert.equal(result.success, false);
  assert.equal(result.exitCode, null);
  assert.ok(result.stderr.length > 0);
  await cleanupDir(rootDir);
});

test('runner can cancel a long-running command', async () => {
  const rootDir = await makeTempDir('codex-runner-cancel-');
  const workspace = await createWorkspace(rootDir);
  const runner = new CodexRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);

  const job = runner.start(binding, { prompt: '[cancel] run', imagePaths: [], extraAddDirs: [] }, undefined);
  await waitFor(async () => job.pid !== undefined, 2_000);
  setTimeout(() => job.cancel(), 200);
  const result = await job.done;

  assert.equal(result.success, false);
  assert.match(result.stderr.join('\n'), /cancelled|interrupted/);
  await cleanupDir(rootDir);
});
