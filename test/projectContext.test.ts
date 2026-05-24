import test from 'node:test';
import assert from 'node:assert/strict';

import { appendBridgeProjectContext, buildBridgeProjectContext, DEFAULT_SELF_HOSTED_GITLAB_URL } from '../src/projectContext.js';

import type { ChannelBinding } from '../src/types.js';

const binding: ChannelBinding = {
  channelId: 'channel-1',
  guildId: 'guild-1',
  projectName: 'api',
  workspacePath: '/tmp/workspace',
  codex: {
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    search: true,
    skipGitRepoCheck: true,
    addDirs: [],
    extraConfig: [],
  },
  createdAt: '2026-05-24T00:00:00.000Z',
  updatedAt: '2026-05-24T00:00:00.000Z',
};

test('buildBridgeProjectContext documents the self-hosted GitLab host', () => {
  const context = buildBridgeProjectContext(binding);

  assert.match(context, /自建 GitLab/);
  assert.match(context, new RegExp(DEFAULT_SELF_HOSTED_GITLAB_URL.replace(/\./g, '\\.')));
  assert.match(context, /api/);
  assert.match(context, /\/tmp\/workspace/);
});

test('appendBridgeProjectContext preserves the user prompt before bridge context', () => {
  const prompt = appendBridgeProjectContext('[app-rich] show me live progress', binding);

  assert.match(prompt, /^\[app-rich\] show me live progress/);
  assert.match(prompt, /自建 GitLab/);
  assert.match(prompt, /https:\/\/mytokens\.live/);
});

test('buildBridgeProjectContext allows overriding the self-hosted GitLab host by env', () => {
  const previous = process.env.SELF_HOSTED_GITLAB_URL;
  process.env.SELF_HOSTED_GITLAB_URL = 'https://git.example.test';

  try {
    assert.match(buildBridgeProjectContext(binding), /https:\/\/git\.example\.test/);
  } finally {
    if (previous === undefined) {
      delete process.env.SELF_HOSTED_GITLAB_URL;
    } else {
      process.env.SELF_HOSTED_GITLAB_URL = previous;
    }
  }
});
