#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const images = [];
  const addDirs = [];
  const configs = [];
  let cwd = process.cwd();
  let mode = 'exec';
  let resumeThreadId;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '-i') {
      images.push(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--add-dir') {
      addDirs.push(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '-c') {
      configs.push(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '-C') {
      cwd = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === 'exec') {
      if (argv[index + 1] === 'resume') {
        mode = 'resume';
        let promptValueSeen = false;

        for (let resumeIndex = index + 2; resumeIndex < argv.length; resumeIndex += 1) {
          const resumeArg = argv[resumeIndex];

          if (resumeArg === '-m' || resumeArg === '-c' || resumeArg === '-i') {
            resumeIndex += 1;
            continue;
          }

          if (resumeArg === '--skip-git-repo-check' || resumeArg === '--json') {
            continue;
          }

          if (!resumeThreadId) {
            resumeThreadId = resumeArg;
            continue;
          }

          if (!promptValueSeen) {
            promptValueSeen = true;
            break;
          }
        }
      }

      mode = argv[index + 1] === 'resume' ? 'resume' : 'exec';
    }
  }

  return { images, addDirs, configs, cwd, mode, resumeThreadId };
}

function event(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

const args = parseArgs(process.argv.slice(2));
const prompt = await readStdin();
const scenario = (() => {
  if (prompt.includes('[cancel]')) return 'cancel';
  if (prompt.includes('[slow]')) return 'slow';
  if (prompt.includes('[resume-stale]')) return 'resume-stale';
  if (prompt.includes('[fresh-then-resume-stale]')) return 'fresh-then-resume-stale';
  if (prompt.includes('[flaky-exit]')) return 'flaky-exit';
  if (prompt.includes('[fail]')) return 'fail';
  if (prompt.includes('[invalid-json]')) return 'invalid-json';
  if (prompt.includes('[command]')) return 'command';
  if (prompt.includes('[plan]')) return 'plan';
  if (prompt.includes('[attachments]')) return 'attachments';
  return 'simple';
})();

const logDir = process.env.FAKE_CODEX_LOG_DIR;
if (logDir) {
  await fs.mkdir(logDir, { recursive: true });
  const file = path.join(logDir, `${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  await fs.writeFile(file, JSON.stringify({
    argv: process.argv.slice(2),
    args,
    prompt,
    cwd: process.cwd(),
    env: {
      PWD: process.env.PWD,
      CODEX_CI: process.env.CODEX_CI,
      CODEX_SHELL: process.env.CODEX_SHELL,
      CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE,
      CODEX_TUNNING_SECRETS_FILE: process.env.CODEX_TUNNING_SECRETS_FILE,
    },
  }, null, 2));
}

const threadId = args.mode === 'resume' ? args.resumeThreadId : `thread-${Math.random().toString(16).slice(2, 10)}`;
if (args.mode !== 'resume') {
  event({ type: 'thread.started', thread_id: threadId });
}

event({ type: 'turn.started' });

if (scenario === 'cancel') {
  process.on('SIGTERM', () => {
    console.error('fake codex cancelled');
    process.exit(143);
  });
  process.on('SIGINT', () => {
    console.error('fake codex interrupted');
    process.exit(130);
  });
  event({ type: 'item.started', item: { id: 'cmd_1', type: 'command_execution', command: '/bin/echo waiting' } });
  await sleep(15_000);
}

if (scenario === 'slow') {
  await sleep(700);
}

if (scenario === 'flaky-exit') {
  const markerPath = path.join(process.cwd(), '.fake-codex-flaky-exit');

  try {
    await fs.access(markerPath);
    await fs.rm(markerPath, { force: true });
  } catch {
    await fs.writeFile(markerPath, prompt, 'utf8');
    console.error('WARNING: failed to clean up stale arg0 temp dirs: Permission denied (os error 13)');
    process.exit(1);
  }
}

if (scenario === 'resume-stale' && args.mode === 'resume') {
  console.error('WARNING: failed to clean up stale arg0 temp dirs: Permission denied (os error 13)');
  process.exit(1);
}

if (scenario === 'fresh-then-resume-stale') {
  const markerPath = path.join(process.cwd(), '.fake-codex-fresh-then-resume-stale');
  let count = 0;
  try {
    count = Number(await fs.readFile(markerPath, 'utf8')) || 0;
  } catch {}
  await fs.writeFile(markerPath, String(count + 1), 'utf8');

  if (count === 0 && args.mode === 'exec') {
    console.error('WARNING: failed to clean up stale arg0 temp dirs: Permission denied (os error 13)');
    process.exit(1);
  }

  if (count === 1 && args.mode === 'resume') {
    console.error('WARNING: failed to clean up stale arg0 temp dirs: Permission denied (os error 13)');
    process.exit(1);
  }
}

if (scenario === 'plan') {
  event({
    type: 'item.completed',
    item: {
      id: 'reason_1',
      type: 'reasoning',
      text: '**Inspecting request**\n\nI will create a short plan, run one command, and then summarize the results.',
    },
  });
  event({
    type: 'item.started',
    item: {
      id: 'todo_1',
      type: 'todo_list',
      items: [
        { text: 'Create a short plan', completed: true },
        { text: 'Run pwd', completed: false },
        { text: 'Summarize the result', completed: false },
      ],
    },
  });
  event({ type: 'item.started', item: { id: 'cmd_plan', type: 'command_execution', command: '/bin/zsh -lc "pwd"' } });
  event({
    type: 'item.completed',
    item: {
      id: 'cmd_plan',
      type: 'command_execution',
      command: '/bin/zsh -lc "pwd"',
      aggregated_output: `${process.cwd()}\n`,
      exit_code: 0,
      status: 'completed',
    },
  });
  event({
    type: 'item.updated',
    item: {
      id: 'todo_1',
      type: 'todo_list',
      items: [
        { text: 'Create a short plan', completed: true },
        { text: 'Run pwd', completed: true },
        { text: 'Summarize the result', completed: true },
      ],
    },
  });
}

if (scenario === 'command' || scenario === 'attachments') {
  event({ type: 'item.started', item: { id: 'cmd_1', type: 'command_execution', command: '/bin/zsh -lc "ls -la"' } });
  const output = scenario === 'attachments'
    ? [`images=${args.images.length}`, `addDirs=${args.addDirs.join(',') || 'none'}`].join('\n')
    : 'file-a\nfile-b\n';
  event({
    type: 'item.completed',
    item: {
      id: 'cmd_1',
      type: 'command_execution',
      command: '/bin/zsh -lc "ls -la"',
      aggregated_output: output,
      exit_code: 0,
      status: 'completed',
    },
  });
}

if (scenario === 'invalid-json') {
  process.stdout.write('not-json\n');
  process.exit(0);
}

if (scenario === 'fail') {
  event({ type: 'item.completed', item: { id: 'msg_1', type: 'agent_message', text: 'I tried but failed.' } });
  console.error('intentional fake failure');
  process.exit(2);
}

const finalText = scenario === 'attachments'
  ? `attachments ok; resumed=${args.mode === 'resume'}; images=${args.images.length}; dirs=${args.addDirs.length}`
  : scenario === 'plan'
    ? `plan ok; resumed=${args.mode === 'resume'}; cwd=${process.cwd()}`
    : `ok: ${prompt} | resumed=${args.mode === 'resume'} | thread=${threadId}`;

event({ type: 'item.completed', item: { id: 'msg_1', type: 'agent_message', text: finalText } });
event({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
process.exit(0);
