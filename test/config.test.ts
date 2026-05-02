import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { loadConfig } from '../src/config.js';
import { ensureCodexFeatureFlags, readCodexFeatureFlag } from '../src/codexConfig.js';

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

test('ensureCodexFeatureFlags inserts goals and multi_agent into config.toml', async () => {
  const rootDir = await makeTempDir('codex-bridge-config-features-');
  const codexConfigPath = path.join(rootDir, '.codex', 'config.toml');

  try {
    await fs.mkdir(path.dirname(codexConfigPath), { recursive: true });
    await fs.writeFile(codexConfigPath, 'model = "gpt-5.5"\n\n[tools]\nweb_search = true\n', 'utf8');

    await ensureCodexFeatureFlags(codexConfigPath, ['multi_agent', 'goals']);

    const content = await fs.readFile(codexConfigPath, 'utf8');
    assert.match(content, /\[features\]/);
    assert.equal(readCodexFeatureFlag(content, 'multi_agent'), true);
    assert.equal(readCodexFeatureFlag(content, 'goals'), true);
    assert.match(content, /\[tools\]\nweb_search = true/);
  } finally {
    await cleanupDir(rootDir);
  }
});

test('ensureCodexFeatureFlags flips existing false feature flags to true', async () => {
  const rootDir = await makeTempDir('codex-bridge-config-features-existing-');
  const codexConfigPath = path.join(rootDir, '.codex', 'config.toml');

  try {
    await fs.mkdir(path.dirname(codexConfigPath), { recursive: true });
    await fs.writeFile(codexConfigPath, '[features]\nmulti_agent = false\ngoals = false\n', 'utf8');

    await ensureCodexFeatureFlags(codexConfigPath, ['multi_agent', 'goals']);

    const content = await fs.readFile(codexConfigPath, 'utf8');
    assert.equal(readCodexFeatureFlag(content, 'multi_agent'), true);
    assert.equal(readCodexFeatureFlag(content, 'goals'), true);
    assert.doesNotMatch(content, /multi_agent = false/);
    assert.doesNotMatch(content, /goals = false/);
  } finally {
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
