import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { loadConfig } from '../src/config.js';

import { cleanupDir, makeTempDir } from './helpers/testUtils.js';

test('loadConfig reads CODEX_TUNNING_DISCORD_BOT_TOKEN from external secrets file', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-config-');
  const secretFile = path.join(rootDir, 'secrets.env');
    await fs.writeFile(secretFile, 'CODEX_TUNNING_DISCORD_BOT_TOKEN="secret-token-from-file"\n', 'utf8');

  const previous = {
    CODEX_TUNNING_SECRETS_FILE: process.env.CODEX_TUNNING_SECRETS_FILE,
    CODEX_TUNNING_DISCORD_BOT_TOKEN: process.env.CODEX_TUNNING_DISCORD_BOT_TOKEN,
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    DATA_DIR: process.env.DATA_DIR,
    WEB_ENABLED: process.env.WEB_ENABLED,
  };

  delete process.env.CODEX_TUNNING_DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_TOKEN;
  process.env.CODEX_TUNNING_SECRETS_FILE = secretFile;
  process.env.DATA_DIR = rootDir;
  process.env.WEB_ENABLED = 'false';

  try {
    const config = loadConfig();
    assert.equal(config.discordToken, 'secret-token-from-file');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await cleanupDir(rootDir);
  }
});

test('loadConfig defaults to danger-full-access sandbox', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-config-default-sandbox-');
  const secretFile = path.join(rootDir, 'secrets.env');
  await fs.writeFile(secretFile, 'CODEX_TUNNING_DISCORD_BOT_TOKEN="secret-token-from-file"\n', 'utf8');

  const previous = {
    CODEX_TUNNING_SECRETS_FILE: process.env.CODEX_TUNNING_SECRETS_FILE,
    CODEX_TUNNING_DISCORD_BOT_TOKEN: process.env.CODEX_TUNNING_DISCORD_BOT_TOKEN,
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    DATA_DIR: process.env.DATA_DIR,
    WEB_ENABLED: process.env.WEB_ENABLED,
    DEFAULT_CODEX_SANDBOX: process.env.DEFAULT_CODEX_SANDBOX,
    DEFAULT_CODEX_APPROVAL: process.env.DEFAULT_CODEX_APPROVAL,
    DEFAULT_CODEX_SEARCH: process.env.DEFAULT_CODEX_SEARCH,
  };

  delete process.env.CODEX_TUNNING_DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_TOKEN;
  delete process.env.DEFAULT_CODEX_SANDBOX;
  delete process.env.DEFAULT_CODEX_APPROVAL;
  delete process.env.DEFAULT_CODEX_SEARCH;
  process.env.CODEX_TUNNING_SECRETS_FILE = secretFile;
  process.env.DATA_DIR = rootDir;
  process.env.WEB_ENABLED = 'false';

  try {
    const config = loadConfig();
    assert.equal(config.defaultCodex.sandboxMode, 'danger-full-access');
    assert.equal(config.defaultCodex.approvalPolicy, 'never');
    assert.equal(config.defaultCodex.search, true);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await cleanupDir(rootDir);
  }
});

test('loadConfig defaults to app-server driver mode', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-config-default-driver-');
  const secretFile = path.join(rootDir, 'secrets.env');
  await fs.writeFile(secretFile, 'CODEX_TUNNING_DISCORD_BOT_TOKEN="secret-token-from-file"\n', 'utf8');

  const previous = {
    CODEX_TUNNING_SECRETS_FILE: process.env.CODEX_TUNNING_SECRETS_FILE,
    CODEX_TUNNING_DISCORD_BOT_TOKEN: process.env.CODEX_TUNNING_DISCORD_BOT_TOKEN,
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    DATA_DIR: process.env.DATA_DIR,
    WEB_ENABLED: process.env.WEB_ENABLED,
    CODEX_DRIVER_MODE: process.env.CODEX_DRIVER_MODE,
  };

  delete process.env.CODEX_TUNNING_DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_TOKEN;
  delete process.env.CODEX_DRIVER_MODE;
  process.env.CODEX_TUNNING_SECRETS_FILE = secretFile;
  process.env.DATA_DIR = rootDir;
  process.env.WEB_ENABLED = 'false';

  try {
    const config = loadConfig();
    assert.equal(config.codexDriverMode, 'app-server');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await cleanupDir(rootDir);
  }
});

