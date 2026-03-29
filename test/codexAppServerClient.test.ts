import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readdir, readFile, realpath } from 'node:fs/promises';

import type { AppConfig } from '../src/config.js';
import type { ChannelBinding } from '../src/types.js';

import { CodexAppServerClient, resolveAppServerTransport } from '../src/codexAppServerClient.js';

import { cleanupDir, createWorkspace, makeTempDir, waitFor } from './helpers/testUtils.js';

const fakeAppServerCommand = path.resolve('test/fixtures/fake-codex-app-server.mjs');
const hangingAppServerCommand = path.resolve('test/fixtures/fake-codex-app-server-initialize-hang.mjs');
const fakeWsAppServerCommand = path.resolve('test/fixtures/fake-codex-app-server-ws.mjs');
const fakeWsStartupTimeoutMs = 2_000;

function makeConfig(rootDir: string, codexCommand = fakeAppServerCommand): AppConfig {
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

test('app-server client can start a thread and stream turn updates', async () => {
  const rootDir = await makeTempDir('codex-app-server-client-start-');
  const workspace = await createWorkspace(rootDir);
  const binding = makeBinding(workspace);
  const client = new CodexAppServerClient(makeConfig(rootDir));
  const events: string[] = [];
  const planSnapshots: Array<Array<{ step: string; status: string }>> = [];
  const outputDeltas: string[] = [];

  try {
    await client.start();
    const threadId = await client.ensureThread(binding, undefined);
    assert.ok(threadId);

    const turn = await client.startTurn(binding, threadId, {
      prompt: '[app-plan] inspect',
      imagePaths: [],
      extraAddDirs: [],
      onEvent: async (event) => {
        events.push(event.type);
        if (event.type === 'plan.updated') {
          planSnapshots.push(event.plan.map((item) => ({ ...item })));
        }
        if (event.type === 'command.output.delta') {
          outputDeltas.push(event.delta);
        }
      },
    });

    const result = await turn.done;
    assert.equal(result.success, true);
    assert.equal(result.threadId, threadId);
    assert.ok(events.includes('turn.started'));
    assert.ok(events.includes('turn.completed'));
    assert.ok(planSnapshots.length >= 1);
    assert.match(outputDeltas.join('\n'), /pwd/);
  } finally {
    await client.stop();
    await cleanupDir(rootDir);
  }
});

test('app-server client can steer and interrupt an active turn on the same thread', async () => {
  const rootDir = await makeTempDir('codex-app-server-client-steer-');
  const workspace = await createWorkspace(rootDir);
  const binding = makeBinding(workspace);
  const client = new CodexAppServerClient(makeConfig(rootDir));
  const events: string[] = [];

  try {
    await client.start();
    const threadId = await client.ensureThread(binding, undefined);
    const turn = await client.startTurn(binding, threadId, {
      prompt: '[app-slow] first task',
      imagePaths: [],
      extraAddDirs: [],
      onEvent: async (event) => {
        events.push(event.type);
      },
    });

    await waitFor(() => events.includes('turn.started'), 15_000);
    await client.steerTurn(threadId, turn.turnId, '现在先检查 README');
    await client.interruptTurn(threadId, turn.turnId);

    const result = await turn.done;
    assert.equal(result.success, false);
    assert.ok(events.includes('turn.steered'));
    assert.ok(events.includes('turn.interrupted'));
  } finally {
    await client.stop();
    await cleanupDir(rootDir);
  }
});

test('app-server client rejects an active turn when the server exits unexpectedly', async () => {
  const rootDir = await makeTempDir('codex-app-server-client-crash-');
  const workspace = await createWorkspace(rootDir);
  const binding = makeBinding(workspace);
  const client = new CodexAppServerClient(makeConfig(rootDir));

  try {
    await client.start();
    const threadId = await client.ensureThread(binding, undefined);
    const turn = await client.startTurn(binding, threadId, {
      prompt: '[app-crash] simulate server death',
      imagePaths: [],
      extraAddDirs: [],
    });

    await assert.rejects(turn.done, /app-server exited|terminated|closed/i);
  } finally {
    await client.stop();
    await cleanupDir(rootDir);
  }
});

test('app-server client waits for earlier async event handlers before resolving turn completion', async () => {
  const rootDir = await makeTempDir('codex-app-server-client-ordered-events-');
  const workspace = await createWorkspace(rootDir);
  const binding = makeBinding(workspace);
  const client = new CodexAppServerClient(makeConfig(rootDir));
  const eventOrder: string[] = [];

  try {
    await client.start();
    const threadId = await client.ensureThread(binding, undefined);
    const turn = await client.startTurn(binding, threadId, {
      prompt: '[app-plan] ordered events',
      imagePaths: [],
      extraAddDirs: [],
      onEvent: async (event) => {
        if (event.type === 'plan.updated') {
          eventOrder.push('plan:start');
          await new Promise((resolve) => setTimeout(resolve, 80));
          eventOrder.push('plan:end');
          return;
        }

        if (event.type === 'turn.completed') {
          eventOrder.push('turn:completed');
        }
      },
    });

    eventOrder.push('await:done');
    await turn.done;
    eventOrder.push('done');

    assert.ok(eventOrder.includes('plan:end'));
    assert.ok(eventOrder.includes('turn:completed'));
    assert.ok(eventOrder.indexOf('done') > eventOrder.indexOf('plan:end'));
  } finally {
    await client.stop();
    await cleanupDir(rootDir);
  }
});

test('app-server client resolves buffered interrupted terminal notifications correctly', async () => {
  const rootDir = await makeTempDir('codex-app-server-client-buffered-interrupt-');
  const workspace = await createWorkspace(rootDir);
  const binding = makeBinding(workspace);
  const client = new CodexAppServerClient(makeConfig(rootDir));

  try {
    await client.start();
    const threadId = await client.ensureThread(binding, undefined);
    const turn = await client.startTurn(binding, threadId, {
      prompt: '[app-buffered-interrupt] stop immediately',
      imagePaths: [],
      extraAddDirs: [],
    });

    const result = await Promise.race([
      turn.done,
      new Promise<symbol>((resolve) => {
        setTimeout(() => resolve(Symbol.for('timeout')), 500);
      }),
    ]);

    assert.notEqual(result, Symbol.for('timeout'));
    assert.equal((result as { success: boolean }).success, false);
    assert.equal((result as { interrupted: boolean }).interrupted, true);
  } finally {
    await client.stop();
    await cleanupDir(rootDir);
  }
});

test('app-server client preserves failure details from app-server error notifications', async () => {
  const rootDir = await makeTempDir('codex-app-server-client-failed-message-');
  const workspace = await createWorkspace(rootDir);
  const binding = makeBinding(workspace);
  const client = new CodexAppServerClient(makeConfig(rootDir));
  const failureMessages: string[] = [];

  try {
    await client.start();
    const threadId = await client.ensureThread(binding, undefined);
    const turn = await client.startTurn(binding, threadId, {
      prompt: '[app-failed-message] simulate 429 retry exhaustion',
      imagePaths: [],
      extraAddDirs: [],
      onEvent: async (event) => {
        const candidate = event as { type: string; message?: string };
        if (candidate.type === 'turn.failed' && candidate.message) {
          failureMessages.push(candidate.message);
        }
      },
    });

    const result = await turn.done;
    assert.equal(result.success, false);
    assert.deepEqual(failureMessages, ['exceeded retry limit, last status: 429 Too Many Requests']);
  } finally {
    await client.stop();
    await cleanupDir(rootDir);
  }
});

test('app-server client forwards per-thread config and writable roots to the official protocol', async () => {
  const rootDir = await makeTempDir('codex-app-server-client-config-');
  const workspace = await createWorkspace(rootDir);
  const extraDir = path.join(rootDir, 'extra-dir');
  const scratchDir = path.join(rootDir, 'scratch-dir');
  const logDir = path.join(rootDir, 'logs');
  const binding = makeBinding(workspace);
  binding.codex.model = 'gpt-5-codex';
  binding.codex.profile = 'reviewer';
  binding.codex.search = true;
  binding.codex.addDirs = [extraDir];
  binding.codex.extraConfig = ['features.multi_agent=false', 'tools.view_image=true'];
  const client = new CodexAppServerClient(makeConfig(rootDir));
  process.env.FAKE_CODEX_APP_SERVER_LOG_DIR = logDir;

  try {
    const threadId = await client.ensureThread(binding, undefined);
    const turn = await client.startTurn(binding, threadId, {
      prompt: 'verify protocol params',
      imagePaths: [],
      extraAddDirs: [scratchDir],
    });

    await turn.done;

    const files = await readdir(logDir);
    const payloads = await Promise.all(files.map(async (fileName) => JSON.parse(await readFile(path.join(logDir, fileName), 'utf8')) as {
      method: string;
      params: Record<string, any>;
    }));
    const threadStart = payloads.find((payload) => payload.method === 'thread/start');
    const turnStart = payloads.find((payload) => payload.method === 'turn/start');

    assert.ok(threadStart);
    assert.ok(turnStart);
    assert.equal(threadStart!.params.model, 'gpt-5-codex');
    assert.equal(threadStart!.params.approvalPolicy, 'never');
    assert.equal(threadStart!.params.config.profile, 'reviewer');
    assert.equal(threadStart!.params.config.web_search, 'live');
    assert.equal(threadStart!.params.config.features.multi_agent, false);
    assert.equal(threadStart!.params.config.tools.view_image, true);
    assert.equal(turnStart!.params.cwd, workspace);
    assert.equal(turnStart!.params.approvalPolicy, 'never');
    assert.equal(turnStart!.params.sandboxPolicy.type, 'workspaceWrite');
    assert.deepEqual(
      [...turnStart!.params.sandboxPolicy.writableRoots].sort(),
      [extraDir, scratchDir, workspace].sort(),
    );
  } finally {
    delete process.env.FAKE_CODEX_APP_SERVER_LOG_DIR;
    await client.stop();
    await cleanupDir(rootDir);
  }
});

test('app-server client forwards local full-access mode and search using the same binding options', async () => {
  const rootDir = await makeTempDir('codex-app-server-client-danger-full-access-');
  const workspace = await createWorkspace(rootDir);
  const logDir = path.join(rootDir, 'logs');
  const binding = makeBinding(workspace);
  binding.codex.sandboxMode = 'danger-full-access';
  binding.codex.approvalPolicy = 'never';
  binding.codex.search = true;
  const client = new CodexAppServerClient(makeConfig(rootDir));
  process.env.FAKE_CODEX_APP_SERVER_LOG_DIR = logDir;

  try {
    const threadId = await client.ensureThread(binding, undefined);
    const turn = await client.startTurn(binding, threadId, {
      prompt: 'verify local full-access defaults',
      imagePaths: [],
      extraAddDirs: [],
    });

    await turn.done;

    const files = await readdir(logDir);
    const payloads = await Promise.all(files.map(async (fileName) => JSON.parse(await readFile(path.join(logDir, fileName), 'utf8')) as {
      method: string;
      params: Record<string, any>;
    }));
    const threadStart = payloads.find((payload) => payload.method === 'thread/start');
    const turnStart = payloads.find((payload) => payload.method === 'turn/start');

    assert.ok(threadStart);
    assert.ok(turnStart);
    assert.equal(threadStart!.params.approvalPolicy, 'never');
    assert.equal(threadStart!.params.sandbox, 'danger-full-access');
    assert.equal(threadStart!.params.config.web_search, 'live');
    assert.equal(turnStart!.params.approvalPolicy, 'never');
    assert.equal(turnStart!.params.sandboxPolicy.type, 'dangerFullAccess');
  } finally {
    delete process.env.FAKE_CODEX_APP_SERVER_LOG_DIR;
    await client.stop();
    await cleanupDir(rootDir);
  }
});

test('app-server client serializes concurrent startup through a single initialize handshake', async () => {
  const rootDir = await makeTempDir('codex-app-server-client-concurrent-start-');
  const workspace = await createWorkspace(rootDir);
  const binding = makeBinding(workspace);
  const logDir = path.join(rootDir, 'logs');
  const client = new CodexAppServerClient(makeConfig(rootDir));
  process.env.FAKE_CODEX_APP_SERVER_LOG_DIR = logDir;
  process.env.FAKE_CODEX_APP_SERVER_INITIALIZE_DELAY_MS = '120';

  try {
    const [threadIdA, threadIdB] = await Promise.all([
      client.ensureThread(binding, undefined),
      client.ensureThread(binding, undefined),
    ]);

    assert.ok(threadIdA);
    assert.ok(threadIdB);

    const files = await readdir(logDir);
    const payloads = await Promise.all(files.map(async (fileName) => JSON.parse(await readFile(path.join(logDir, fileName), 'utf8')) as {
      method: string;
    }));
    assert.equal(payloads.filter((payload) => payload.method === 'initialize').length, 1);
  } finally {
    delete process.env.FAKE_CODEX_APP_SERVER_LOG_DIR;
    delete process.env.FAKE_CODEX_APP_SERVER_INITIALIZE_DELAY_MS;
    await client.stop();
    await cleanupDir(rootDir);
  }
});

test('app-server client supports the real stdio newline-delimited JSON transport', async () => {
  const rootDir = await makeTempDir('codex-app-server-client-ndjson-stdio-');
  const workspace = await createWorkspace(rootDir);
  const binding = makeBinding(workspace);
  const client = new CodexAppServerClient(makeConfig(rootDir));
  process.env.FAKE_CODEX_APP_SERVER_STDIN_PROTOCOL = 'ndjson';
  process.env.FAKE_CODEX_APP_SERVER_STDOUT_PROTOCOL = 'ndjson';

  try {
    const threadId = await client.ensureThread(binding, undefined);
    assert.ok(threadId);
  } finally {
    delete process.env.FAKE_CODEX_APP_SERVER_STDIN_PROTOCOL;
    delete process.env.FAKE_CODEX_APP_SERVER_STDOUT_PROTOCOL;
    await client.stop();
    await cleanupDir(rootDir);
  }
});

test('app-server client starts the child process from the bound workspace context', async () => {
  const rootDir = await makeTempDir('codex-app-server-client-startup-context-');
  const workspace = await createWorkspace(rootDir);
  const realWorkspace = await realpath(workspace);
  const binding = makeBinding(workspace);
  const logDir = path.join(rootDir, 'logs');
  const client = new CodexAppServerClient(makeConfig(rootDir));
  process.env.FAKE_CODEX_APP_SERVER_LOG_DIR = logDir;

  try {
    await client.ensureThread(binding, undefined);

    const files = await readdir(logDir);
    const payloads = await Promise.all(files.map(async (fileName) => JSON.parse(await readFile(path.join(logDir, fileName), 'utf8')) as {
      method: string;
      cwd?: string;
      env?: {
        PWD?: string;
      };
    }));
    const startup = payloads.find((payload) => payload.method === '$startup');

    assert.ok(startup);
    assert.equal(startup.cwd, realWorkspace);
    assert.equal(startup.env?.PWD, workspace);
  } finally {
    delete process.env.FAKE_CODEX_APP_SERVER_LOG_DIR;
    await client.stop();
    await cleanupDir(rootDir);
  }
});

test('app-server client rejects initialize hangs instead of staying pending forever', async () => {
  const rootDir = await makeTempDir('codex-app-server-client-initialize-timeout-');
  const workspace = await createWorkspace(rootDir);
  const binding = makeBinding(workspace);
  const config = makeConfig(rootDir, hangingAppServerCommand) as AppConfig & {
    codexAppServerStartupTimeoutMs?: number;
  };
  config.codexAppServerStartupTimeoutMs = 200;
  const client = new CodexAppServerClient(config as AppConfig);
  const timeoutSentinel = Symbol.for('timeout');

  try {
    const result = await Promise.race([
      client.ensureThread(binding, undefined).then(
        () => Symbol.for('resolved'),
        (error) => error,
      ),
      new Promise<symbol>((resolve) => {
        setTimeout(() => resolve(timeoutSentinel), 1_500);
      }),
    ]);

    assert.notEqual(result, timeoutSentinel);
    assert.notEqual(result, Symbol.for('resolved'));
    assert.ok(result instanceof Error);
    assert.match(result.message, /initialize|timeout|timed out/i);
  } finally {
    await client.stop();
    await cleanupDir(rootDir);
  }
});

test('app-server client can use websocket transport when configured', async () => {
  const rootDir = await makeTempDir('codex-app-server-client-ws-transport-');
  const workspace = await createWorkspace(rootDir);
  const binding = makeBinding(workspace);
  const config = makeConfig(rootDir, fakeWsAppServerCommand) as AppConfig & {
    codexAppServerTransport?: 'ws';
    codexAppServerStartupTimeoutMs?: number;
  };
  config.codexAppServerTransport = 'ws';
  config.codexAppServerStartupTimeoutMs = fakeWsStartupTimeoutMs;
  const client = new CodexAppServerClient(config as AppConfig);
  const events: string[] = [];

  try {
    await client.start();
    const threadId = await client.ensureThread(binding, undefined);
    const turn = await client.startTurn(binding, threadId, {
      prompt: '[app-plan] inspect over ws',
      imagePaths: [],
      extraAddDirs: [],
      onEvent: async (event) => {
        events.push(event.type);
      },
    });

    const result = await turn.done;
    assert.equal(result.success, true);
    assert.equal(result.threadId, threadId);
    assert.ok(events.includes('turn.started'));
    assert.ok(events.includes('plan.updated'));
    assert.ok(events.includes('turn.completed'));
  } finally {
    await client.stop();
    await cleanupDir(rootDir);
  }
});

test('app-server transport auto mode defaults to stdio for the real codex command', () => {
  assert.equal(resolveAppServerTransport(undefined, 'codex'), 'stdio');
  assert.equal(resolveAppServerTransport(undefined, '/usr/local/bin/codex'), 'stdio');
  assert.equal(resolveAppServerTransport(undefined, fakeAppServerCommand), 'stdio');
  assert.equal(resolveAppServerTransport('ws', 'codex'), 'ws');
});

test('app-server client preserves recent child stderr when websocket transport closes unexpectedly', async () => {
  const rootDir = await makeTempDir('codex-app-server-client-ws-close-');
  const workspace = await createWorkspace(rootDir);
  const binding = makeBinding(workspace);
  const config = makeConfig(rootDir, fakeWsAppServerCommand) as AppConfig & {
    codexAppServerTransport?: 'ws';
    codexAppServerStartupTimeoutMs?: number;
  };
  config.codexAppServerTransport = 'ws';
  config.codexAppServerStartupTimeoutMs = fakeWsStartupTimeoutMs;
  const client = new CodexAppServerClient(config as AppConfig);

  try {
    const threadId = await client.ensureThread(binding, undefined);
    const turn = await client.startTurn(binding, threadId, {
      prompt: '[app-ws-close] crash after start',
      imagePaths: [],
      extraAddDirs: [],
    });

    await assert.rejects(turn.done, /simulated websocket app-server crash/i);
  } finally {
    await client.stop();
    await cleanupDir(rootDir);
  }
});
