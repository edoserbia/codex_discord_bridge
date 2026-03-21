#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const legacyFixture = path.join(__dirname, 'fake-codex.mjs');
const args = process.argv.slice(2);

if (args[0] !== 'app-server') {
  await delegate(legacyFixture, args);
  process.exit(0);
}

const listenUrl = args[2] ?? '';
const port = Number.parseInt(new URL(listenUrl).port, 10);
const threads = new Map();
const activeTurns = new Map();

const server = new WebSocketServer({ host: '127.0.0.1', port });

server.on('connection', (socket) => {
  socket.on('message', (raw) => {
    handle(socket, JSON.parse(String(raw)));
  });
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function handle(socket, message) {
  switch (message.method) {
    case 'initialize':
      respond(socket, message.id, { userAgent: 'fake-codex-app-server-ws' });
      return;
    case 'thread/start': {
      const threadId = `thread-${randomUUID().slice(0, 8)}`;
      threads.set(threadId, { id: threadId });
      respond(socket, message.id, {
        approvalPolicy: 'never',
        cwd: message.params?.cwd ?? process.cwd(),
        model: 'fake-model',
        modelProvider: 'fake-provider',
        sandbox: 'workspace-write',
        thread: { id: threadId },
      });
      notify(socket, 'thread/started', {
        thread: { id: threadId },
      });
      return;
    }
    case 'thread/resume': {
      const threadId = message.params?.threadId;
      threads.set(threadId, { id: threadId });
      respond(socket, message.id, {
        approvalPolicy: 'never',
        cwd: message.params?.cwd ?? process.cwd(),
        model: 'fake-model',
        modelProvider: 'fake-provider',
        sandbox: 'workspace-write',
        thread: { id: threadId },
      });
      return;
    }
    case 'turn/start': {
      const threadId = message.params?.threadId;
      const prompt = message.params?.input?.[0]?.text ?? '';
      const turnId = `turn-${randomUUID().slice(0, 8)}`;
      respond(socket, message.id, {
        turn: { id: turnId },
      });
      notify(socket, 'turn/started', {
        threadId,
        turn: { id: turnId },
      });

      if (prompt.includes('[app-plan]')) {
        notify(socket, 'turn/plan/updated', {
          threadId,
          turnId,
          plan: [
            { step: 'Inspect files', status: 'completed' },
            { step: 'Patch code', status: 'inProgress' },
          ],
        });
      }

      notify(socket, 'item/commandExecution/outputDelta', {
        threadId,
        turnId,
        itemId: `cmd-${turnId}`,
        delta: '/bin/zsh -lc "pwd"\n',
      });

      notify(socket, 'item/agentMessage/delta', {
        threadId,
        turnId,
        itemId: `msg-${turnId}`,
        delta: `app-server ws ok: ${prompt}`,
      });

      const timeout = setTimeout(() => {
        activeTurns.delete(turnId);
        notify(socket, 'turn/completed', {
          threadId,
          turn: { id: turnId, status: 'completed' },
        });
      }, 40);
      activeTurns.set(turnId, { threadId, timeout });
      return;
    }
    case 'turn/interrupt': {
      const turnId = message.params?.turnId;
      const activeTurn = activeTurns.get(turnId);
      respond(socket, message.id, {});
      if (activeTurn) {
        clearTimeout(activeTurn.timeout);
        activeTurns.delete(turnId);
        notify(socket, 'turn/completed', {
          threadId: activeTurn.threadId,
          turn: { id: turnId, status: 'interrupted' },
        });
      }
      return;
    }
    case 'turn/steer':
      respond(socket, message.id, {});
      return;
    case 'initialized':
      return;
    default:
      respond(socket, message.id, {});
  }
}

function respond(socket, id, result) {
  socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

function notify(socket, method, params) {
  socket.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
}

function shutdown(code) {
  server.close(() => process.exit(code));
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
