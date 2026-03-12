import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

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
