import path from 'node:path';

import type { AppConfig } from '../../src/config.js';
import type { CodexExecutionDriver } from '../../src/codexRunner.js';

import { createCodexExecutionDriver } from '../../src/createCodexExecutionDriver.js';
import { DiscordCodexBridge } from '../../src/discordBot.js';
import { JsonStateStore } from '../../src/store.js';

import { FakeChannel } from './fakeDiscord.js';

class FakeChannelRegistry extends Map<string, FakeChannel> {
  override set(key: string, value: FakeChannel): this {
    value.attachRegistry(this);
    return super.set(key, value);
  }
}

export async function createBridgeTestRig(options: {
  rootDir: string;
  codexCommand?: string;
  driverMode?: 'legacy-exec' | 'app-server';
  webEnabled?: boolean;
  webPort?: number;
  webAuthToken?: string;
}): Promise<{
  config: AppConfig;
  store: JsonStateStore;
  runner: CodexExecutionDriver;
  bridge: DiscordCodexBridge;
  channels: Map<string, FakeChannel>;
}> {
  const config: AppConfig = {
    discordToken: 'test-token',
    commandPrefix: '!',
    dataDir: path.join(options.rootDir, 'data'),
    codexCommand: options.codexCommand ?? 'codex',
    codexDriverMode: options.driverMode ?? 'legacy-exec',
    allowedWorkspaceRoots: [options.rootDir],
    adminUserIds: new Set(['admin-user']),
    defaultCodex: {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      search: false,
      skipGitRepoCheck: true,
      addDirs: [],
      extraConfig: [],
    },
    web: {
      enabled: options.webEnabled ?? false,
      bind: '127.0.0.1',
      port: options.webPort ?? 0,
      authToken: options.webAuthToken,
    },
  };

  const store = new JsonStateStore(path.join(config.dataDir, 'state.json'));
  await store.load();

  const runner = createCodexExecutionDriver(config);
  const bridge = new DiscordCodexBridge(config, store, runner);
  const channels = new FakeChannelRegistry();

  (bridge as any).client.channels.fetch = async (channelId: string) => channels.get(channelId) ?? null;
  (bridge as any).client.login = async () => 'logged-in';

  return { config, store, runner, bridge, channels };
}
