#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const legacyFixture = path.join(__dirname, 'fake-codex.mjs');
const args = process.argv.slice(2);

if (args[0] !== 'app-server') {
  await delegate(legacyFixture, args);
  process.exit(0);
}

let buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  processBuffer();
});

function processBuffer() {
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      return;
    }

    const headerText = buffer.slice(0, headerEnd).toString('utf8');
    const lengthMatch = headerText.match(/content-length:\s*(\d+)/i);
    if (!lengthMatch) {
      throw new Error('missing content-length header');
    }

    const contentLength = Number.parseInt(lengthMatch[1], 10);
    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + contentLength;
    if (buffer.length < messageEnd) {
      return;
    }

    const payload = buffer.slice(messageStart, messageEnd).toString('utf8');
    buffer = buffer.slice(messageEnd);
    handle(JSON.parse(payload));
  }
}

function handle(message) {
  switch (message.method) {
    case 'initialize':
      respond(message.id, { userAgent: 'fake-codex-app-server-turn-fallback' });
      return;
    case 'thread/start': {
      const threadId = `thread-${randomUUID().slice(0, 8)}`;
      respond(message.id, {
        approvalPolicy: 'never',
        cwd: message.params?.cwd ?? process.cwd(),
        model: 'fake-model',
        modelProvider: 'fake-provider',
        sandbox: 'workspace-write',
        thread: { id: threadId },
      });
      return;
    }
    case 'thread/resume': {
      const threadId = message.params?.threadId;
      respond(message.id, {
        approvalPolicy: 'never',
        cwd: message.params?.cwd ?? process.cwd(),
        model: 'fake-model',
        modelProvider: 'fake-provider',
        sandbox: 'workspace-write',
        thread: { id: threadId },
      });
      return;
    }
    case 'turn/start':
      setTimeout(() => process.exit(1), 20);
      return;
    default:
      respond(message.id, {});
  }
}

function respond(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function writeMessage(payload) {
  const message = JSON.stringify(payload);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(message, 'utf8')}\r\n\r\n${message}`);
}

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
