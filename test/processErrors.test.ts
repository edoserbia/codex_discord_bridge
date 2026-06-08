import test from 'node:test';
import assert from 'node:assert/strict';

import { isKnownDiscordWebSocketNetworkError } from '../src/processErrors.js';
import { createBridgeTestRig } from './helpers/bridgeSetup.js';
import { cleanupDir, makeTempDir } from './helpers/testUtils.js';

test('classifies Discord websocket handshake timeouts as suppressible process errors', () => {
  const error = new Error('Opening handshake has timed out');
  error.stack = [
    'Error: Opening handshake has timed out',
    '    at ClientRequest.<anonymous> (/app/node_modules/ws/lib/websocket.js:878:7)',
    '    at WebSocketShard.internalConnect (/app/node_modules/@discordjs/ws/dist/index.js:677:24)',
  ].join('\n');

  assert.equal(isKnownDiscordWebSocketNetworkError(error), true);
});

test('classifies production ws handshake timeout stacks as suppressible process errors', () => {
  const error = new Error('Opening handshake has timed out');
  error.stack = [
    'Error: Opening handshake has timed out',
    '    at ClientRequest.<anonymous> (/Users/mac/work/su/codex-discord-bridge/node_modules/ws/lib/websocket.js:878:7)',
    '    at ClientRequest.emit (node:events:519:28)',
    '    at TLSSocket.emitRequestTimeout (node:_http_client:919:9)',
    '    at Object.onceWrapper (node:events:633:28)',
    '    at Socket._onTimeout (node:net:604:8)',
  ].join('\n');

  assert.equal(isKnownDiscordWebSocketNetworkError(error), true);
});

test('classifies Discord websocket socket hang ups as suppressible process errors', () => {
  const error = new Error('socket hang up');
  error.stack = [
    'Error: socket hang up',
    '    at emitErrorAndClose (/app/node_modules/ws/lib/websocket.js:1046:13)',
    '    at WebSocketShard.onError (/app/node_modules/@discordjs/ws/dist/index.js:1066:10)',
  ].join('\n');

  assert.equal(isKnownDiscordWebSocketNetworkError(error), true);
});

test('does not suppress unrelated programmer exceptions', () => {
  const error = new TypeError('Cannot read properties of undefined');
  error.stack = [
    'TypeError: Cannot read properties of undefined',
    '    at processTask (/app/dist/discordBot.js:123:4)',
  ].join('\n');

  assert.equal(isKnownDiscordWebSocketNetworkError(error), false);
});

test('bridge registers Discord shard error handlers so gateway network errors are logged', async () => {
  const rootDir = await makeTempDir('codex-bridge-process-errors-');
  const { bridge } = await createBridgeTestRig({ rootDir });
  const client = (bridge as any).client as NodeJS.EventEmitter;

  try {
    assert.ok(client.listenerCount('shardError') > 0);
    assert.doesNotThrow(() => {
      client.emit('shardError', new Error('Opening handshake has timed out'), 0);
    });
  } finally {
    await (bridge as any).stop?.();
    await cleanupDir(rootDir);
  }
});
