import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import type { AppConfig } from '../src/config.js';
import type { ChannelBinding } from '../src/types.js';

import { CodexAppServerRunner } from '../src/codexAppServerRunner.js';

import { cleanupDir, createWorkspace, makeTempDir } from './helpers/testUtils.js';

const fakeAppServerCommand = path.resolve('test/fixtures/fake-codex-app-server.mjs');

function makeConfig(rootDir: string, codexCommand = fakeAppServerCommand): AppConfig {
  return {
    discordToken: 'test-token',
    commandPrefix: '!',
    dataDir: path.join(rootDir, 'data'),
    codexCommand,
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

test('app-server runner surfaces app-server failure details instead of a generic turn failure', async () => {
  const rootDir = await makeTempDir('codex-app-server-runner-failed-message-');
  const workspace = await createWorkspace(rootDir);
  const runner = new CodexAppServerRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);

  try {
    const result = await runner.start(
      binding,
      { prompt: '[app-failed-message] simulate 429 retry exhaustion', imagePaths: [], extraAddDirs: [] },
      undefined,
      undefined,
    ).done;

    assert.equal(result.success, false);
    assert.match(result.stderr.join('\n'), /Codex turn failed: exceeded retry limit, last status: 429 Too Many Requests/);
  } finally {
    await runner.stop();
    await cleanupDir(rootDir);
  }
});

test('app-server runner surfaces real Codex live item updates before final completion', async () => {
  const rootDir = await makeTempDir('codex-app-server-runner-real-live-');
  const workspace = await createWorkspace(rootDir);
  const runner = new CodexAppServerRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);
  const planSnapshots: string[][] = [];
  const reasoningSnapshots: string[] = [];
  const agentMessageSnapshots: string[] = [];

  try {
    const result = await runner.start(
      binding,
      { prompt: '[app-real-live] stream real app-server events', imagePaths: [], extraAddDirs: [] },
      undefined,
      {
        onTodoListChanged: async (items) => {
          planSnapshots.push(items.map((item) => `${item.completed ? 'done' : 'open'}:${item.text}`));
        },
        onReasoning: async (message) => {
          reasoningSnapshots.push(message);
        },
        onAgentMessage: async (message) => {
          agentMessageSnapshots.push(message);
        },
      },
    ).done;

    assert.equal(result.success, true);
    assert.deepEqual(planSnapshots.at(-1), [
      'done:Inspect real app-server events',
      'open:Patch realtime bridge updates',
    ]);
    assert.match(reasoningSnapshots.join('\n'), /Reading real-time event stream/);
    assert.match(agentMessageSnapshots.at(-1) ?? '', /Live draft from item\.updated/);
  } finally {
    await runner.stop();
    await cleanupDir(rootDir);
  }
});