test('loadConfig exposes a finite app-server turn watchdog timeout', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-config-turn-timeout-');
  const secretFile = path.join(rootDir, 'secrets.env');
  await fs.writeFile(secretFile, 'CODEX_TUNNING_DISCORD_BOT_TOKEN="secret-token-from-file"\n', 'utf8');

  const previous = {
    CODEX_TUNNING_SECRETS_FILE: process.env.CODEX_TUNNING_SECRETS_FILE,
    CODEX_TUNNING_DISCORD_BOT_TOKEN: process.env.CODEX_TUNNING_DISCORD_BOT_TOKEN,
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    DATA_DIR: process.env.DATA_DIR,
    WEB_ENABLED: process.env.WEB_ENABLED,
    CODEX_APP_SERVER_TURN_TIMEOUT_MS: process.env.CODEX_APP_SERVER_TURN_TIMEOUT_MS,
  };

  delete process.env.CODEX_TUNNING_DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_TOKEN;
  process.env.CODEX_TUNNING_SECRETS_FILE = secretFile;
  process.env.DATA_DIR = rootDir;
  process.env.WEB_ENABLED = 'false';
  process.env.CODEX_APP_SERVER_TURN_TIMEOUT_MS = '12345';

  try {
    const config = loadConfig();
    assert.equal(config.codexAppServerTurnTimeoutMs, 12_345);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await cleanupDir(rootDir);
  }
});

test('loadConfig exposes a finite app-server interrupt watchdog timeout', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-config-interrupt-timeout-');
  const secretFile = path.join(rootDir, 'secrets.env');
  await fs.writeFile(secretFile, 'CODEX_TUNNING_DISCORD_BOT_TOKEN="secret-token-from-file"\n', 'utf8');

  const previous = {
    CODEX_TUNNING_SECRETS_FILE: process.env.CODEX_TUNNING_SECRETS_FILE,
    CODEX_TUNNING_DISCORD_BOT_TOKEN: process.env.CODEX_TUNNING_DISCORD_BOT_TOKEN,
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    DATA_DIR: process.env.DATA_DIR,
    WEB_ENABLED: process.env.WEB_ENABLED,
    CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS: process.env.CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS,
  };

  delete process.env.CODEX_TUNNING_DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_TOKEN;
  process.env.CODEX_TUNNING_SECRETS_FILE = secretFile;
  process.env.DATA_DIR = rootDir;
  process.env.WEB_ENABLED = 'false';
  process.env.CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS = '2345';

  try {
    const config = loadConfig();
    assert.equal(config.codexAppServerInterruptTimeoutMs, 2_345);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await cleanupDir(rootDir);
  }
});

test('loadConfig defaults web bind to lan-friendly 0.0.0.0', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-config-default-web-bind-');
  const secretFile = path.join(rootDir, 'secrets.env');
  await fs.writeFile(secretFile, 'CODEX_TUNNING_DISCORD_BOT_TOKEN="secret-token-from-file"\n', 'utf8');

  const previous = {
    CODEX_TUNNING_SECRETS_FILE: process.env.CODEX_TUNNING_SECRETS_FILE,
    CODEX_TUNNING_DISCORD_BOT_TOKEN: process.env.CODEX_TUNNING_DISCORD_BOT_TOKEN,
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    DATA_DIR: process.env.DATA_DIR,
    WEB_ENABLED: process.env.WEB_ENABLED,
    WEB_BIND: process.env.WEB_BIND,
  };

  delete process.env.CODEX_TUNNING_DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_TOKEN;
  delete process.env.WEB_BIND;
  process.env.CODEX_TUNNING_SECRETS_FILE = secretFile;
  process.env.DATA_DIR = rootDir;
  process.env.WEB_ENABLED = 'false';

  try {
    const config = loadConfig();
    assert.equal(config.web.bind, '0.0.0.0');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await cleanupDir(rootDir);
  }
});

