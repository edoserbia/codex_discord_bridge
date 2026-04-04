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

test('runner does not forward bridge-managed proxy env vars into codex child processes', async () => {
  const rootDir = await makeTempDir('codex-runner-proxy-env-');
  const workspace = await createWorkspace(rootDir);
  const logDir = path.join(rootDir, 'fake-codex-logs');
  const previousEnv = {
    FAKE_CODEX_LOG_DIR: process.env.FAKE_CODEX_LOG_DIR,
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    ALL_PROXY: process.env.ALL_PROXY,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    all_proxy: process.env.all_proxy,
    CODEX_TUNNING_DISCORD_PROXY_INJECTED: process.env.CODEX_TUNNING_DISCORD_PROXY_INJECTED,
    CODEX_TUNNING_DISCORD_PROXY_INJECTED_KEYS: process.env.CODEX_TUNNING_DISCORD_PROXY_INJECTED_KEYS,
  };

  process.env.FAKE_CODEX_LOG_DIR = logDir;
  process.env.HTTP_PROXY = 'http://127.0.0.1:7890';
  process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
  process.env.ALL_PROXY = 'socks5://127.0.0.1:7891';
  process.env.http_proxy = 'http://127.0.0.1:7890';
  process.env.https_proxy = 'http://127.0.0.1:7890';
  process.env.all_proxy = 'socks5://127.0.0.1:7891';
  process.env.CODEX_TUNNING_DISCORD_PROXY_INJECTED = '1';
  process.env.CODEX_TUNNING_DISCORD_PROXY_INJECTED_KEYS = 'HTTP_PROXY,HTTPS_PROXY,http_proxy,https_proxy';

  try {
    const runner = new CodexRunner(makeConfig(rootDir));
    const binding = makeBinding(workspace);
    const result = await runner.start(binding, { prompt: 'proxy isolation check', imagePaths: [], extraAddDirs: [] }, undefined).done;

    assert.equal(result.success, true);

    const logFiles = await readdir(logDir);
    assert.ok(logFiles.length > 0);
    const payload = JSON.parse(await readFile(path.join(logDir, logFiles.sort().at(-1)!), 'utf8')) as {
      env: Record<string, string | undefined>;
    };

    assert.equal(payload.env.CODEX_TUNNING_DISCORD_PROXY_INJECTED, '1');
    assert.equal(payload.env.HTTP_PROXY, undefined);
    assert.equal(payload.env.HTTPS_PROXY, undefined);
    assert.equal(payload.env.ALL_PROXY, 'socks5://127.0.0.1:7891');
    assert.equal(payload.env.http_proxy, undefined);
    assert.equal(payload.env.https_proxy, undefined);
    assert.equal(payload.env.all_proxy, 'socks5://127.0.0.1:7891');
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await cleanupDir(rootDir);
  }
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

test('runner treats completed todo status fields as checked plan items', async () => {
  const rootDir = await makeTempDir('codex-runner-plan-status-');
  const workspace = await createWorkspace(rootDir);
  const runner = new CodexRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);
  const planSnapshots: Array<Array<{ text: string; completed: boolean }>> = [];

  const result = await runner.start(binding, { prompt: '[plan-status] inspect', imagePaths: [], extraAddDirs: [] }, undefined, {
    onTodoListChanged: async (items) => { planSnapshots.push(items.map((item) => ({ ...item }))); },
  }).done;

  assert.equal(result.success, true);
  assert.ok(planSnapshots.length >= 2);
  assert.equal(planSnapshots[0]?.[0]?.completed, true);
  assert.equal(planSnapshots.at(-1)?.every((item) => item.completed), true);
  await cleanupDir(rootDir);
});

test('runner preserves plan text across todo updates that only change status fields', async () => {
  const rootDir = await makeTempDir('codex-runner-plan-live-');
  const workspace = await createWorkspace(rootDir);
  const runner = new CodexRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);
  const planSnapshots: Array<Array<{ id?: string; text: string; completed: boolean }>> = [];

  const result = await runner.start(binding, { prompt: '[plan-live] inspect', imagePaths: [], extraAddDirs: [] }, undefined, {
    onTodoListChanged: async (items) => { planSnapshots.push(items.map((item) => ({ ...item }))); },
  }).done;

  assert.equal(result.success, true);
  assert.ok(planSnapshots.length >= 2);
  assert.deepEqual(
    planSnapshots[0]?.map((item) => item.text),
    ['Inspect files', 'Patch code', 'Run tests'],
  );
  assert.equal(planSnapshots[0]?.[1]?.completed, false);
  assert.equal(planSnapshots.at(-1)?.every((item) => item.completed), true);
  assert.deepEqual(
    planSnapshots.at(-1)?.map((item) => item.text),
    ['Inspect files', 'Patch code', 'Run tests'],
  );
  await cleanupDir(rootDir);
});

