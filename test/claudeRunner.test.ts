import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';

import type { AppConfig } from '../src/config.js';
import type { ChannelBinding } from '../src/types.js';

import { ClaudeRunner } from '../src/claudeRunner.js';

import { cleanupDir, createWorkspace, makeTempDir } from './helpers/testUtils.js';

const fakeClaudeCommand = path.resolve('test/fixtures/fake-claude.mjs');

function makeConfig(rootDir: string, claudeCommand = fakeClaudeCommand): AppConfig {
  return {
    discordToken: 'test-token',
    commandPrefix: '!',
    dataDir: path.join(rootDir, 'data'),
    codexCommand: 'codex',
    claudeCommand,
    claudeSettingsPath: path.join(rootDir, '.claude', 'settings.json'),
    codexMaxAttempts: 10,
    codexRateLimitMaxAttempts: 0,
    codexRateLimitBaseDelayMs: 5_000,
    codexRateLimitMaxDelayMs: 60_000,
    allowedWorkspaceRoots: [rootDir],
    adminUserIds: new Set(),
    defaultCodex: {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      search: false,
      skipGitRepoCheck: true,
      addDirs: [],
      extraConfig: [],
    },
    web: {
      enabled: false,
      bind: '127.0.0.1',
      port: 0,
      authToken: undefined,
    },
  };
}

function makeBinding(workspacePath: string): ChannelBinding {
  return {
    channelId: 'channel-1',
    guildId: 'guild-1',
    projectName: 'api',
    workspacePath,
    codex: {
      model: 'claude-sonnet-4',
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      search: false,
      skipGitRepoCheck: true,
      addDirs: [],
      extraConfig: [],
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test('claude runner handles simple execution and session creation', async () => {
  const rootDir = await makeTempDir('claude-runner-simple-');
  const workspace = await createWorkspace(rootDir);
  const runner = new ClaudeRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);
  const startedSessions: string[] = [];
  const messages: string[] = [];

  const result = await runner.start(binding, { engine: 'claude', prompt: 'hello claude', imagePaths: [], extraAddDirs: [] }, undefined, {
    onThreadStarted: async (sessionId) => { startedSessions.push(sessionId); },
    onAgentMessage: async (message) => { messages.push(message); },
  }).done;

  assert.equal(result.engine, 'claude');
  assert.equal(result.success, true);
  assert.ok(result.claudeSessionId);
  assert.equal(startedSessions[0], result.claudeSessionId);
  assert.match(result.agentMessages.at(-1) ?? '', /Claude final: hello claude/);
  assert.ok(messages.some((message) => /Claude saw: hello claude/.test(message)));
  await cleanupDir(rootDir);
});

test('claude runner resumes an existing session and forwards add-dir and permission args', async () => {
  const rootDir = await makeTempDir('claude-runner-args-');
  const workspace = await createWorkspace(rootDir);
  const extraDir = await createWorkspace(path.join(rootDir, 'extra'));
  const logDir = path.join(rootDir, 'fake-claude-logs');
  process.env.FAKE_CLAUDE_LOG_DIR = logDir;

  const runner = new ClaudeRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);
  binding.codex.addDirs = [extraDir];

  try {
    const result = await runner.start(
      binding,
      { engine: 'claude', prompt: 'resume please', imagePaths: [], extraAddDirs: [workspace] },
      'claude-session-existing',
    ).done;

    assert.equal(result.success, true);
    assert.equal(result.usedResume, true);
    assert.equal(result.claudeSessionId, 'claude-session-existing');

    const logFiles = await readdir(logDir);
    const payload = JSON.parse(await readFile(path.join(logDir, logFiles.sort().at(-1)!), 'utf8')) as {
      argv: string[];
      args: {
        print: boolean;
        verbose: boolean;
        inputFormat: string;
        outputFormat: string;
        resumeSessionId?: string;
        model?: string;
        permissionMode?: string;
        addDirs: string[];
      };
      prompt: string;
      cwd: string;
    };

    assert.equal(payload.args.print, true);
    assert.equal(payload.args.verbose, true);
    assert.equal(payload.args.inputFormat, 'text');
    assert.equal(payload.args.outputFormat, 'stream-json');
    assert.equal(payload.args.resumeSessionId, 'claude-session-existing');
    assert.equal(payload.args.model, undefined);
    assert.equal(payload.args.permissionMode, 'bypassPermissions');
    assert.deepEqual(payload.args.addDirs.sort(), [extraDir, workspace].sort());
    assert.equal(payload.prompt, 'resume please');
    assert.equal(await realpath(payload.cwd), await realpath(workspace));
    assert.ok(payload.argv.indexOf('--verbose') >= 0);
    assert.ok(payload.argv.indexOf('--resume') >= 0);
  } finally {
    delete process.env.FAKE_CLAUDE_LOG_DIR;
    await cleanupDir(rootDir);
  }
});

test('claude runner uses project Claude settings before global settings and ignores Codex binding model', async () => {
  const rootDir = await makeTempDir('claude-runner-settings-model-');
  const workspace = await createWorkspace(rootDir);
  const globalSettingsPath = path.join(rootDir, '.claude', 'settings.json');
  await mkdir(path.dirname(globalSettingsPath), { recursive: true });
  await writeFile(globalSettingsPath, JSON.stringify({ model: 'claude-global' }, null, 2), 'utf8');
  await mkdir(path.join(workspace, '.claude'), { recursive: true });
  await writeFile(path.join(workspace, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-project' }, null, 2), 'utf8');

  const logDir = path.join(rootDir, 'fake-claude-logs');
  process.env.FAKE_CLAUDE_LOG_DIR = logDir;

  const runner = new ClaudeRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);
  binding.codex.model = 'codex-only-model';

  try {
    const result = await runner.start(
      binding,
      { engine: 'claude', prompt: 'use settings model', imagePaths: [], extraAddDirs: [] },
      undefined,
    ).done;

    assert.equal(result.success, true);

    const logFiles = await readdir(logDir);
    const payload = JSON.parse(await readFile(path.join(logDir, logFiles.sort().at(-1)!), 'utf8')) as {
      args: {
        model?: string;
      };
    };

    assert.equal(payload.args.model, 'claude-project');
  } finally {
    delete process.env.FAKE_CLAUDE_LOG_DIR;
    await cleanupDir(rootDir);
  }
});

test('claude runner surfaces permission request events as diagnostics', async () => {
  const rootDir = await makeTempDir('claude-runner-permission-');
  const workspace = await createWorkspace(rootDir);
  const runner = new ClaudeRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);
  binding.codex.sandboxMode = 'workspace-write';
  binding.codex.approvalPolicy = 'on-request';
  const stderr: string[] = [];

  const result = await runner.start(binding, { engine: 'claude', prompt: '[permission] please run git status', imagePaths: [], extraAddDirs: [] }, undefined, {
    onStderr: async (line) => { stderr.push(line); },
  }).done;

  assert.equal(result.engine, 'claude');
  assert.equal(result.success, false);
  assert.equal(result.claudePermissionRequests?.length, 1);
  assert.equal(result.claudePermissionRequests?.[0]?.toolPattern, 'Bash(fake:*)');
  assert.ok(result.stderr.some((line) => /Claude permission required/.test(line)));
  assert.ok(stderr.some((line) => /Claude permission required/.test(line)));
  await cleanupDir(rootDir);
});

test('claude runner streams cumulative text and Bash command progress', async () => {
  const rootDir = await makeTempDir('claude-runner-stream-progress-');
  const workspace = await createWorkspace(rootDir);
  const logDir = path.join(rootDir, 'fake-claude-logs');
  process.env.FAKE_CLAUDE_LOG_DIR = logDir;

  const runner = new ClaudeRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);
  const activities: string[] = [];
  const messages: string[] = [];
  const startedCommands: string[] = [];
  const completedCommands: Array<{ command: string; output: string; exitCode: number | null }> = [];

  try {
    const result = await runner.start(
      binding,
      { engine: 'claude', prompt: '[stream-progress] inspect repository', imagePaths: [], extraAddDirs: [] },
      undefined,
      {
        onActivity: async (activity) => { activities.push(activity); },
        onAgentMessage: async (message) => { messages.push(message); },
        onCommandStarted: async (command) => { startedCommands.push(command); },
        onCommandCompleted: async (command, output, exitCode) => {
          completedCommands.push({ command, output, exitCode });
        },
      },
    ).done;

    const logFiles = await readdir(logDir);
    const payload = JSON.parse(await readFile(path.join(logDir, logFiles.sort().at(-1)!), 'utf8')) as {
      argv: string[];
    };

    assert.ok(payload.argv.includes('--include-partial-messages'));
    assert.ok(activities.some((activity) => /Claude 正在分析请求/.test(activity)));
    assert.ok(messages.some((message) => /正在检查仓库/.test(message)));
    assert.ok(messages.includes('Claude 已检查 仓库，正在整理结果。'));
    assert.ok(messages.every((message) => !/正在检查仓库Claude 已检查/.test(message)));
    assert.ok(startedCommands.includes('git status'));
    assert.deepEqual(completedCommands.at(-1), {
      command: 'git status',
      output: 'On branch main',
      exitCode: 0,
    });
    assert.deepEqual(result.commands.at(-1), {
      command: 'git status',
      output: 'On branch main',
      exitCode: 0,
    });
    assert.equal(result.agentMessages.length, 2);
    assert.equal(result.success, true);
    assert.match(result.agentMessages.at(-1) ?? '', /Claude final: \[stream-progress\] inspect repository/);
  } finally {
    delete process.env.FAKE_CLAUDE_LOG_DIR;
    await cleanupDir(rootDir);
  }
});

