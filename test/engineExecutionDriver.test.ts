import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import type { AppConfig } from '../src/config.js';
import type { ChannelBinding } from '../src/types.js';

import { createCodexExecutionDriver } from '../src/createCodexExecutionDriver.js';

import { cleanupDir, createWorkspace, makeTempDir } from './helpers/testUtils.js';

const fakeCodexCommand = path.resolve('test/fixtures/fake-codex.mjs');
const fakeClaudeCommand = path.resolve('test/fixtures/fake-claude.mjs');

function makeConfig(rootDir: string): AppConfig {
  return {
    discordToken: 'test-token',
    commandPrefix: '!',
    dataDir: path.join(rootDir, 'data'),
    codexCommand: fakeCodexCommand,
    claudeCommand: fakeClaudeCommand,
    claudeSettingsPath: path.join(rootDir, '.claude', 'settings.json'),
    codexDriverMode: 'legacy-exec',
    codexMaxAttempts: 10,
    codexRateLimitMaxAttempts: 0,
    codexRateLimitBaseDelayMs: 5_000,
    codexRateLimitMaxDelayMs: 60_000,
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

test('engine driver preserves codex as the default route', async () => {
  const rootDir = await makeTempDir('engine-driver-codex-');
  const workspace = await createWorkspace(rootDir);
  const driver = createCodexExecutionDriver(makeConfig(rootDir));
  const binding = makeBinding(workspace);

  try {
    const job = driver.start(binding, { prompt: 'hello codex', imagePaths: [], extraAddDirs: [] }, undefined);
    const result = await job.done;

    assert.equal(job.driverMode, 'legacy-exec');
    assert.equal(result.engine, undefined);
    assert.equal(result.success, true);
    assert.ok(result.codexThreadId);
    assert.equal(result.claudeSessionId, undefined);
  } finally {
    await driver.stop?.();
    await cleanupDir(rootDir);
  }
});

test('engine driver routes claude input to Claude CLI', async () => {
  const rootDir = await makeTempDir('engine-driver-claude-');
  const workspace = await createWorkspace(rootDir);
  const driver = createCodexExecutionDriver(makeConfig(rootDir));
  const binding = makeBinding(workspace);

  try {
    const job = driver.start(binding, { engine: 'claude', prompt: 'hello claude', imagePaths: [], extraAddDirs: [] }, undefined);
    const result = await job.done;

    assert.equal(job.driverMode, 'claude-cli');
    assert.equal(result.engine, 'claude');
    assert.equal(result.success, true);
    assert.equal(result.codexThreadId, undefined);
    assert.ok(result.claudeSessionId);
  } finally {
    await driver.stop?.();
    await cleanupDir(rootDir);
  }
});
