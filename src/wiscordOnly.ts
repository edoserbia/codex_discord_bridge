import path from 'node:path';

import { loadConfig } from './config.js';
import { createCodexExecutionDriver } from './createCodexExecutionDriver.js';
import { JsonStateStore } from './store.js';
import { WiscordCodexBridge } from './wiscordBridge.js';

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.wiscord) throw new Error('Wiscord transport is not configured');

  const store = new JsonStateStore(path.join(config.dataDir, 'state.json'));
  await store.load();
  const bridge = new WiscordCodexBridge(config, store, createCodexExecutionDriver(config));
  await bridge.start();
  // The transport intentionally unrefs heartbeat/retry timers, so keep the daemon alive between Gateway events.
  const keepAlive = setInterval(() => undefined, 60_000);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(keepAlive);
    void bridge.stop().finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
