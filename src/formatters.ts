import type { ChannelBinding, ChannelRuntime, CodexRunResult, ConversationSessionState, DashboardBinding } from './types.js';

import { sanitizeInlineCode, shortId, tailLines, truncate } from './utils.js';

function formatActiveStatus(runtime: ChannelRuntime): string {
  if (runtime.activeRun) {
    switch (runtime.activeRun.status) {
      case 'starting':
        return '启动中';
      case 'running':
        return '运行中';
      case 'completed':
        return '已完成';
      case 'failed':
        return '失败';
      case 'cancelled':
        return '已取消';
      default:
        return '处理中';
    }
  }

  if (runtime.queue.length > 0) {
    return '排队中';
  }

  return '空闲';
}

export function formatHelp(prefix: string): string {
  return [
    '🤖 **Codex Discord Bridge 帮助**',
    '',
    `- 绑定频道：\`${prefix}bind <项目名> <目录> [--sandbox ...] [--approval ...] [--search on|off]\``,
    `- 查看状态：\`${prefix}status\``,
    `- 查看队列：\`${prefix}queue\``,
    `- 取消执行：\`${prefix}cancel\``,
    `- 重置会话：\`${prefix}reset\``,
    `- 解绑频道：\`${prefix}unbind\``,
    `- 查看所有项目：\`${prefix}projects\``,
    '',
    '绑定成功后，主频道和其下 Discord 线程里的普通消息都会直接作为 Codex prompt 发送。',
    '图片附件会自动透传到 `codex -i`，普通文件会下载到本地附件目录供 Codex 读取。',
    '',
    '示例：',
    `\`${prefix}bind api "/Users/mac/work/api" --sandbox workspace-write --approval never --search off\``,
  ].join('\n');
}

export function formatProjects(bindings: ChannelBinding[]): string {
  if (bindings.length === 0) {
    return '当前服务器还没有任何频道绑定项目。';
  }

  return [
    '📦 **当前服务器项目映射**',
    '',
    ...bindings.map((binding) => `- <#${binding.channelId}> → **${binding.projectName}** · \`${binding.workspacePath}\``),
  ].join('\n');
}

export function formatQueue(runtime: ChannelRuntime): string {
  const lines = ['🧵 **当前会话队列**', ''];

  if (runtime.activeRun) {
    lines.push(`- 正在执行：${runtime.activeRun.task.requestedBy} · ${truncate(runtime.activeRun.task.prompt, 90)}`);
  } else {
    lines.push('- 当前没有正在执行的任务');
  }

  if (runtime.queue.length === 0) {
    lines.push('- 等待队列为空');
  } else {
    lines.push(...runtime.queue.map((item, index) => `- #${index + 1} ${item.requestedBy} · ${truncate(item.prompt, 90)}`));
  }

  return lines.join('\n');
}

export function formatStatus(
  binding: ChannelBinding,
  session: ConversationSessionState,
  runtime: ChannelRuntime,
  prefix: string,
  isThreadConversation: boolean,
): string {
  const lines = [
    '🤖 **Codex Bridge 状态面板**',
    `项目：**${binding.projectName}**`,
    `目录：\`${binding.workspacePath}\``,
    `会话类型：${isThreadConversation ? 'Discord 线程会话' : '频道主会话'}`,
    `状态：${formatActiveStatus(runtime)}`,
    `Codex 会话：${session.codexThreadId ? `\`${shortId(session.codexThreadId)}\`` : '未建立'}`,
    `队列：${runtime.queue.length}`,
  ];

  if (session.lastRunAt) {
    const lastPromptBy = session.lastPromptBy ? ` · ${session.lastPromptBy}` : '';
    lines.push(`最近请求：${session.lastRunAt}${lastPromptBy}`);
  }

  if (runtime.activeRun) {
    lines.push(`当前请求：${runtime.activeRun.task.requestedBy}`);
    lines.push(`活动：${truncate(runtime.activeRun.latestActivity, 180)}`);

    if (runtime.activeRun.task.attachments.length > 0) {
      lines.push(`附件：${runtime.activeRun.task.attachments.length} 个`);
    }

    if (runtime.activeRun.currentCommand) {
      lines.push(`命令：\`${truncate(sanitizeInlineCode(runtime.activeRun.currentCommand), 180)}\``);
    }

    if (runtime.activeRun.lastCommandOutput) {
      lines.push('输出预览：');
      lines.push('```');
      lines.push(truncate(tailLines(runtime.activeRun.lastCommandOutput, 6), 450));
      lines.push('```');
    }

    if (runtime.activeRun.stderr.length > 0) {
      lines.push('stderr：');
      lines.push('```');
      lines.push(truncate(tailLines(runtime.activeRun.stderr.join('\n'), 4), 320));
      lines.push('```');
    }
  } else {
    lines.push('发送普通消息即可继续和当前项目会话。');
  }

  lines.push(`控制：\`${prefix}status\` · \`${prefix}queue\` · \`${prefix}cancel\` · \`${prefix}reset\` · \`${prefix}unbind\``);
  return truncate(lines.join('\n'), 1900);
}

