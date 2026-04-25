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
  codexConfigPath?: string;
  driverMode?: 'legacy-exec' | 'app-server';
  appServerStartupTimeoutMs?: number;
  codexMaxAttempts?: number;
  codexRateLimitMaxAttempts?: number;
  codexRateLimitBaseDelayMs?: number;
  codexRateLimitMaxDelayMs?: number;
  webEnabled?: boolean;
  webPort?: number;
  webBind?: string;
  webAuthToken?: string;
}): Promise<{
  config: AppConfig;
  store: JsonStateStore;
  runner: CodexExecutionDriver;
  bridge: DiscordCodexBridge;
  channels: Map<string, FakeChannel>;
}> {
  const config = {
    discordToken: 'test-token',
    commandPrefix: '!',
    dataDir: path.join(options.rootDir, 'data'),
    codexConfigPath: options.codexConfigPath ?? path.join(options.rootDir, '.codex', 'config.toml'),
    codexCommand: options.codexCommand ?? 'codex',
    codexDriverMode: options.driverMode ?? 'legacy-exec',
    codexAppServerStartupTimeoutMs: options.appServerStartupTimeoutMs,
    codexMaxAttempts: options.codexMaxAttempts ?? 10,
    codexRateLimitMaxAttempts: options.codexRateLimitMaxAttempts ?? 0,
    codexRateLimitBaseDelayMs: options.codexRateLimitBaseDelayMs ?? 5_000,
    codexRateLimitMaxDelayMs: options.codexRateLimitMaxDelayMs ?? 60_000,
    allowedWorkspaceRoots: [options.rootDir],
    adminUserIds: new Set(['admin-user']),
    defaultCodex: {
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      search: true,
      skipGitRepoCheck: true,
      addDirs: [],
      extraConfig: [],
    },
    web: {
      enabled: options.webEnabled ?? false,
      bind: options.webBind ?? '127.0.0.1',
      port: options.webPort ?? 0,
      authToken: options.webAuthToken,
    },
  } as AppConfig & {
    codexAppServerStartupTimeoutMs?: number;
    codexMaxAttempts?: number;
    codexRateLimitMaxAttempts?: number;
    codexRateLimitBaseDelayMs?: number;
    codexRateLimitMaxDelayMs?: number;
  };

  const store = new JsonStateStore(path.join(config.dataDir, 'state.json'));
  await store.load();

  const runner = createCodexExecutionDriver(config);
  const bridge = new DiscordCodexBridge(config, store, runner);
  const channels = new FakeChannelRegistry();

  (bridge as any).client.channels.fetch = async (channelId: string) => channels.get(channelId) ?? null;
  (bridge as any).client.login = async () => 'logged-in';

  return { config: config as AppConfig, store, runner, bridge, channels };
}
