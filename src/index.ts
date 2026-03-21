import path from 'node:path';

import { createCodexExecutionDriver } from './createCodexExecutionDriver.js';
import { loadConfig } from './config.js';
import { DiscordCodexBridge } from './discordBot.js';
import { JsonStateStore } from './store.js';
import { AdminWebServer } from './webServer.js';

process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection', reason);
});

process.on('uncaughtExceptionMonitor', (error) => {
  console.error('[process] uncaughtException', error);
});

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new JsonStateStore(path.join(config.dataDir, 'state.json'));
  await store.load();

  console.log(`Loaded ${store.listBindings().length} persisted channel binding(s).`);

  const runner = createCodexExecutionDriver(config);
  const bridge = new DiscordCodexBridge(config, store, runner);
  const webServer = new AdminWebServer(config, bridge);

  await bridge.start();
  await webServer.start();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