test('runner enables multi_agent by default for bridge-launched Codex runs', async () => {
  const rootDir = await makeTempDir('codex-runner-multi-agent-default-');
  const workspace = await createWorkspace(rootDir);
  const logDir = path.join(rootDir, 'fake-codex-logs');
  process.env.FAKE_CODEX_LOG_DIR = logDir;

  const runner = new CodexRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);

  try {
    const result = await runner.start(binding, { prompt: 'hello subagents', imagePaths: [], extraAddDirs: [] }, undefined).done;
    assert.equal(result.success, true);

    const logFiles = await readdir(logDir);
    const payload = JSON.parse(await readFile(path.join(logDir, logFiles.sort().at(-1)!), 'utf8')) as {
      args: { configs: string[] };
    };

    assert.ok(payload.args.configs.includes('features.multi_agent=true'));
  } finally {
    delete process.env.FAKE_CODEX_LOG_DIR;
    await cleanupDir(rootDir);
  }
});

test('runner respects explicit multi_agent overrides instead of forcing them on', async () => {
  const rootDir = await makeTempDir('codex-runner-multi-agent-override-');
  const workspace = await createWorkspace(rootDir);
  const logDir = path.join(rootDir, 'fake-codex-logs');
  process.env.FAKE_CODEX_LOG_DIR = logDir;

  const runner = new CodexRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);
  binding.codex.extraConfig = ['features.multi_agent=false'];

  try {
    const result = await runner.start(binding, { prompt: 'hello no subagents', imagePaths: [], extraAddDirs: [] }, undefined).done;
    assert.equal(result.success, true);

    const logFiles = await readdir(logDir);
    const payload = JSON.parse(await readFile(path.join(logDir, logFiles.sort().at(-1)!), 'utf8')) as {
      args: { configs: string[] };
    };

    assert.ok(payload.args.configs.includes('features.multi_agent=false'));
    assert.ok(!payload.args.configs.includes('features.multi_agent=true'));
  } finally {
    delete process.env.FAKE_CODEX_LOG_DIR;
    await cleanupDir(rootDir);
  }
});

test('runner surfaces collab tool call updates for subagent activity', async () => {
  const rootDir = await makeTempDir('codex-runner-subagent-');
  const workspace = await createWorkspace(rootDir);
  const runner = new CodexRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);
  const collabSnapshots: Array<{
    id: string;
    tool: string;
    status: string;
    receiverThreadIds: string[];
    prompt?: string;
    agentsStates: Record<string, { status: string; message?: string | null }>;
  }> = [];

  const result = await runner.start(binding, { prompt: '[subagent] inspect', imagePaths: [], extraAddDirs: [] }, undefined, {
    onCollabToolChanged: async (item) => {
      collabSnapshots.push(JSON.parse(JSON.stringify(item)) as {
        id: string;
        tool: string;
        status: string;
        receiverThreadIds: string[];
        prompt?: string;
        agentsStates: Record<string, { status: string; message?: string | null }>;
      });
    },
  }).done;

  assert.equal(result.success, true);
  assert.ok(collabSnapshots.some((item) => item.tool === 'spawn_agent' && item.status === 'in_progress'));
  assert.ok(collabSnapshots.some((item) => item.tool === 'spawn_agent' && item.status === 'completed'));
  assert.ok(collabSnapshots.some((item) => item.tool === 'wait' && item.status === 'completed'));
  assert.equal(collabSnapshots.find((item) => item.tool === 'wait' && item.status === 'completed')?.agentsStates['sub-thread-1']?.status, 'completed');
  assert.match(collabSnapshots.find((item) => item.tool === 'send_input')?.prompt ?? '', /auth redirects/);
  await cleanupDir(rootDir);
});

test('runner preserves subagent nicknames when collab events provide them', async () => {
  const rootDir = await makeTempDir('codex-runner-subagent-nickname-');
  const workspace = await createWorkspace(rootDir);
  const runner = new CodexRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);
  const collabSnapshots: Array<{
    tool: string;
    status: string;
    receiverThreadIds: string[];
    agentsStates: Record<string, { status: string; nickname?: string | null; message?: string | null }>;
  }> = [];

  const result = await runner.start(binding, { prompt: '[subagent] inspect', imagePaths: [], extraAddDirs: [] }, undefined, {
    onCollabToolChanged: async (item) => {
      collabSnapshots.push(JSON.parse(JSON.stringify(item)) as {
        tool: string;
        status: string;
        receiverThreadIds: string[];
        agentsStates: Record<string, { status: string; nickname?: string | null; message?: string | null }>;
      });
    },
  }).done;

  assert.equal(result.success, true);
  const spawnCompleted = collabSnapshots.find((item) => item.tool === 'spawn_agent' && item.status === 'completed');
  const waitCompleted = collabSnapshots.find((item) => item.tool === 'wait' && item.status === 'completed');
  assert.equal(spawnCompleted?.agentsStates['sub-thread-1']?.nickname, 'auth-scout');
  assert.equal(waitCompleted?.agentsStates['sub-thread-1']?.nickname, 'auth-scout');
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

test('runner surfaces structured Codex failure events as diagnostics', async () => {
  const rootDir = await makeTempDir('codex-runner-json-fail-');
  const workspace = await createWorkspace(rootDir);
  const runner = new CodexRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);

  const result = await runner.start(binding, { prompt: '[json-transient] run', imagePaths: [], extraAddDirs: [] }, undefined).done;

  assert.equal(result.success, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr.join('\n'), /Codex turn failed: stream disconnected before completion/);
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
