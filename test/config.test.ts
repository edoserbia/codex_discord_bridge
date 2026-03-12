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
