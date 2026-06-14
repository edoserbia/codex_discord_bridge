import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import type { AppConfig } from '../src/config.js';
import type { ChannelBinding } from '../src/types.js';

import { CodexAppServerRunner } from '../src/codexAppServerRunner.js';

import { cleanupDir, createWorkspace, makeTempDir, waitFor } from './helpers/testUtils.js';

const fakeAppServerCommand = path.resolve('test/fixtures/fake-codex-app-server.mjs');

function makeConfig(rootDir: string, codexCommand = fakeAppServerCommand, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    discordToken: 'test-token',
    commandPrefix: '!',
    dataDir: path.join(rootDir, 'data'),
    codexCommand,
    codexMaxAttempts: 10,
    codexRateLimitMaxAttempts: 0,
    codexRateLimitBaseDelayMs: 5_000,
    codexRateLimitMaxDelayMs: 60_000,
    codexAppServerInterruptTimeoutMs: 15_000,
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
    ...overrides,
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

test('app-server runner writes native image generation output into the workspace', async () => {
  const rootDir = await makeTempDir('codex-app-server-runner-image-generation-');
  const workspace = await createWorkspace(rootDir);
  const runner = new CodexAppServerRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);

  try {
    const result = await runner.start(
      binding,
      { prompt: '[app-image-generation] generate a native image', imagePaths: [], extraAddDirs: [] },
      undefined,
      undefined,
    ).done;

    assert.equal(result.success, true);
    assert.equal(result.generatedFiles?.length, 1);
    assert.match(result.generatedFiles![0]!.workspaceRelativePath, /^codex-generated-images\/image-turn-[a-z0-9]+\.png$/);
    assert.equal(await readFile(result.generatedFiles[0]!.absolutePath, 'utf8'), 'fake png payload');
  } finally {
    await runner.stop();
    await cleanupDir(rootDir);
  }
});

test('app-server runner records native imageGeneration saved paths from current Codex app-server items', async () => {
  const rootDir = await makeTempDir('codex-app-server-runner-image-generation-item-');
  const workspace = await createWorkspace(rootDir);
  const runner = new CodexAppServerRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);

  try {
    const result = await runner.start(
      binding,
      { prompt: '[app-image-generation-item] generate a native image', imagePaths: [], extraAddDirs: [] },
      undefined,
      undefined,
    ).done;

    assert.equal(result.success, true);
    assert.equal(result.generatedFiles?.length, 1);
    assert.match(result.generatedFiles![0]!.workspaceRelativePath, /^codex-generated-images\/image-turn-[a-z0-9]+\.png$/);
    assert.equal(await readFile(result.generatedFiles![0]!.absolutePath, 'utf8'), 'fake item png payload');
  } finally {
    await runner.stop();
    await cleanupDir(rootDir);
  }
});

test('app-server runner reports native context compact activity', async () => {
  const rootDir = await makeTempDir('codex-app-server-runner-compact-');
  const workspace = await createWorkspace(rootDir);
  const runner = new CodexAppServerRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);
  const activities: string[] = [];

  try {
    const result = await runner.start(
      binding,
      { prompt: '[app-compact] compact current thread', imagePaths: [], extraAddDirs: [] },
      undefined,
      {
        onActivity: async (activity) => {
          activities.push(activity);
        },
      },
    ).done;

    assert.equal(result.success, true);
    assert.ok(activities.includes('Codex 已压缩上下文'));
  } finally {
    await runner.stop();
    await cleanupDir(rootDir);
  }
});

test('app-server runner reports that a turn was submitted before the first stream event arrives', async () => {
  const rootDir = await makeTempDir('codex-app-server-runner-started-no-events-');
  const workspace = await createWorkspace(rootDir);
  const runner = new CodexAppServerRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);
  const activities: string[] = [];

  try {
    const job = runner.start(
      binding,
      { prompt: '[app-started-no-events] wait before events', imagePaths: [], extraAddDirs: [] },
      undefined,
      {
        onActivity: async (activity) => {
          activities.push(activity);
        },
      },
    );

    await waitFor(() => activities.includes('Codex 轮次已提交，等待模型响应'), 1_500);
    job.cancel();
    const result = await job.done;
    assert.equal(result.success, false);
  } finally {
    await runner.stop();
    await cleanupDir(rootDir);
  }
});

test('app-server runner releases a cancelled turn when interrupt never emits a terminal event', async () => {
  const rootDir = await makeTempDir('codex-app-server-runner-interrupt-timeout-');
  const workspace = await createWorkspace(rootDir);
  const runner = new CodexAppServerRunner(makeConfig(rootDir, fakeAppServerCommand, {
    codexAppServerTurnTimeoutMs: 5_000,
    codexAppServerInterruptTimeoutMs: 100,
  }));
  const binding = makeBinding(workspace);
  const activities: string[] = [];
  const timeoutSentinel = Symbol.for('timeout');

  try {
    const job = runner.start(
      binding,
      { prompt: '[app-ignore-interrupt] [app-started-no-events] wait before events', imagePaths: [], extraAddDirs: [] },
      undefined,
      {
        onActivity: async (activity) => {
          activities.push(activity);
        },
      },
    );

    await waitFor(() => activities.includes('Codex 轮次已提交，等待模型响应'), 1_500);
    job.cancel();
    const result = await Promise.race([
      job.done,
      new Promise((resolve) => setTimeout(() => resolve(timeoutSentinel), 700)),
    ]);

    assert.notEqual(result, timeoutSentinel);
    assert.equal((result as { success: boolean }).success, false);
    assert.match((result as { stderr: string[] }).stderr.join('\n'), /interrupt.*100ms|100ms.*interrupt/i);
  } finally {
    await runner.stop();
    await cleanupDir(rootDir);
  }
});

test('app-server runner times out a submitted turn that never emits a completion event', async () => {
  const rootDir = await makeTempDir('codex-app-server-runner-turn-timeout-');
  const workspace = await createWorkspace(rootDir);
  const runner = new CodexAppServerRunner(makeConfig(rootDir, fakeAppServerCommand, {
    codexAppServerTurnTimeoutMs: 100,
  }));
  const binding = makeBinding(workspace);

  try {
    const result = await runner.start(
      binding,
      { prompt: '[app-started-no-events] never completes', imagePaths: [], extraAddDirs: [] },
      undefined,
      undefined,
    ).done;

    assert.equal(result.success, false);
    assert.equal(result.turnCompleted, false);
    assert.match(result.stderr.join('\n'), /app-server turn .* timed out after 100ms without a completion event/);
  } finally {
    await runner.stop();
    await cleanupDir(rootDir);
  }
});
