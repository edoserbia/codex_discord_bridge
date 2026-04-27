import test from 'node:test';
import assert from 'node:assert/strict';

import { formatHelp, formatProgressMessage, formatSuccessReply } from '../src/formatters.js';

test('help text documents workspace inbox mirroring and file-send workflows', () => {
  const text = formatHelp('!');

  assert.match(text, /上传的附件会同步到绑定目录里的 `inbox\/` 子目录/);
  assert.match(text, /尽量保留原文件名/);
  assert.match(text, /把 report\.pdf 发给我/);
  assert.match(text, /!sendfile <文件名\/相对路径>/);
  assert.match(text, /!sendfile 2/);
  assert.match(text, /绝对路径/);
  assert.match(text, /!model status/);
  assert.match(text, /!model set gpt-5\.5/);
  assert.match(text, /!model project set gpt-5\.5/);
  assert.match(text, /!model project clear/);
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

test('formatSuccessReply adds a clear final-summary divider', () => {
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
      agentMessages: ['完成了修复，并补了验证。'],
      reasoning: [],
      planItems: [],
      stderr: [],
      commands: [],
    },
  );

  assert.match(text, /={8,} 最终总结 ={8,}/);
  assert.match(text, /🤖 \*\*api\*\* · alice/);
});

test('formatProgressMessage adds a clear process divider', () => {
  const text = formatProgressMessage(
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
    {
      conversationId: 'channel-1',
      queue: [],
      pendingReplies: [],
      activeRun: {
        task: {
          id: 'task-1',
          prompt: '修一下 bridge 的消息排版',
          effectivePrompt: '修一下 bridge 的消息排版',
          rootPrompt: '修一下 bridge 的消息排版',
          rootEffectivePrompt: '修一下 bridge 的消息排版',
          requestedBy: 'alice',
          requestedById: 'user-1',
          messageId: 'message-1',
          enqueuedAt: '2026-01-01T00:00:00.000Z',
          bindingChannelId: 'channel-1',
          conversationId: 'channel-1',
          attachments: [],
          extraAddDirs: [],
          origin: 'user',
        },
        driverMode: 'app-server',
        status: 'running',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        latestActivity: '正在整理进度和最终结果的显示边界',
        agentMessages: ['我先补测试，再改格式化函数。'],
        reasoningSummaries: [],
        planItems: [],
        collabToolCalls: [],
        timeline: ['[08:00] 🔄 正在整理消息结构'],
        stderr: [],
        usedResume: false,
      },
    },
    '!',
  );

  assert.match(text, /-{8,} 过程进度 -{8,}/);
  assert.match(text, /🛰️ \*\*Codex 实时进度\*\*/);
});

test('formatProgressMessage keeps the newest live draft visible when content is long', () => {
  const text = formatProgressMessage(
    {
      channelId: 'channel-1',
      guildId: 'guild-1',
      projectName: 'api'.repeat(80),
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
    {
      conversationId: 'channel-1',
      queue: [],
      pendingReplies: [],
      activeRun: {
        task: {
          id: 'task-1',
          prompt: '这是一个很长的用户请求。'.repeat(80),
          effectivePrompt: '这是一个很长的用户请求。'.repeat(80),
          rootPrompt: '这是一个很长的用户请求。'.repeat(80),
          rootEffectivePrompt: '这是一个很长的用户请求。'.repeat(80),
          requestedBy: 'alice'.repeat(40),
          requestedById: 'user-1',
          messageId: 'message-1',
          enqueuedAt: '2026-01-01T00:00:00.000Z',
          bindingChannelId: 'channel-1',
          conversationId: 'channel-1',
          attachments: [],
          extraAddDirs: [],
          origin: 'user',
        },
        driverMode: 'app-server',
        status: 'running',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        latestActivity: '正在持续生成回复草稿'.repeat(40),
        agentMessages: ['旧回复草稿', 'LATEST-LIVE-DRAFT 当前最新回复草稿必须保留'],
        reasoningSummaries: [
          '分析摘要一。'.repeat(80),
          '分析摘要二。'.repeat(80),
          '分析摘要三。'.repeat(80),
        ],
        planItems: Array.from({ length: 8 }, (_, index) => ({
          id: `plan-${index}`,
          text: `计划项 ${index} `.repeat(40),
          completed: index < 2,
        })),
        collabToolCalls: [],
        timeline: Array.from({ length: 8 }, (_, index) => `[08:0${index}] ${'过程记录 '.repeat(40)}`),
        stderr: [],
        usedResume: false,
      },
    },
    '!',
  );

  assert.match(text, /LATEST-LIVE-DRAFT/);
});
