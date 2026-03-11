import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

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

  await store.ensureSession('channel-1', 'channel-1');
  await store.updateSession('thread-1', { codexThreadId: 'codex-thread-1' }, 'channel-1');

  assert.equal(store.listBindings().length, 1);
  assert.equal(store.listSessions('channel-1').length, 2);

  const removed = await store.removeBinding('channel-1');
  assert.equal(removed?.projectName, 'api');
  assert.equal(store.listBindings().length, 0);
  assert.equal(store.listSessions('channel-1').length, 0);

  await cleanupDir(rootDir);
});