test('loadConfig exposes a configurable Codex config path', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-config-codex-path-');
  const secretFile = path.join(rootDir, 'secrets.env');
  const codexConfigPath = path.join(rootDir, '.codex', 'config.toml');
  await fs.writeFile(secretFile, 'CODEX_TUNNING_DISCORD_BOT_TOKEN="secret-token-from-file"\n', 'utf8');

  const previous = {
    CODEX_TUNNING_SECRETS_FILE: process.env.CODEX_TUNNING_SECRETS_FILE,
    CODEX_TUNNING_DISCORD_BOT_TOKEN: process.env.CODEX_TUNNING_DISCORD_BOT_TOKEN,
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    DATA_DIR: process.env.DATA_DIR,
    WEB_ENABLED: process.env.WEB_ENABLED,
    CODEX_CONFIG_PATH: process.env.CODEX_CONFIG_PATH,
  };

  delete process.env.CODEX_TUNNING_DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_TOKEN;
  process.env.CODEX_TUNNING_SECRETS_FILE = secretFile;
  process.env.DATA_DIR = rootDir;
  process.env.WEB_ENABLED = 'false';
  process.env.CODEX_CONFIG_PATH = codexConfigPath;

  try {
    const config = loadConfig();
    assert.equal((config as any).codexConfigPath, codexConfigPath);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await cleanupDir(rootDir);
  }
});

test('loadConfig respects explicit CODEX_DRIVER_MODE override', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-config-driver-override-');
  const secretFile = path.join(rootDir, 'secrets.env');
  await fs.writeFile(secretFile, 'CODEX_TUNNING_DISCORD_BOT_TOKEN="secret-token-from-file"\n', 'utf8');

  const previous = {
    CODEX_TUNNING_SECRETS_FILE: process.env.CODEX_TUNNING_SECRETS_FILE,
    CODEX_TUNNING_DISCORD_BOT_TOKEN: process.env.CODEX_TUNNING_DISCORD_BOT_TOKEN,
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    DATA_DIR: process.env.DATA_DIR,
    WEB_ENABLED: process.env.WEB_ENABLED,
    CODEX_DRIVER_MODE: process.env.CODEX_DRIVER_MODE,
  };

  delete process.env.CODEX_TUNNING_DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_TOKEN;
  process.env.CODEX_TUNNING_SECRETS_FILE = secretFile;
  process.env.DATA_DIR = rootDir;
  process.env.WEB_ENABLED = 'false';
  process.env.CODEX_DRIVER_MODE = 'legacy-exec';

  try {
    const config = loadConfig();
    assert.equal(config.codexDriverMode, 'legacy-exec');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await cleanupDir(rootDir);
  }
});

