import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAutopilotBindingTarget } from '../src/autopilotControl.js';
import type { ChannelBinding } from '../src/types.js';

function createBinding(channelId: string, projectName: string, workspacePath: string): ChannelBinding {
  return {
    channelId,
    guildId: 'guild-1',
    projectName,
    workspacePath,
    codex: {
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      search: true,
      skipGitRepoCheck: true,
      addDirs: [],
      extraConfig: [],
    },
    createdAt: '2026-03-28T00:00:00.000Z',
    updatedAt: '2026-03-28T00:00:00.000Z',
  };
}

test('resolveAutopilotBindingTarget prefers explicit channel id', () => {
  const bindings = [
    createBinding('channel-api', 'api', '/tmp/work/api'),
    createBinding('channel-web', 'web', '/tmp/work/web'),
  ];

  const resolution = resolveAutopilotBindingTarget(bindings, {
    channelId: 'channel-web',
    projectName: 'api',
    cwd: '/tmp/work/api',
  });

  assert.equal(resolution.ok, true);
  if (!resolution.ok) {
    return;
  }

  assert.equal(resolution.binding.channelId, 'channel-web');
  assert.equal(resolution.mode, 'channel');
});

test('resolveAutopilotBindingTarget resolves by explicit project name', () => {
  const bindings = [
    createBinding('channel-api', 'api', '/tmp/work/api'),
    createBinding('channel-web', 'web', '/tmp/work/web'),
  ];

  const resolution = resolveAutopilotBindingTarget(bindings, {
    projectName: 'api',
  });

  assert.equal(resolution.ok, true);
  if (!resolution.ok) {
    return;
  }

  assert.equal(resolution.binding.channelId, 'channel-api');
  assert.equal(resolution.mode, 'project');
});

test('resolveAutopilotBindingTarget resolves cwd by longest matching workspace prefix', () => {
  const bindings = [
    createBinding('channel-root', 'root', '/tmp/work'),
    createBinding('channel-api', 'api', '/tmp/work/api'),
  ];

  const resolution = resolveAutopilotBindingTarget(bindings, {
    cwd: '/tmp/work/api/src/components',
  });

  assert.equal(resolution.ok, true);
  if (!resolution.ok) {
    return;
  }

  assert.equal(resolution.binding.channelId, 'channel-api');
  assert.equal(resolution.mode, 'cwd');
});

test('resolveAutopilotBindingTarget reports ambiguous project names', () => {
  const bindings = [
    createBinding('channel-api-a', 'api', '/tmp/work/api-a'),
    createBinding('channel-api-b', 'api', '/tmp/work/api-b'),
  ];

  const resolution = resolveAutopilotBindingTarget(bindings, {
    projectName: 'api',
  });

  assert.equal(resolution.ok, false);
  if (resolution.ok) {
    return;
  }

  assert.equal(resolution.code, 'ambiguous_target');
  assert.match(resolution.message, /多个绑定项目/);
  assert.deepEqual(
    resolution.candidates.map((candidate) => candidate.channelId),
    ['channel-api-a', 'channel-api-b'],
  );
});

test('resolveAutopilotBindingTarget requires an explicit target or cwd match for project commands', () => {
  const bindings = [
    createBinding('channel-api', 'api', '/tmp/work/api'),
  ];

  const resolution = resolveAutopilotBindingTarget(bindings, {});

  assert.equal(resolution.ok, false);
  if (resolution.ok) {
    return;
  }

  assert.equal(resolution.code, 'target_required');
  assert.match(resolution.message, /需要提供 `--project`、`--channel`，或在已绑定项目目录中执行/);
});
