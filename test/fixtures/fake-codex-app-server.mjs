#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

let buffer = Buffer.alloc(0);
const threads = new Map();
const activeTurns = new Map();
const logDir = process.env.FAKE_CODEX_APP_SERVER_LOG_DIR;
const initializeDelayMs = Number.parseInt(process.env.FAKE_CODEX_APP_SERVER_INITIALIZE_DELAY_MS ?? '0', 10) || 0;

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
  void handleAsync(message);
}

async function handleAsync(message) {
  void logRequest(message);

  switch (message.method) {
    case 'initialize':
      if (initializeDelayMs > 0) {
        await sleep(initializeDelayMs);
      }
      respond(message.id, { userAgent: 'fake-codex-app-server' });
      return;
    case 'thread/start': {
      const threadId = `thread-${randomUUID().slice(0, 8)}`;
      threads.set(threadId, { id: threadId });
      respond(message.id, {
        approvalPolicy: 'never',
        cwd: message.params?.cwd ?? process.cwd(),
        model: 'fake-model',
        modelProvider: 'fake-provider',
        sandbox: 'workspace-write',
        thread: { id: threadId },
      });
      notify('thread/started', {
        thread: { id: threadId },
      });
      return;
    }
    case 'thread/resume': {
      const threadId = message.params?.threadId;
      if (!threadId) {
        error(message.id, -32602, 'missing threadId');
        return;
      }
      threads.set(threadId, { id: threadId });
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
    case 'turn/start': {
      const threadId = message.params?.threadId;
      const prompt = message.params?.input?.[0]?.text ?? '';
      const turnId = `turn-${randomUUID().slice(0, 8)}`;
      activeTurns.set(turnId, { threadId, prompt, timeout: undefined });

      if (prompt.includes('[app-buffered-interrupt]')) {
        notify('turn/completed', {
          threadId,
          turn: { id: turnId, status: 'interrupted' },
        });
        respond(message.id, {
          turn: { id: turnId },
        });
        return;
      }

      respond(message.id, {
        turn: { id: turnId },
      });

      notify('turn/started', {
        threadId,
        turn: { id: turnId },
      });

      if (prompt.includes('[app-crash]')) {
        setTimeout(() => {
          process.exit(1);
        }, 20);
        return;
      }

      if (prompt.includes('[app-slow]')) {
        return;
      }

      if (prompt.includes('[app-plan]')) {
        notify('turn/plan/updated', {
          threadId,
          turnId,
          plan: [
            { step: 'Inspect files', status: 'completed' },
            { step: 'Patch code', status: 'inProgress' },
            { step: 'Run tests', status: 'pending' },
          ],
        });
      }

      if (prompt.includes('[app-rich]')) {
        notify('item/reasoning/summaryTextDelta', {
          threadId,
          turnId,
          itemId: `reason-${turnId}`,
          delta: 'Inspecting request',
        });
        notify('item/reasoning/summaryTextDelta', {
          threadId,
          turnId,
          itemId: `reason-${turnId}`,
          delta: ' and planning next steps.',
        });
        notify('item/started', {
          threadId,
          turnId,
          item: {
            id: `cmd-${turnId}`,
            type: 'commandExecution',
            command: '/bin/zsh -lc "pwd"',
            commandActions: [],
            cwd: process.cwd(),
            status: 'in_progress',
          },
        });
        notify('item/started', {
          threadId,
          turnId,
          item: {
            id: `collab-${turnId}`,
            type: 'collabAgentToolCall',
            tool: 'spawn_agent',
            status: 'in_progress',
            senderThreadId: threadId,
            receiverThreadIds: ['agent-thread-1'],
            agentsStates: {
              'agent-thread-1': {
                status: 'running',
                message: 'Investigate the login flow',
              },
            },
            prompt: 'Investigate the login flow',
          },
        });
        notify('item/completed', {
          threadId,
          turnId,
          item: {
            id: `collab-${turnId}`,
            type: 'collabAgentToolCall',
            tool: 'spawn_agent',
            status: 'completed',
            senderThreadId: threadId,
            receiverThreadIds: ['agent-thread-1'],
            agentsStates: {
              'agent-thread-1': {
                status: 'completed',
                message: 'helper finished',
              },
            },
            prompt: 'Investigate the login flow',
          },
        });
        notify('item/completed', {
          threadId,
          turnId,
          item: {
            id: `cmd-${turnId}`,
            type: 'commandExecution',
            command: '/bin/zsh -lc "pwd"',
            commandActions: [],
            cwd: process.cwd(),
            status: 'completed',
            aggregatedOutput: `${process.cwd()}\n`,
            exitCode: 0,
          },
        });
      }

      notify('item/commandExecution/outputDelta', {
        threadId,
        turnId,
        itemId: `cmd-${turnId}`,
        delta: '/bin/zsh -lc "pwd"\n',
      });
      notify('item/agentMessage/delta', {
        threadId,
        turnId,
        itemId: `msg-${turnId}`,
        delta: `app-server ok: ${prompt}`,
      });

      const timeout = setTimeout(() => {
        if (!activeTurns.has(turnId)) {
          return;
        }
        activeTurns.delete(turnId);
        notify('turn/completed', {
          threadId,
          turn: { id: turnId, status: 'completed' },
        });
      }, 40);
      activeTurns.set(turnId, { threadId, prompt, timeout });
      return;
    }
    case 'turn/steer': {
      const turnId = message.params?.expectedTurnId;
      const activeTurn = activeTurns.get(turnId);
      respond(message.id, {
        turnId,
      });
      if (activeTurn) {
        notify('item/agentMessage/delta', {
          threadId: activeTurn.threadId,
          turnId,
          itemId: `msg-${turnId}`,
          delta: `guided: ${message.params?.input?.[0]?.text ?? ''}`,
        });
      }
      return;
    }
    case 'turn/interrupt':
      {
        const turnId = message.params?.turnId;
        const activeTurn = activeTurns.get(turnId);
        if (activeTurn?.timeout) {
          clearTimeout(activeTurn.timeout);
        }
        activeTurns.delete(turnId);
        respond(message.id, {});
        if (activeTurn) {
          setTimeout(() => {
            notify('turn/completed', {
              threadId: activeTurn.threadId,
              turn: { id: turnId, status: 'interrupted' },
            });
          }, 10);
        }
        return;
      }
    default:
      error(message.id, -32601, `unknown method: ${message.method}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function logRequest(message) {
  if (!logDir || !message?.method) {
    return;
  }

  await fs.mkdir(logDir, { recursive: true });
  const filePath = path.join(logDir, `${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  await fs.writeFile(filePath, `${JSON.stringify({
    method: message.method,
    params: message.params ?? null,
  }, null, 2)}\n`, 'utf8');
}

function respond(id, result) {
  write({
    jsonrpc: '2.0',
    id,
    result,
  });
}

function error(id, code, message) {
  write({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
    },
  });
}

function notify(method, params) {
  write({
    jsonrpc: '2.0',
    method,
    params,
  });
}

function write(payload) {
  const message = JSON.stringify(payload);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(message, 'utf8')}\r\n\r\n${message}`);
}