test('loadConfig exposes configurable retry limits and 429 backoff settings', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('codex-bridge-config-retry-tuning-');
  const secretFile = path.join(rootDir, 'secrets.env');
  await fs.writeFile(secretFile, 'CODEX_TUNNING_DISCORD_BOT_TOKEN="secret-token-from-file"\n', 'utf8');

  const previous = {
    CODEX_TUNNING_SECRETS_FILE: process.env.CODEX_TUNNING_SECRETS_FILE,
    CODEX_TUNNING_DISCORD_BOT_TOKEN: process.env.CODEX_TUNNING_DISCORD_BOT_TOKEN,
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    DATA_DIR: process.env.DATA_DIR,
    WEB_ENABLED: process.env.WEB_ENABLED,
    CODEX_MAX_ATTEMPTS: process.env.CODEX_MAX_ATTEMPTS,
    CODEX_RATE_LIMIT_MAX_ATTEMPTS: process.env.CODEX_RATE_LIMIT_MAX_ATTEMPTS,
    CODEX_RATE_LIMIT_BASE_DELAY_MS: process.env.CODEX_RATE_LIMIT_BASE_DELAY_MS,
    CODEX_RATE_LIMIT_MAX_DELAY_MS: process.env.CODEX_RATE_LIMIT_MAX_DELAY_MS,
  };

  delete process.env.CODEX_TUNNING_DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_TOKEN;
  process.env.CODEX_TUNNING_SECRETS_FILE = secretFile;
  process.env.DATA_DIR = rootDir;
  process.env.WEB_ENABLED = 'false';
  process.env.CODEX_MAX_ATTEMPTS = '12';
  process.env.CODEX_RATE_LIMIT_MAX_ATTEMPTS = '60';
  process.env.CODEX_RATE_LIMIT_BASE_DELAY_MS = '1500';
  process.env.CODEX_RATE_LIMIT_MAX_DELAY_MS = '45000';

  try {
    const config = loadConfig();
    assert.equal(config.codexMaxAttempts, 12);
    assert.equal(config.codexRateLimitMaxAttempts, 60);
    assert.equal(config.codexRateLimitBaseDelayMs, 1_500);
    assert.equal(config.codexRateLimitMaxDelayMs, 45_000);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await cleanupDir(rootDir);
  }
});

const wiscordEnvKeys = [
  'CODEX_TUNNING_DISCORD_BOT_TOKEN',
  'WISCORD_ENABLED',
  'WISCORD_APP_ID',
  'WISCORD_APP_SECRET',
  'WISCORD_BASE_URL',
  'WISCORD_CHANNEL_ID',
  'WISCORD_GUILD_ID',
  'WISCORD_PROJECT_NAME',
  'WISCORD_WORKSPACE_PATH',
] as const;

function withWiscordEnv(
  overrides: Partial<Record<(typeof wiscordEnvKeys)[number], string | undefined>>,
  callback: () => void,
): void {
  const previous = Object.fromEntries(wiscordEnvKeys.map((key) => [key, process.env[key]]));
  const values: Record<(typeof wiscordEnvKeys)[number], string | undefined> = {
    CODEX_TUNNING_DISCORD_BOT_TOKEN: 'discord-test-token',
    WISCORD_ENABLED: 'true',
    WISCORD_APP_ID: 'app_test',
    WISCORD_APP_SECRET: 'wiscord-test-secret',
    WISCORD_BASE_URL: 'https://wiscord.example.test/',
    WISCORD_CHANNEL_ID: 'channel_test',
    WISCORD_GUILD_ID: 'guild_test',
    WISCORD_PROJECT_NAME: 'Wiscord test project',
    WISCORD_WORKSPACE_PATH: './fixtures/wiscord-workspace',
    ...overrides,
  };

  for (const key of wiscordEnvKeys) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    callback();
  } finally {
    for (const key of wiscordEnvKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('loadConfig parses a complete Wiscord transport configuration', { concurrency: false }, () => {
  withWiscordEnv({}, () => {
    const config = loadConfig();

    assert.deepEqual(config.wiscord, {
      appId: 'app_test',
      appSecret: 'wiscord-test-secret',
      baseUrl: 'https://wiscord.example.test',
      channelId: 'channel_test',
      guildId: 'guild_test',
      projectName: 'Wiscord test project',
      workspacePath: path.resolve('./fixtures/wiscord-workspace'),
    });
  });
});

test('loadConfig rejects an enabled Wiscord transport with missing fields', { concurrency: false }, () => {
  withWiscordEnv({ WISCORD_CHANNEL_ID: undefined }, () => {
    assert.throws(() => loadConfig(), /Wiscord.*channelId/);
  });
});

test('loadConfig rejects non-HTTP Wiscord base URLs', { concurrency: false }, () => {
  withWiscordEnv({ WISCORD_BASE_URL: 'ws://wiscord.example.test' }, () => {
    assert.throws(() => loadConfig(), /WISCORD_BASE_URL.*http.*https/i);
  });
});
