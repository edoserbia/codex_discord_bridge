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
