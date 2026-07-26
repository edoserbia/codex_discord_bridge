#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const addDirs = [];
  let model;
  let permissionMode;
  let resumeSessionId;
  let inputFormat;
  let outputFormat;
  let includePartialMessages = false;
  let print = false;
  let verbose = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '-p' || arg === '--print') {
      print = true;
      continue;
    }

    if (arg === '--verbose') {
      verbose = true;
      continue;
    }

    if (arg === '--input-format') {
      inputFormat = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--output-format') {
      outputFormat = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--include-partial-messages') {
      includePartialMessages = true;
      continue;
    }

    if (arg === '--resume') {
      resumeSessionId = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--model') {
      model = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--permission-mode') {
      permissionMode = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--add-dir') {
      addDirs.push(argv[index + 1]);
      index += 1;
    }
  }

  return {
    print,
    verbose,
    inputFormat,
    outputFormat,
    includePartialMessages,
    resumeSessionId,
    model,
    permissionMode,
    addDirs,
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function event(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const argv = process.argv.slice(2);
const args = parseArgs(argv);
const prompt = await readStdin();
const sessionId = args.resumeSessionId || `claude-session-${Math.random().toString(16).slice(2, 10)}`;

if (args.print && args.outputFormat === 'stream-json' && !args.verbose) {
  process.stderr.write('Error: When using --print, --output-format=stream-json requires --verbose\n');
  process.exit(1);
}

const logDir = process.env.FAKE_CLAUDE_LOG_DIR;
if (logDir) {
  await fs.mkdir(logDir, { recursive: true });
  const file = path.join(logDir, `${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  await fs.writeFile(file, JSON.stringify({
    argv,
    args,
    prompt,
    cwd: process.cwd(),
    env: {
      PWD: process.env.PWD,
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      ALL_PROXY: process.env.ALL_PROXY,
      http_proxy: process.env.http_proxy,
      https_proxy: process.env.https_proxy,
      all_proxy: process.env.all_proxy,
    },
  }, null, 2));
}

async function projectAllowsFakeTool() {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), '.claude', 'settings.json'), 'utf8');
    const settings = JSON.parse(raw);
    return Array.isArray(settings?.permissions?.allow)
      && settings.permissions.allow.includes('Bash(fake:*)');
  } catch {
    return false;
  }
}

if (prompt.includes('[fail]')) {
  event({ type: 'system', subtype: 'init', session_id: sessionId });
  event({ type: 'result', subtype: 'error', session_id: sessionId, error: 'fake claude failure' });
  process.exit(1);
}

if (prompt.includes('[permission]') && !await projectAllowsFakeTool()) {
  event({ type: 'system', subtype: 'init', session_id: sessionId });
  event({
    type: 'permission_request',
    id: 'perm-fake',
    toolPattern: 'Bash(fake:*)',
    description: 'fake tool permission',
  });
  event({ type: 'result', subtype: 'error', session_id: sessionId, error: 'permission required' });
  process.exit(1);
}

if (prompt.includes('[stream-progress]')) {
  event({ type: 'system', subtype: 'init', session_id: sessionId });
  event({
    type: 'stream_event',
    session_id: sessionId,
    event: { type: 'message_start', message: { id: 'message-stream-1', content: [] } },
  });
  event({
    type: 'stream_event',
    session_id: sessionId,
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  });
  event({
    type: 'stream_event',
    session_id: sessionId,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Claude ' } },
  });
  await delay(50);
  event({
    type: 'stream_event',
    session_id: sessionId,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正在检查仓库' } },
  });
  event({
    type: 'stream_event',
    session_id: sessionId,
    event: { type: 'content_block_stop', index: 0 },
  });
  event({
    type: 'stream_event',
    session_id: sessionId,
    event: {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'tool-stream-1', name: 'Bash', input: {} },
    },
  });
  event({
    type: 'stream_event',
    session_id: sessionId,
    event: {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"command":"git status"}' },
    },
  });
  event({
    type: 'stream_event',
    session_id: sessionId,
    event: { type: 'content_block_stop', index: 1 },
  });
  event({
    type: 'assistant',
    session_id: sessionId,
    message: {
      content: [
        { type: 'text', text: 'Claude 正在检查仓库' },
        { type: 'tool_use', id: 'tool-stream-1', name: 'Bash', input: { command: 'git status' } },
      ],
    },
  });
  await delay(150);
  event({
    type: 'user',
    session_id: sessionId,
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'tool-stream-1', content: 'On branch main', is_error: false },
      ],
    },
  });
  await delay(150);
  event({
    type: 'assistant',
    session_id: sessionId,
    message: {
      content: [
        { type: 'text', text: 'Claude 已检查仓库，正在整理结果。' },
      ],
    },
  });
  await delay(750);
  event({
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    result: `Claude final: ${prompt}`,
  });
  process.exit(0);
}

event({ type: 'system', subtype: 'init', session_id: sessionId });
event({
  type: 'assistant',
  message: {
    content: [
      { type: 'text', text: `Claude saw: ${prompt}` },
    ],
  },
});
event({
  type: 'result',
  subtype: 'success',
  session_id: sessionId,
  result: `Claude final: ${prompt}`,
});
