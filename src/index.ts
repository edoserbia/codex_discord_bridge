import path from 'node:path';

import { loadConfig } from './config.js';
import { CodexRunner } from './codexRunner.js';
import { DiscordCodexBridge } from './discordBot.js';
import { JsonStateStore } from './store.js';
import { AdminWebServer } from './webServer.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new JsonStateStore(path.join(config.dataDir, 'state.json'));
  await store.load();

  console.log(`Loaded ${store.listBindings().length} persisted channel binding(s).`);

  const runner = new CodexRunner(config);
  const bridge = new DiscordCodexBridge(config, store, runner);
  const webServer = new AdminWebServer(config, bridge);

  await bridge.start();
  await webServer.start();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
