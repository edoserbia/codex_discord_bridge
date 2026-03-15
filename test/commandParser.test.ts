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

test('reject unknown flag', () => {
  assert.throws(() => parseCommand('!bind api /tmp --unknown nope', '!'), /未知参数/);
});

test('reject invalid sandbox mode', () => {
  assert.throws(() => parseCommand('!bind api /tmp --sandbox unsafe', '!'), /sandbox/);
});

test('parse autopilot command', () => {
  const parsed = parseCommand('!autopilot on', '!');
  assert.deepEqual(parsed, { kind: 'autopilot', action: 'on' });
});
