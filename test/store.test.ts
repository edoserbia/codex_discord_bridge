import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, writeFile } from 'node:fs/promises';

import { JsonStateStore } from '../src/store.js';

import { cleanupDir, makeTempDir } from './helpers/testUtils.js';

test('store persists bindings and sessions and cascades deletes', async () => {
  const rootDir = await makeTempDir('codex-bridge-store-');
  const statePath = path.join(rootDir, 'state.json');
  const store = new JsonStateStore(statePath);
  await store.load();

  await store.upsertBinding({
    channelId: 'channel-1',
    guildId: 'guild-1',
    projectName: 'api',
    workspacePath: '/tmp/api',
    codex: {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      search: false,
      skipGitRepoCheck: true,
      addDirs: [],
      extraConfig: [],
    },
    createdAt: '2026-03-11T00:00:00.000Z',
    updatedAt: '2026-03-11T00:00:00.000Z',
  });

  await store.upsertAutopilotService({
    guildId: 'guild-1',
    enabled: true,
    parallelism: 2,
    updatedAt: '2026-03-11T00:00:00.000Z',
  });

  await store.upsertAutopilotProject({
    bindingChannelId: 'channel-1',
    guildId: 'guild-1',
    threadChannelId: 'thread-auto-1',
    enabled: true,
    intervalMs: 30 * 60 * 1000,
    brief: '优先补测试',
    briefUpdatedAt: '2026-03-11T00:00:00.000Z',
    board: [
      {
        id: 'task-1',
        title: '补测试',
        status: 'ready',
        updatedAt: '2026-03-11T00:00:00.000Z',
      },
    ],
    status: 'idle',
  });

  await store.ensureSession('channel-1', 'channel-1');
  await store.updateSession('thread-1', { codexThreadId: 'codex-thread-1' }, 'channel-1');

  assert.equal(store.listBindings().length, 1);
  assert.equal(store.listSessions('channel-1').length, 2);
  assert.equal(store.listAutopilotProjects('guild-1').length, 1);
  assert.equal(store.getAutopilotProject('channel-1')?.intervalMs, 30 * 60 * 1000);
  assert.equal(store.getAutopilotService('guild-1')?.parallelism, 2);

  const cleared = await store.clearAutopilotProject('channel-1');
  assert.equal(cleared?.enabled, true);
  assert.equal(cleared?.intervalMs, 30 * 60 * 1000);
  assert.deepEqual(cleared?.board, []);

  const removed = await store.removeBinding('channel-1');
  assert.equal(removed?.projectName, 'api');
  assert.equal(store.listBindings().length, 0);
  assert.equal(store.listSessions('channel-1').length, 0);
  assert.equal(store.listAutopilotProjects('guild-1').length, 0);
  assert.equal(store.getAutopilotService('guild-1')?.enabled, true);
  assert.equal(store.getAutopilotService('guild-1')?.parallelism, 2);

  await cleanupDir(rootDir);
});

test('store migrates legacy persisted sessions without driver metadata', async () => {
  const rootDir = await makeTempDir('codex-bridge-store-migrate-');
  const statePath = path.join(rootDir, 'state.json');
  await writeFile(statePath, JSON.stringify({
    bindings: {},
    sessions: {
      'channel-legacy': {
        conversationId: 'channel-legacy',
        bindingChannelId: 'channel-legacy',
        codexThreadId: 'legacy-thread-1',
        updatedAt: '2026-03-21T00:00:00.000Z',
      },
      'channel-empty': {
        conversationId: 'channel-empty',
        bindingChannelId: 'channel-empty',
        updatedAt: '2026-03-21T00:00:00.000Z',
      },
    },
    autopilotServices: {},
    autopilotProjects: {},
  }, null, 2));

  const store = new JsonStateStore(statePath);
  await store.load();

  assert.equal(store.getSession('channel-legacy')?.driver, 'legacy-exec');
  assert.equal(store.getSession('channel-empty')?.driver, undefined);

  await cleanupDir(rootDir);
});

test('store drain waits for queued persistence before callers remove the data directory', async () => {
  const rootDir = await makeTempDir('codex-bridge-store-drain-');
  const statePath = path.join(rootDir, 'state.json');
  const store = new JsonStateStore(statePath);
  await store.load();

  await store.upsertRuntimeState({
    conversationId: 'channel-1',
    queue: [],
    pendingReplies: [],
    goal: {
      conversationId: 'channel-1',
      bindingChannelId: 'channel-1',
      objective: 'finish goal',
      status: 'active',
      createdAt: '2026-05-02T00:00:00.000Z',
      updatedAt: '2026-05-02T00:00:00.000Z',
    },
  });

  await store.drain();
  await access(statePath);
  await cleanupDir(rootDir);
});
