import test from 'node:test';
import assert from 'node:assert/strict';

import { formatHelp, formatSuccessReply } from '../src/formatters.js';

test('help text documents workspace inbox mirroring and file-send workflows', () => {
  const text = formatHelp('!');

  assert.match(text, /上传的附件会同步到绑定目录里的 `inbox\/` 子目录/);
  assert.match(text, /尽量保留原文件名/);
  assert.match(text, /把 report\.pdf 发给我/);
  assert.match(text, /!sendfile <文件名\/相对路径>/);
  assert.match(text, /!sendfile 2/);
  assert.match(text, /绝对路径/);
});

test('formatSuccessReply falls back when Codex returns blank text', () => {
  const text = formatSuccessReply(
    {
      channelId: 'channel-1',
      guildId: 'guild-1',
      projectName: 'api',
      workspacePath: '/tmp/api',
      codex: {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        search: true,
        skipGitRepoCheck: true,
        addDirs: [],
        extraConfig: [],
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    'alice',
    {
      success: true,
      exitCode: 0,
      signal: null,
      usedResume: false,
      turnCompleted: true,
      agentMessages: ['   '],
      reasoning: [],
      planItems: [],
      stderr: [],
      commands: [],
    },
  );

  assert.match(text, /Codex 没有返回文本消息/);
});
