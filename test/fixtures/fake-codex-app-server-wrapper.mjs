#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const legacyFixture = path.join(__dirname, 'fake-codex.mjs');
const appServerFixture = path.join(__dirname, 'fake-codex-app-server.mjs');
const args = process.argv.slice(2);

if (args[0] === 'app-server') {
  await delegate(appServerFixture, args);
  process.exit(0);
}

await delegate(legacyFixture, args);
process.exit(0);

async function delegate(scriptPath, childArgs) {
  const child = spawn(process.execPath, [scriptPath, ...childArgs], {
    env: process.env,
    stdio: 'inherit',
  });

  const forwardSignal = (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };

  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));

  const result = await new Promise((resolve, reject) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
    child.on('error', reject);
  });

  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }

  process.exit(result.code ?? 1);
}
