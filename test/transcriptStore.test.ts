import test from 'node:test';
import assert from 'node:assert/strict';

import { TranscriptStore } from '../src/transcriptStore.js';

import { cleanupDir, makeTempDir } from './helpers/testUtils.js';

test('transcript store appends and reads events in order', async () => {
  const rootDir = await makeTempDir('codex-bridge-transcript-store-');
  const store = new TranscriptStore(rootDir);

  try {
    const first = await store.appendEvent('conversation-1', {
      codexThreadId: 'thread-123',
      role: 'user',
      source: 'discord',
      content: 'hello from discord',
    });
    const second = await store.appendEvent('conversation-1', {
      codexThreadId: 'thread-123',
      role: 'assistant',
      source: 'local-resume',
      content: 'hello from assistant',
    });

    const events = await store.listEvents('conversation-1');

    assert.equal(events.length, 2);
    assert.equal(events[0]?.id, first.id);
    assert.equal(events[0]?.role, 'user');
    assert.equal(events[0]?.source, 'discord');
    assert.equal(events[0]?.content, 'hello from discord');
    assert.equal(events[1]?.id, second.id);
    assert.equal(events[1]?.role, 'assistant');
    assert.equal(events[1]?.source, 'local-resume');
    assert.equal(events[1]?.content, 'hello from assistant');
  } finally {
    await cleanupDir(rootDir);
  }
});