export function formatSuccessReply(binding: ChannelBinding, requestedBy: string, result: CodexRunResult): string {
  const finalMessage = result.agentMessages.at(-1) ?? '本轮已完成，但 Codex 没有返回文本消息。';

  return [
    `🤖 **${binding.projectName}** · ${requestedBy}`,
    finalMessage,
  ].join('\n\n');
}

export function formatFailureReply(binding: ChannelBinding, requestedBy: string, result: CodexRunResult): string {
  const stderrTail = result.stderr.length > 0 ? tailLines(result.stderr.join('\n'), 10) : '没有捕获到 stderr。';
  const lastAgentMessage = result.agentMessages.at(-1);
  const lines = [
    `❌ **${binding.projectName}** · ${requestedBy}`,
    `执行失败，exitCode=${result.exitCode ?? 'null'} signal=${result.signal ?? 'null'}`,
  ];

  if (lastAgentMessage) {
    lines.push('', `最后一条模型消息：${truncate(lastAgentMessage, 400)}`);
  }

  lines.push('', 'stderr：', '```', truncate(stderrTail, 900), '```', '', '如果是会话损坏，可发送 `!reset` 后重试。');
  return lines.join('\n');
}

export function formatDashboardHtml(data: DashboardBinding[]): string {
  const rows = data.map(({ binding, conversations }) => {
    const conversationRows = conversations.length > 0
      ? conversations.map((conversation) => `
        <tr>
          <td>${conversation.conversationId}</td>
          <td>${conversation.status}</td>
          <td>${conversation.queueLength}</td>
          <td>${conversation.lastPromptBy ?? ''}</td>
          <td>${conversation.lastRunAt ?? ''}</td>
          <td>${conversation.codexThreadId ? shortId(conversation.codexThreadId) : ''}</td>
        </tr>`).join('')
      : '<tr><td colspan="6">暂无会话</td></tr>';

    return `
      <section class="card">
        <h2>${binding.projectName}</h2>
        <p><strong>频道:</strong> ${binding.channelId}</p>
        <p><strong>目录:</strong> <code>${binding.workspacePath}</code></p>
        <table>
          <thead>
            <tr><th>Conversation</th><th>Status</th><th>Queue</th><th>User</th><th>Last Run</th><th>Codex</th></tr>
          </thead>
          <tbody>${conversationRows}</tbody>
        </table>
      </section>`;
  }).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Codex Discord Bridge</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 24px; background: #0b1020; color: #eef2ff; }
    h1 { margin-bottom: 8px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 16px; }
    .card { background: #111831; border-radius: 14px; padding: 16px; border: 1px solid #24304f; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid #24304f; font-size: 14px; }
    input, button { padding: 10px 12px; border-radius: 10px; border: 1px solid #314167; background: #0f1730; color: #eef2ff; }
    form { display: grid; grid-template-columns: 1fr 1fr 2fr auto; gap: 12px; margin: 20px 0; }
    code { color: #9ac7ff; }
    .muted { color: #9aa7c7; }
  </style>
</head>
<body>
  <h1>Codex Discord Bridge 面板</h1>
  <p class="muted">创建/查看 Discord 频道到项目目录的映射，并查看当前会话运行状态。</p>
  <form id="bind-form">
    <input name="channelId" placeholder="Discord 频道 ID" required />
    <input name="projectName" placeholder="项目名" required />
    <input name="workspacePath" placeholder="项目目录绝对路径" required />
    <button type="submit">绑定</button>
  </form>
  <div class="grid">${rows || '<div class="card">暂无绑定</div>'}</div>
  <script>
    const form = document.getElementById('bind-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      const payload = Object.fromEntries(formData.entries());
      const response = await fetch('/api/bindings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const text = await response.text();
        alert(text);
        return;
      }
      location.reload();
    });
  </script>
</body>
</html>`;
}