test('claude runner treats is_error terminal results as diagnostics', async () => {
  const rootDir = await makeTempDir('claude-runner-result-error-');
  const workspace = await createWorkspace(rootDir);
  const runner = new ClaudeRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);

  try {
    const result = await runner.start(
      binding,
      { engine: 'claude', prompt: '[result-is-error] please fail', imagePaths: [], extraAddDirs: [] },
      undefined,
    ).done;

    assert.equal(result.success, false);
    assert.equal(result.turnCompleted, false);
    assert.ok(result.stderr.some((line) => /fake Claude result failure/.test(line)));
    assert.ok(result.agentMessages.every((message) => !/fake Claude result failure/.test(message)));
  } finally {
    await cleanupDir(rootDir);
  }
});

test('claude runner reports stream-json failures with stderr diagnostics', async () => {
  const rootDir = await makeTempDir('claude-runner-fail-');
  const workspace = await createWorkspace(rootDir);
  const runner = new ClaudeRunner(makeConfig(rootDir));
  const binding = makeBinding(workspace);
  const stderr: string[] = [];

  const result = await runner.start(binding, { engine: 'claude', prompt: '[fail] please fail', imagePaths: [], extraAddDirs: [] }, undefined, {
    onStderr: async (line) => { stderr.push(line); },
  }).done;

  assert.equal(result.engine, 'claude');
  assert.equal(result.success, false);
  assert.equal(result.turnCompleted, false);
  assert.ok(result.claudeSessionId);
  assert.ok(result.stderr.some((line) => /fake claude failure/.test(line)));
  assert.ok(stderr.some((line) => /fake claude failure/.test(line)));
  await cleanupDir(rootDir);
});
