import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCommand } from '../src/commandParser.js';

test('parse bind command with quoted path and flags', () => {
  const parsed = parseCommand('!bind api "/tmp/my repo" --sandbox workspace-write --approval never --search on --skip-git-check off --add-dir "/tmp/other" --config model="o3"', '!');

  assert.equal(parsed.kind, 'bind');
  if (parsed.kind !== 'bind') {
    return;
  }

  assert.equal(parsed.projectName, 'api');
  assert.equal(parsed.workspacePath, '/tmp/my repo');
  assert.equal(parsed.options.sandboxMode, 'workspace-write');
  assert.equal(parsed.options.approvalPolicy, 'never');
  assert.equal(parsed.options.search, true);
  assert.equal(parsed.options.skipGitRepoCheck, false);
  assert.deepEqual(parsed.options.addDirs, ['/tmp/other']);
  assert.deepEqual(parsed.options.extraConfig, ['model=o3']);
});

test('parse help on empty command', () => {
  assert.deepEqual(parseCommand('!', '!'), { kind: 'help' });
});

test('parse guide command with free text', () => {
  const parsed = parseCommand('!guide 请暂停当前步骤，先检查 README 和 package.json', '!');
  assert.deepEqual(parsed, {
    kind: 'guide',
    prompt: '请暂停当前步骤，先检查 README 和 package.json',
  });
});

test('parse queue insert command', () => {
  const parsed = parseCommand('!queue insert 2', '!');
  assert.deepEqual(parsed, {
    kind: 'queue',
    action: 'insert',
    index: 2,
  });
});

test('parse queue remove command', () => {
  const parsed = parseCommand('!queue remove 2', '!');
  assert.deepEqual(parsed, {
    kind: 'queue',
    action: 'remove',
    index: 2,
  });
});

test('parse sendfile command with a workspace path', () => {
  const parsed = parseCommand('!sendfile report.pdf', '!');
  assert.deepEqual(parsed, {
    kind: 'sendfile',
    request: 'report.pdf',
  });
});

test('parse sendfile command with a numbered candidate selection', () => {
  const parsed = parseCommand('!sendfile 2', '!');
  assert.deepEqual(parsed, {
    kind: 'sendfile',
    index: 2,
  });
});

test('reject unknown flag', () => {
  assert.throws(() => parseCommand('!bind api /tmp --unknown nope', '!'), /未知参数/);
});

test('reject invalid sandbox mode', () => {
  assert.throws(() => parseCommand('!bind api /tmp --sandbox unsafe', '!'), /sandbox/);
});

test('parse autopilot help command', () => {
  const parsed = parseCommand('!autopilot', '!');
  assert.deepEqual(parsed, { kind: 'autopilot', scope: 'help' });
});

test('parse autopilot server shorthand command', () => {
  const parsed = parseCommand('!autopilot on', '!');
  assert.deepEqual(parsed, { kind: 'autopilot', scope: 'server', action: 'on' });
});

test('parse autopilot server status command', () => {
  const parsed = parseCommand('!autopilot status', '!');
  assert.deepEqual(parsed, { kind: 'autopilot', scope: 'server', action: 'status' });
});

test('parse autopilot server concurrency command', () => {
  const parsed = parseCommand('!autopilot server concurrency 3', '!');
  assert.deepEqual(parsed, {
    kind: 'autopilot',
    scope: 'server',
    action: 'concurrency',
    parallelism: 3,
  });
});

test('parse autopilot concurrency shorthand command', () => {
  const parsed = parseCommand('!autopilot concurrency 2', '!');
  assert.deepEqual(parsed, {
    kind: 'autopilot',
    scope: 'server',
    action: 'concurrency',
    parallelism: 2,
  });
});

test('parse autopilot project interval command', () => {
  const parsed = parseCommand('!autopilot project interval 30m', '!');
  assert.deepEqual(parsed, {
    kind: 'autopilot',
    scope: 'project',
    action: 'interval',
    intervalMs: 30 * 60 * 1000,
    intervalText: '30m',
  });
});

test('parse autopilot project prompt command', () => {
  const parsed = parseCommand('!autopilot project prompt 优先补测试和稳定性，不要做大功能', '!');
  assert.deepEqual(parsed, {
    kind: 'autopilot',
    scope: 'project',
    action: 'prompt',
    prompt: '优先补测试和稳定性，不要做大功能',
  });
});

test('parse autopilot project status command', () => {
  const parsed = parseCommand('!autopilot project status', '!');
  assert.deepEqual(parsed, {
    kind: 'autopilot',
    scope: 'project',
    action: 'status',
  });
});

test('parse autopilot project run command', () => {
  const parsed = parseCommand('!autopilot project run', '!');
  assert.deepEqual(parsed, {
    kind: 'autopilot',
    scope: 'project',
    action: 'run',
  });
});

test('parse model status command', () => {
  const parsed = parseCommand('!model status', '!');
  assert.deepEqual(parsed, {
    kind: 'model',
    scope: 'global',
    action: 'status',
  });
});

test('parse model set command', () => {
  const parsed = parseCommand('!model set gpt-5.5', '!');
  assert.deepEqual(parsed, {
    kind: 'model',
    scope: 'global',
    action: 'set',
    model: 'gpt-5.5',
  });
});

test('parse project model status command', () => {
  const parsed = parseCommand('!model project status', '!');
  assert.deepEqual(parsed, {
    kind: 'model',
    scope: 'project',
    action: 'status',
  });
});

test('parse project model set command', () => {
  const parsed = parseCommand('!model project set gpt-5.5', '!');
  assert.deepEqual(parsed, {
    kind: 'model',
    scope: 'project',
    action: 'set',
    model: 'gpt-5.5',
  });
});

test('parse project model clear command', () => {
  const parsed = parseCommand('!model project clear', '!');
  assert.deepEqual(parsed, {
    kind: 'model',
    scope: 'project',
    action: 'clear',
  });
});
