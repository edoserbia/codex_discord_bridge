#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
  if (prompt.includes('[json-transient]')) return 'json-transient';
  if (prompt.includes('[json-stale-session]')) return 'json-stale-session';
  if (prompt.includes('[zero-exit-no-turn]')) return 'zero-exit-no-turn';
  if (prompt.includes('[flaky-exit]')) return 'flaky-exit';
  if (prompt.includes('[fail]')) return 'fail';
  if (prompt.includes('[invalid-json]')) return 'invalid-json';
  if (prompt.includes('[command]')) return 'command';
  if (prompt.includes('[plan]')) return 'plan';
  if (prompt.includes('[plan-live]')) return 'plan-live';
  if (prompt.includes('[plan-fast]')) return 'plan-fast';
  if (prompt.includes('[plan-race]')) return 'plan-race';
  if (prompt.includes('[plan-status]')) return 'plan-status';
  if (prompt.includes('[subagent]')) return 'subagent';
  if (prompt.includes('[attachments]')) return 'attachments';
  if (prompt.includes('AUTOPILOT_REPORT')) return 'autopilot';
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

if (scenario === 'json-transient') {
  const markerPath = path.join(process.cwd(), '.fake-codex-json-transient');

  try {
    await fs.access(markerPath);
    await fs.rm(markerPath, { force: true });
  } catch {
    await fs.writeFile(markerPath, prompt, 'utf8');
    event({ type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion: error sending request for url (https://example.invalid/v1/responses))' });
    event({ type: 'error', message: 'Reconnecting... 2/5 (stream disconnected before completion: error sending request for url (https://example.invalid/v1/responses))' });
    event({ type: 'turn.failed', error: { message: 'stream disconnected before completion: error sending request for url (https://example.invalid/v1/responses)' } });
    process.exit(1);
  }
}

if (scenario === 'json-stale-session' && args.mode === 'resume') {
  event({ type: 'turn.failed', error: { message: 'conversation session not found for resume thread' } });
  process.exit(1);
}

if (scenario === 'zero-exit-no-turn') {
  const markerPath = path.join(process.cwd(), '.fake-codex-zero-exit-no-turn');

  try {
    await fs.access(markerPath);
    await fs.rm(markerPath, { force: true });
  } catch {
    await fs.writeFile(markerPath, prompt, 'utf8');
    console.error('WARNING: failed to clean up stale arg0 temp dirs: Permission denied (os error 13)');
    process.exit(0);
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

if (scenario === 'plan-status') {
  event({
    type: 'item.started',
    item: {
      id: 'todo_status_1',
      type: 'todo_list',
      items: [
        { text: 'Inspect files', status: 'completed' },
        { text: 'Patch code', status: 'in_progress' },
        { text: 'Run tests', status: 'pending' },
      ],
    },
  });
  event({
    type: 'item.updated',
    item: {
      id: 'todo_status_1',
      type: 'todo_list',
      items: [
        { text: 'Inspect files', status: 'completed' },
        { text: 'Patch code', status: 'completed' },
        { text: 'Run tests', status: 'completed' },
      ],
    },
  });
}

if (scenario === 'plan-live') {
  event({
    type: 'item.started',
    item: {
      id: 'todo_live_1',
      type: 'todo_list',
      items: [
        { id: 'live-1', text: 'Inspect files', status: 'completed' },
        { id: 'live-2', text: 'Patch code', status: 'in_progress' },
        { id: 'live-3', text: 'Run tests', status: 'pending' },
      ],
    },
  });
  await sleep(1_400);
  event({
    type: 'item.updated',
    item: {
      id: 'todo_live_1',
      type: 'todo_list',
      items: [
        { id: 'live-1', state: 'completed' },
        { id: 'live-2', title: 'Patch code', state: 'completed' },
        { id: 'live-3', content: { value: 'Run tests' }, state: 'completed' },
      ],
    },
  });
}

if (scenario === 'plan-fast') {
  event({
    type: 'item.started',
    item: {
      id: 'todo_fast_1',
      type: 'todo_list',
      items: [
        { id: 'fast-1', text: 'Inspect files', status: 'completed' },
        { id: 'fast-2', text: 'Patch code', status: 'in_progress' },
        { id: 'fast-3', text: 'Run tests', status: 'pending' },
      ],
    },
  });
  await sleep(50);
  event({
    type: 'item.updated',
    item: {
      id: 'todo_fast_1',
      type: 'todo_list',
      items: [
        { id: 'fast-1', state: 'completed' },
        { id: 'fast-2', title: 'Patch code', state: 'completed' },
        { id: 'fast-3', content: { value: 'Run tests' }, state: 'completed' },
      ],
    },
  });
}

if (scenario === 'plan-race') {
  event({
    type: 'item.started',
    item: {
      id: 'todo_race_1',
      type: 'todo_list',
      items: [
        { id: 'race-1', text: 'Inspect files', status: 'completed' },
        { id: 'race-2', text: 'Patch code', status: 'in_progress' },
        { id: 'race-3', text: 'Run tests', status: 'pending' },
      ],
    },
  });
  await sleep(450);
  event({
    type: 'item.updated',
    item: {
      id: 'todo_race_1',
      type: 'todo_list',
      items: [
        { id: 'race-1', state: 'completed' },
        { id: 'race-2', title: 'Patch code', state: 'completed' },
        { id: 'race-3', content: { value: 'Run tests' }, state: 'completed' },
      ],
    },
  });
}

if (scenario === 'subagent') {
  event({
    type: 'item.started',
    item: {
      id: 'todo_subagent_1',
      type: 'todo_list',
      items: [
        { id: 'sub-1', text: 'Inspect the request', completed: true },
        { id: 'sub-2', text: 'Coordinate one helper agent', completed: false },
        { id: 'sub-3', text: 'Summarize the outcome', completed: false },
      ],
    },
  });

  event({
    type: 'item.started',
    item: {
      id: 'collab_1',
      type: 'collab_tool_call',
      tool: 'spawn_agent',
      sender_thread_id: threadId,
      receiver_thread_ids: [],
      prompt: 'Investigate the login flow and list the risky edge cases.',
      agents_states: {},
      status: 'in_progress',
    },
  });

  await sleep(80);
  event({
    type: 'item.completed',
    item: {
      id: 'collab_1',
      type: 'collab_tool_call',
      tool: 'spawn_agent',
      sender_thread_id: threadId,
      receiver_thread_ids: ['sub-thread-1'],
      prompt: 'Investigate the login flow and list the risky edge cases.',
      agents_states: {
        'sub-thread-1': { status: 'running', message: null },
      },
      status: 'completed',
    },
  });

  event({
    type: 'item.started',
    item: {
      id: 'collab_2',
      type: 'collab_tool_call',
      tool: 'send_input',
      sender_thread_id: threadId,
      receiver_thread_ids: ['sub-thread-1'],
      prompt: 'Focus on auth redirects, token refresh, and empty-button regressions.',
      agents_states: {
        'sub-thread-1': { status: 'running', message: null },
      },
      status: 'in_progress',
    },
  });

  event({
    type: 'item.completed',
    item: {
      id: 'collab_2',
      type: 'collab_tool_call',
      tool: 'send_input',
      sender_thread_id: threadId,
      receiver_thread_ids: ['sub-thread-1'],
      prompt: 'Focus on auth redirects, token refresh, and empty-button regressions.',
      agents_states: {
        'sub-thread-1': { status: 'running', message: null },
      },
      status: 'completed',
    },
  });

  event({
    type: 'item.started',
    item: {
      id: 'collab_3',
      type: 'collab_tool_call',
      tool: 'wait',
      sender_thread_id: threadId,
      receiver_thread_ids: ['sub-thread-1'],
      prompt: null,
      agents_states: {
        'sub-thread-1': { status: 'running', message: null },
      },
      status: 'in_progress',
    },
  });

  await sleep(1_350);
  event({
    type: 'item.completed',
    item: {
      id: 'collab_3',
      type: 'collab_tool_call',
      tool: 'wait',
      sender_thread_id: threadId,
      receiver_thread_ids: ['sub-thread-1'],
      prompt: null,
      agents_states: {
        'sub-thread-1': { status: 'completed', message: 'Found two auth redirect edge cases and one empty-button regression.' },
      },
      status: 'completed',
    },
  });

  event({
    type: 'item.completed',
    item: {
      id: 'collab_4',
      type: 'collab_tool_call',
      tool: 'close_agent',
      sender_thread_id: threadId,
      receiver_thread_ids: ['sub-thread-1'],
      prompt: null,
      agents_states: {
        'sub-thread-1': { status: 'shutdown', message: null },
      },
      status: 'completed',
    },
  });

  event({
    type: 'item.updated',
    item: {
      id: 'todo_subagent_1',
      type: 'todo_list',
      items: [
        { id: 'sub-1', state: 'completed' },
        { id: 'sub-2', title: 'Coordinate one helper agent', state: 'completed' },
        { id: 'sub-3', content: { value: 'Summarize the outcome' }, state: 'completed' },
      ],
    },
  });
}

if (scenario === 'autopilot') {
  const boardctlPath = prompt.match(/看板脚本：\n([^\n]+)\n/)?.[1]?.trim();
  if (boardctlPath) {
    const runBoardCtl = async (...argv) => {
      const { stdout } = await execFileAsync(process.execPath, [boardctlPath, ...argv], {
        cwd: process.cwd(),
      });
      return stdout.trim();
    };
    const ensureItem = async (status, title, notes) => {
      const raw = await runBoardCtl('list', '--json');
      const items = JSON.parse(raw);
      const existing = items.find((item) => item.title === title);
      if (existing) {
        return existing;
      }
      const args = ['add', status, title, '--json'];
      if (notes) {
        args.push('--notes', notes);
      }
      return JSON.parse(await runBoardCtl(...args));
    };
    await runBoardCtl('ensure', '--json');
    const primaryTask = await ensureItem('ready', '补齐会话恢复相关测试');
    await runBoardCtl('move', primaryTask.id, 'doing', '--json');
    await runBoardCtl('move', primaryTask.id, 'done', '--notes', '已补齐 fake autopilot 验证路径', '--json');
    await ensureItem('ready', '补充绑定重置相关测试');
    await ensureItem('ready', '补充 web reset 覆盖');
    await ensureItem('deferred', '大范围重构会话状态模型');
  }
  event({
    type: 'item.completed',
    item: {
      id: 'reason_auto',
      type: 'reasoning',
      text: 'I will pick one low-risk task, run validation, and then update the lightweight autopilot board.',
    },
  });
  event({
    type: 'item.updated',
    item: {
      id: 'todo_auto',
      type: 'todo_list',
      items: [
        { text: 'Pick one low-risk task', completed: true },
        { text: 'Implement and validate it', completed: true },
        { text: 'Update AUTOPILOT_REPORT', completed: true },
      ],
    },
  });
  event({ type: 'item.started', item: { id: 'cmd_auto_1', type: 'command_execution', command: '/bin/zsh -lc "npm run check"' } });
  event({
    type: 'item.completed',
    item: {
      id: 'cmd_auto_1',
      type: 'command_execution',
      command: '/bin/zsh -lc "npm run check"',
      aggregated_output: 'check ok\n',
      exit_code: 0,
      status: 'completed',
    },
  });
  event({ type: 'item.started', item: { id: 'cmd_auto_2', type: 'command_execution', command: '/bin/zsh -lc "npm test"' } });
  event({
    type: 'item.completed',
    item: {
      id: 'cmd_auto_2',
      type: 'command_execution',
      command: '/bin/zsh -lc "npm test"',
      aggregated_output: 'test ok\n',
      exit_code: 0,
      status: 'completed',
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
    : scenario === 'subagent'
      ? 'subagent ok; helper agent coordinated successfully'
    : scenario === 'autopilot'
      ? [
        'Autopilot finished one low-risk task and validation passed.',
        '',
        'AUTOPILOT_REPORT',
        '```json',
        JSON.stringify({
          goal: '补齐会话恢复相关测试',
          summary: '补齐了会话恢复相关测试，并完成本地验证。',
          next: '下一轮可以补充绑定重置和 web reset 的覆盖。',
          board: {
            ready: ['补充绑定重置相关测试', '补充 web reset 覆盖'],
            doing: [],
            blocked: [],
            done: ['补齐会话恢复相关测试'],
            deferred: ['大范围重构会话状态模型'],
          },
        }, null, 2),
        '```',
      ].join('\n')
    : `ok: ${prompt} | resumed=${args.mode === 'resume'} | thread=${threadId}`;

event({ type: 'item.completed', item: { id: 'msg_1', type: 'agent_message', text: finalText } });
event({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
process.exit(0);
