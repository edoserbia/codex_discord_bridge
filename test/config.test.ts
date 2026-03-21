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
