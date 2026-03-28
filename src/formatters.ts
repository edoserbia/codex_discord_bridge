import type { AutopilotBoardChange } from './autopilot.js';
import type {
  ActiveRunState,
  CollabToolCall,
  AutopilotProjectState,
  AutopilotServiceState,
  ChannelBinding,
  ChannelRuntime,
  CodexRunResult,
  ConversationSessionState,
  DashboardBinding,
  PlanItem,
  PromptTask,
} from './types.js';

import { formatAutopilotBoardChanges, normalizeAutopilotParallelism, summarizeAutopilotBoard, stampAutopilotLine } from './autopilot.js';
import { filterDiagnosticStderr } from './codexDiagnostics.js';
import { formatClockTimestamp, formatDurationMs, sanitizeInlineCode, shortId, tailLines, truncate } from './utils.js';
import type { WebAccessUrl } from './webAccess.js';

function describeAutopilotProjectState(
  project: AutopilotProjectState,
  service: AutopilotServiceState | undefined,
): string {
  if (project.status === 'running') {
    return '运行中';
  }

  if (service?.enabled === false) {
    return '服务已暂停';
  }

  if (!project.enabled) {
    return '项目已暂停';
  }

  return '待命';
}

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

function appendPlanLines(lines: string[], planItems: PlanItem[], maxItems = 6): void {
  if (planItems.length === 0) {
    return;
  }

  lines.push('计划：');
  for (const item of planItems.slice(0, maxItems)) {
    lines.push(`- ${item.completed ? '✓' : '□'} ${truncate(item.text, 120)}`);
  }
}

function appendCollabLines(lines: string[], collabToolCalls: CollabToolCall[], maxItems = 4): void {
  if (collabToolCalls.length === 0) {
    return;
  }

  lines.push('子代理：');
  for (const item of collabToolCalls.slice(-maxItems)) {
    lines.push(`- ${truncate(formatCollabToolCallSummary(item), 150)}`);
  }
}

function appendTimelineLines(lines: string[], entries: string[], maxItems = 5): void {
  if (entries.length === 0) {
    return;
  }

  lines.push('过程：');
  for (const entry of entries.slice(-maxItems)) {
    lines.push(`- ${truncate(entry, 150)}`);
  }
}

function formatTaskSummary(task: PromptTask, maxLength = 90): string {
  const prefix = task.recovery
    ? `自动恢复(${task.recovery.strategy === 'continue-from-state' ? '续跑' : '重试'})：`
    : '';

  if (task.guidancePrompt) {
    return `${prefix}引导：${truncate(task.guidancePrompt, Math.max(24, Math.floor(maxLength / 2)))} · 原任务：${truncate(task.rootPrompt, Math.max(24, Math.floor(maxLength / 2)))}`;
  }

  return truncate(`${prefix}${task.prompt}`, maxLength);
}

function appendTaskContextLines(lines: string[], task: PromptTask, normalLabel: string, maxLength: number): void {
  if (task.recovery) {
    lines.push(`恢复模式：${task.recovery.strategy === 'continue-from-state' ? '基于当前工作区继续' : '重新执行原始提示'}`);
    lines.push(`恢复原因：${truncate(task.recovery.reason, maxLength)}`);
  }

  if (task.guidancePrompt) {
    lines.push(`当前引导：${truncate(task.guidancePrompt, maxLength)}`);
    lines.push(`原任务：${truncate(task.rootPrompt, maxLength)}`);
    return;
  }

  lines.push(`${normalLabel}：${truncate(task.prompt, maxLength)}`);
}

function shouldRenderTaskContext(activeRun: ActiveRunState): boolean {
  return activeRun.status !== 'starting' || Boolean(activeRun.codexThreadId);
}

function formatCollabToolCallSummary(item: CollabToolCall): string {
  const parts = [
    formatCollabToolStatusLabel(item.status),
    formatCollabToolLabel(item.tool),
  ];
  const receiverCount = Math.max(item.receiverThreadIds.length, Object.keys(item.agentsStates).length);
  if (receiverCount > 0) {
    parts.push(`${receiverCount} 个目标`);
  }

  const agentStateSummary = summarizeCollabAgentStates(item);
  if (agentStateSummary) {
    parts.push(agentStateSummary);
  }

  if (item.prompt) {
    parts.push(`提示：${truncate(item.prompt, 80)}`);
  }

  return parts.join(' · ');
}

function formatCollabToolLabel(tool: CollabToolCall['tool']): string {
  switch (tool) {
    case 'spawn_agent':
      return '拉起子代理';
    case 'send_input':
      return '发送指令';
    case 'wait':
      return '等待子代理';
    case 'close_agent':
      return '关闭子代理';
    default:
      return tool;
  }
}

function formatCollabToolStatusLabel(status: CollabToolCall['status']): string {
  switch (status) {
    case 'in_progress':
      return '进行中';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    default:
      return status;
  }
}

function summarizeCollabAgentStates(item: CollabToolCall): string | undefined {
  const namedStates = Object.entries(item.agentsStates)
    .map(([, state]) => formatNamedCollabAgentState(state))
    .filter((value): value is string => Boolean(value));

  if (namedStates.length > 0) {
    return namedStates.join(' · ');
  }

  const counts = new Map<string, number>();

  for (const state of Object.values(item.agentsStates)) {
    counts.set(state.status, (counts.get(state.status) ?? 0) + 1);
  }

  if (counts.size === 0) {
    return undefined;
  }

  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status} ${count}`)
    .join(' · ');
}

function formatNamedCollabAgentState(state: CollabToolCall['agentsStates'][string]): string | undefined {
  const nickname = state.nickname?.trim();
  return nickname ? `${nickname} ${state.status}` : undefined;
}

export function formatHelp(prefix: string): string {
  return [
    '🤖 **Codex Discord Bridge 帮助**',
    '',
    `- 绑定频道：\`${prefix}bind <项目名> <目录> [--sandbox ...] [--approval ...] [--search on|off]\``,
    `- 发送文件：\`${prefix}sendfile <文件名/相对路径>\``,
    `- 发送候选序号：\`${prefix}sendfile 2\``,
    `- Autopilot 用法：\`${prefix}autopilot\``,
    `- 查看状态：\`${prefix}status\``,
    `- 查看队列：\`${prefix}queue\``,
    `- 队列插入：\`${prefix}queue insert <序号>\``,
    `- Web 链接：\`${prefix}web\``,
    `- 运行中引导：\`${prefix}guide <追加指令>\``,
    `- 取消执行：\`${prefix}cancel\``,
    `- 重置会话：\`${prefix}reset\``,
    `- 解绑频道：\`${prefix}unbind\``,
    `- 查看所有项目：\`${prefix}projects\``,
    '',
    '绑定成功后，主频道和其下 Discord 线程里的普通消息都会直接作为 Codex prompt 发送。',
    '绑定后还会自动创建一个 Autopilot 项目线程；可在主频道或线程里用 `!autopilot` 查看自动迭代用法。',
    '现在会在频道里持续更新实时进度、命令执行和计划状态。',
    'Subagent 支持已默认开启；如果你还希望 Codex 把 AGENTS.md 的层级说明显式透传给子代理，可在绑定时追加 `--config features.child_agents_md=true`。',
    '如果当前任务正在运行，可用 `!guide <内容>` 插入中途引导，bridge 会中断当前步骤，先处理引导，再按同一会话继续原任务。',
    '图片附件会自动透传到 `codex -i`；上传的附件会同步到绑定目录里的 `inbox/` 子目录，普通文件也会保留一份 bridge 本地缓存。',
    '上传和发回文件时会尽量保留原文件名；只有目标位置已存在同名文件时，才会在扩展名前追加一段随机后缀。',
    '发文件给 Discord 时，默认会在绑定目录里查找；可以直接说“把 report.pdf 发给我”，也可以用 `!sendfile <文件名/相对路径>`。',
    '如果有多个匹配，bridge 会返回编号列表；你可以回复“发第 2 个”或 `!sendfile 2`。',
    '显式绝对路径只允许管理员使用，例如 `!sendfile /absolute/path/to/report.pdf`。',
    '',
    '示例：',
    `\`${prefix}bind api "/path/to/workspaces/api" --sandbox danger-full-access --approval never --search on\``,
    `\`把 report.pdf 发给我\``,
    `\`${prefix}sendfile report.pdf\``,
  ].join('\n');
}

export function formatAutopilotHelp(prefix: string): string {
  return [
    '🤖 **Autopilot 使用说明**',
    '',
    '服务级命令：作用于当前 bridge 进程里所有已绑定项目',
    `- \`${prefix}autopilot status\``,
    `- \`${prefix}autopilot server on\``,
    `- \`${prefix}autopilot server off\``,
    `- \`${prefix}autopilot server clear\``,
    `- \`${prefix}autopilot server status\``,
    `- \`${prefix}autopilot server concurrency 2\``,
    '',
    '项目级命令：只能在已绑定项目频道或它的 Autopilot 线程里使用',
    `- \`${prefix}autopilot project on\``,
    `- \`${prefix}autopilot project off\``,
    `- \`${prefix}autopilot project clear\``,
    `- \`${prefix}autopilot project status\``,
    `- \`${prefix}autopilot project run\``,
    `- \`${prefix}autopilot project interval 30m\``,
    `- \`${prefix}autopilot project prompt 优先补测试和稳定性，不要做大功能\``,
    '',
    '自然语言方向也可以直接发在项目的 Autopilot 线程里，不一定要用命令。',
    '看板规则：Autopilot 通过项目目录里的 `.codex/autopilot/board.json` 和 `docs/AUTOPILOT_BOARD.md` 持久化看板；线程总结只同步变化项。',
    '调度规则：只有服务级和项目级都开启时，项目才会按配置周期自动运行。',
    '并行规则：服务级并行数可随时调整；已运行中的 Autopilot 不会被中断，新配置立即影响后续调度。',
    '隔离规则：主频道和普通线程里的手动 Codex 会话，与 Autopilot 调度彼此独立，不互相占用运行槽。',
    '手动执行规则：`!autopilot project run` 会立即运行 1 次，并按本轮完成时间刷新下一次周期时间。',
    '时长格式支持：`30m`、`2h`、`1d`、`90m`；纯数字默认按分钟处理。',
    `兼容简写：\`${prefix}autopilot on|off|clear|concurrency 2\` 等价于服务级命令。`,
  ].join('\n');
}

export interface AutopilotServiceStatusLine {
  channelId: string;
  projectName: string;
  serviceEnabled: boolean;
  projectEnabled: boolean;
  runtimeStatus: string;
  intervalText: string;
  nextRunText: string;
  parallelism: number;
  activeAutopilotRuns: number;
}

export function formatAutopilotServiceStatus(
  lines: AutopilotServiceStatusLine[],
  generatedAt: string,
): string {
  const serviceEnabledCount = lines.filter((line) => line.serviceEnabled).length;
  const projectEnabledCount = lines.filter((line) => line.projectEnabled).length;
  const runningCount = lines.filter((line) => line.runtimeStatus === '运行中').length;
  const waitingCount = lines.filter((line) => line.runtimeStatus === '待命').length;
  const pausedCount = lines.length - runningCount - waitingCount;
  const parallelismValues = [...new Set(lines.map((line) => line.parallelism))];
  const serviceStateText = serviceEnabledCount === 0
    ? '已暂停'
    : serviceEnabledCount === lines.length
      ? '已开启'
      : '混合';

  const output = [
    stampAutopilotLine('Autopilot 服务级状态', generatedAt),
    '',
    `服务级开关：${serviceStateText}`,
    `服务并行数：${parallelismValues.length === 0 ? '-' : parallelismValues.length === 1 ? parallelismValues[0] : '混合'}`,
    `已绑定项目：${lines.length}`,
    `项目级已开启：${projectEnabledCount}/${lines.length}`,
    `运行中：${runningCount} · 待命：${waitingCount} · 暂停：${pausedCount}`,
  ];

  if (lines.length === 0) {
    output.push('', '当前 bridge 进程里还没有任何绑定项目。');
    return output.join('\n');
  }

  output.push('', '项目列表：');
  for (const line of lines) {
    output.push(
      `- <#${line.channelId}> · **${line.projectName}** · 服务=${line.serviceEnabled ? '开' : '关'} · 项目=${line.projectEnabled ? '开' : '关'} · 状态=${line.runtimeStatus} · 并行=${line.activeAutopilotRuns}/${line.parallelism} · 周期=${line.intervalText} · 下次=${line.nextRunText}`,
    );
  }

  return output.join('\n');
}

export function formatAutopilotProjectStatus(
  binding: ChannelBinding,
  project: AutopilotProjectState,
  service: AutopilotServiceState | undefined,
  options: {
    generatedAt: string;
    nextRunText: string;
    serviceParallelism: number;
    activeAutopilotRuns: number;
  },
): string {
  const lines = [
    stampAutopilotLine(`Autopilot 项目状态：**${binding.projectName}**`, options.generatedAt),
    '',
    `频道：<#${binding.channelId}>`,
    `运行状态：${describeAutopilotProjectState(project, service)}`,
    `服务开关：${service?.enabled === false ? '已暂停' : '已开启'}`,
    `服务并行数：${options.serviceParallelism}`,
    `Autopilot 运行槽：${options.activeAutopilotRuns}/${options.serviceParallelism}`,
    `项目开关：${project.enabled ? '已开启' : '已暂停'}`,
    `调度周期：${formatDurationMs(project.intervalMs)}`,
    `下次运行：${options.nextRunText}`,
  ];

  if (project.lastRunAt) {
    lines.push(`最近运行：${project.lastRunAt}`);
  }

  if (project.currentRunStartedAt) {
    lines.push(`当前轮开始：${project.currentRunStartedAt}`);
  }

  lines.push(`Prompt：${truncate(project.brief.replace(/\s+/g, ' '), 220)}`);
  lines.push(`任务看板：${summarizeAutopilotBoard(project.board)}`);

  if (project.lastSummary) {
    lines.push(`最近结果：${truncate(project.lastSummary, 220)}`);
  }

  if (project.nextSuggestedWork) {
    lines.push(`下一步建议：${truncate(project.nextSuggestedWork, 220)}`);
  }

  if (project.threadChannelId) {
    lines.push(`Autopilot 线程：<#${project.threadChannelId}>`);
  }

  return lines.join('\n');
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
    lines.push(`- 正在执行：${runtime.activeRun.task.requestedBy} · ${formatTaskSummary(runtime.activeRun.task, 90)}`);
  } else {
    lines.push('- 当前没有正在执行的任务');
  }

  if (runtime.queue.length === 0) {
    lines.push('- 等待队列为空');
  } else {
    lines.push(...runtime.queue.map((item, index) => `- #${index + 1} ${item.requestedBy} · ${formatTaskSummary(item, 90)}`));
  }

  return lines.join('\n');
}

export function formatStatus(
  binding: ChannelBinding,
  session: ConversationSessionState,
  runtime: ChannelRuntime,
  prefix: string,
  isThreadConversation: boolean,
  preferredDriver: 'legacy-exec' | 'app-server' = 'legacy-exec',
): string {
  const driverLabel = formatDriverLabel(runtime.activeRun?.driverMode ?? session.driver ?? preferredDriver, session.fallbackActive);
  const lines = [
    '🤖 **Codex Bridge 状态面板**',
    `项目：**${binding.projectName}**`,
    `目录：\`${binding.workspacePath}\``,
    `执行模式：sandbox=\`${binding.codex.sandboxMode}\` · approval=\`${binding.codex.approvalPolicy}\` · search=${binding.codex.search ? 'on' : 'off'}`,
    `驱动：${driverLabel}`,
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
    lines.push(`最近更新：${formatClockTimestamp(runtime.activeRun.updatedAt)}`);
    lines.push(`请求人：${runtime.activeRun.task.requestedBy}`);
    if (shouldRenderTaskContext(runtime.activeRun)) {
      appendTaskContextLines(lines, runtime.activeRun.task, '当前请求', 180);
    } else {
      lines.push('当前请求：已接收，正在建立 Codex 会话');
    }
    lines.push(`活动：${formatClockTimestamp(runtime.activeRun.updatedAt)} ${truncate(runtime.activeRun.latestActivity, 180)}`);

    if (runtime.activeRun.task.attachments.length > 0) {
      lines.push(`附件：${runtime.activeRun.task.attachments.length} 个`);
    }

    appendPlanLines(lines, runtime.activeRun.planItems, 5);
    appendCollabLines(lines, runtime.activeRun.collabToolCalls, 4);

    const latestReasoning = runtime.activeRun.reasoningSummaries.at(-1);
    if (latestReasoning) {
      lines.push(`分析：${truncate(latestReasoning, 180)}`);
    }

    appendTimelineLines(lines, runtime.activeRun.timeline, 4);

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
      lines.push('诊断信息：');
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

export function formatProgressMessage(
  binding: ChannelBinding,
  runtime: ChannelRuntime,
  prefix: string,
  preferredDriver: 'legacy-exec' | 'app-server' = 'app-server',
): string {
  const activeRun = runtime.activeRun;

  if (!activeRun) {
    return '⏳ 当前没有正在运行的任务。';
  }

  const lines = [
    '🛰️ **Codex 实时进度**',
    `项目：**${binding.projectName}**`,
    `请求人：${activeRun.task.requestedBy}`,
    `状态：${formatActiveStatus(runtime)}`,
    `驱动：${formatDriverLabel(activeRun.driverMode, preferredDriver === 'app-server' && activeRun.driverMode === 'legacy-exec')}`,
    `最近更新：${formatClockTimestamp(activeRun.updatedAt)}`,
    `最新活动：${formatClockTimestamp(activeRun.updatedAt)} ${truncate(activeRun.latestActivity, 180)}`,
  ];

  if (shouldRenderTaskContext(activeRun)) {
    appendTaskContextLines(lines, activeRun.task, '请求', 120);
  } else {
    lines.push('请求：已接收，正在建立 Codex 会话');
  }

  appendPlanLines(lines, activeRun.planItems, 8);
  appendCollabLines(lines, activeRun.collabToolCalls, 4);

  if (activeRun.reasoningSummaries.length > 0) {
    lines.push('分析摘要：');
    for (const summary of activeRun.reasoningSummaries.slice(-3)) {
      lines.push(`- ${truncate(summary, 160)}`);
    }
  }

  if (activeRun.agentMessages.length > 0) {
    lines.push('回复草稿：');
    for (const message of activeRun.agentMessages.slice(-2)) {
      lines.push(`- ${truncate(message, 180)}`);
    }
  }

  appendTimelineLines(lines, activeRun.timeline, 8);

  if (activeRun.currentCommand) {
    lines.push(`当前命令：\`${truncate(sanitizeInlineCode(activeRun.currentCommand), 180)}\``);
  }

  if (activeRun.lastCommandOutput) {
    lines.push('最新输出预览：');
    lines.push('```');
    lines.push(truncate(tailLines(activeRun.lastCommandOutput, 6), 500));
    lines.push('```');
  }

  if (activeRun.stderr.length > 0) {
    lines.push('最新诊断：');
    lines.push('```');
    lines.push(truncate(tailLines(activeRun.stderr.join('\n'), 5), 360));
    lines.push('```');
  }

  lines.push(`控制：\`${prefix}status\` · \`${prefix}queue\` · \`${prefix}cancel\``);
  lines.push('说明：这条消息会持续更新，最终结果仍会单独回复。');

  return truncate(lines.join('\n'), 1900);
}

function formatDriverLabel(driver: 'legacy-exec' | 'app-server', fallbackActive: boolean | undefined): string {
  return `${driver}${fallbackActive && driver === 'legacy-exec' ? '（fallback）' : ''}`;
}

export function formatWebAccessLinks(urls: WebAccessUrl[]): string {
  if (urls.length === 0) {
    return '🌐 Web 面板当前没有可用访问地址。';
  }

  return [
    '🌐 **Web 面板访问链接**',
    '',
    ...urls.map((entry) => `- ${entry.label}：${entry.url}`),
  ].join('\n');
}

export function formatSuccessReply(
  binding: ChannelBinding,
  requestedBy: string,
  result: CodexRunResult,
  options: { finalMessage?: string } = {},
): string {
  const finalMessage = options.finalMessage ?? result.agentMessages.at(-1) ?? '本轮已完成，但 Codex 没有返回文本消息。';

  return [
    `🤖 **${binding.projectName}** · ${requestedBy}`,
    finalMessage,
  ].join('\n\n');
}

export function formatFailureReply(binding: ChannelBinding, requestedBy: string, result: CodexRunResult): string {
  const diagnosticStderr = filterDiagnosticStderr(result.stderr);
  const stderrTail = diagnosticStderr.length > 0
    ? tailLines(diagnosticStderr.join('\n'), 10)
    : result.stderr.length > 0
      ? '没有捕获到可诊断信息；已过滤已知无害 warning。'
      : '没有捕获到诊断信息。';
  const lastAgentMessage = result.agentMessages.at(-1);
  const lines = [
    `❌ **${binding.projectName}** · ${requestedBy}`,
    `执行失败，exitCode=${result.exitCode ?? 'null'} signal=${result.signal ?? 'null'}`,
  ];

  if (lastAgentMessage) {
    lines.push('', `最后一条模型消息：${truncate(lastAgentMessage, 400)}`);
  }

  lines.push('', '诊断信息：', '```', truncate(stderrTail, 900), '```', '', '如果是会话损坏，可发送 `!reset` 后重试。');
  return lines.join('\n');
}

export function formatAutopilotEntryCard(
  binding: ChannelBinding,
  project: AutopilotProjectState,
  service: AutopilotServiceState | undefined,
): string {
  const updatedAt = [project.lastActivityAt, project.briefUpdatedAt, service?.updatedAt]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? project.briefUpdatedAt;
  const lines = [
    '🤖 **Autopilot 入口**',
    `项目：**${binding.projectName}**`,
    `运行状态：${describeAutopilotProjectState(project, service)}`,
    `服务开关：${service?.enabled === false ? '已暂停' : '已开启'}`,
    `服务并行数：${normalizeAutopilotParallelism(service?.parallelism)}`,
    `项目开关：${project.enabled ? '已开启' : '已暂停'}`,
    `调度周期：${formatDurationMs(project.intervalMs)}`,
    `更新时间：${formatClockTimestamp(updatedAt)}`,
    `Prompt：${truncate(project.brief.replace(/\s+/g, ' '), 150)}`,
    `任务看板：${summarizeAutopilotBoard(project.board)}`,
  ];

  if (project.threadChannelId) {
    lines.push(`Autopilot 线程：<#${project.threadChannelId}>`);
  }

  if (project.lastSummary) {
    lines.push(`最近结果：${truncate(project.lastSummary, 160)}`);
  }

  if (project.nextSuggestedWork) {
    lines.push(`下一步建议：${truncate(project.nextSuggestedWork, 160)}`);
  }

  lines.push('说明：主频道保留这条入口消息；自动迭代的详细过程和自然语言方向，都在线程里进行。');
  return truncate(lines.join('\n'), 1900);
}

export function formatAutopilotThreadWelcome(binding: ChannelBinding, project: AutopilotProjectState): string {
  return [
    stampAutopilotLine(`已创建 **${binding.projectName}** 的 Autopilot 线程。`),
    '',
    '这个线程只做两件事：',
    '- 接收当前项目的 Autopilot Prompt 自然语言',
    '- 展示每一轮自动迭代的实时进度和总结',
    '',
    '常用命令：',
    '- !autopilot project on',
    '- !autopilot project status',
    '- !autopilot project run',
    '- !autopilot project interval 30m',
    '- !autopilot project prompt 优先补测试和稳定性，不要做大功能',
    '- !autopilot server concurrency 2',
    '',
    '你可以直接发送类似下面的自然语言：',
    '- 优先补测试和稳定性，不要做大功能',
    '- 先处理会话恢复和绑定重置，部署脚本先不要动',
    '- 可以做围绕绑定体验的小功能，但权限模型先只提建议',
    '',
    `当前项目开关：${project.enabled ? '已开启' : '已暂停'}`,
    `当前调度周期：${formatDurationMs(project.intervalMs)}`,
    `当前 Prompt：${project.brief}`,
  ].join('\n');
}

export function formatAutopilotBriefAck(project: AutopilotProjectState): string {
  return [
    stampAutopilotLine('已更新当前项目的 Autopilot Prompt。'),
    '',
    '当前 Prompt：',
    project.brief,
    '',
    `当前项目开关：${project.enabled ? '已开启' : '已暂停'}`,
    `当前调度周期：${formatDurationMs(project.intervalMs)}`,
    `当前任务看板：${summarizeAutopilotBoard(project.board)}`,
    '新的要求会在下一次 Autopilot 周期生效。',
  ].join('\n');
}

export function formatAutopilotServiceAck(
  action: 'on' | 'off' | 'clear' | 'concurrency',
  parallelism?: number,
): string {
  switch (action) {
    case 'on':
      return `${stampAutopilotLine('已开启当前 bridge 进程里所有已绑定项目的服务级 Autopilot。')}\n\n项目仍需单独执行 \`!autopilot project on\` 才会按周期运行。`;
    case 'off':
      return `${stampAutopilotLine('已暂停当前 bridge 进程里所有已绑定项目的服务级 Autopilot。')}\n\n不会启动新的自动迭代任务。`;
    case 'clear':
      return `${stampAutopilotLine('已清空当前 bridge 进程里所有已绑定项目的 Autopilot 任务看板和历史状态。')}\n\nPrompt、项目开关和调度周期会保留。`;
    case 'concurrency':
      return `${stampAutopilotLine(`已将当前 bridge 进程里所有已绑定项目的服务级 Autopilot 并行数设置为 ${parallelism ?? normalizeAutopilotParallelism(undefined)}。`)}\n\n新并行数会立即影响后续调度；已运行中的 Autopilot 不会被中断，主项目手动 Codex 也不会受影响。`;
  }
}

export function formatAutopilotProjectAck(
  action: 'on' | 'off' | 'clear' | 'status' | 'run' | 'interval' | 'prompt',
  binding: ChannelBinding,
  project: AutopilotProjectState,
): string {
  const lines = [stampAutopilotLine(`已更新 **${binding.projectName}** 的项目级 Autopilot 设置。`), ''];

  switch (action) {
    case 'on':
      lines.push('项目级开关：已开启');
      break;
    case 'off':
      lines.push('项目级开关：已暂停');
      break;
    case 'clear':
      lines.push('已清空该项目的 Autopilot 看板和历史状态');
      break;
    case 'run':
      lines.push('已触发当前项目立即执行 1 次 Autopilot');
      if (project.threadChannelId) {
        lines.push(`执行线程：<#${project.threadChannelId}>`);
      }
      lines.push('下一次周期会按本轮完成时间重新计算');
      break;
    case 'status':
      break;
    case 'interval':
      lines.push(`调度周期：${formatDurationMs(project.intervalMs)}`);
      break;
    case 'prompt':
      lines.push('已更新项目的 Autopilot Prompt');
      lines.push(`Prompt：${truncate(project.brief.replace(/\s+/g, ' '), 220)}`);
      break;
  }

  if (action !== 'on' && action !== 'off' && action !== 'status') {
    lines.push(`项目级开关：${project.enabled ? '已开启' : '已暂停'}`);
  }

  if (action !== 'interval' && action !== 'status') {
    lines.push(`调度周期：${formatDurationMs(project.intervalMs)}`);
  }

  if (action !== 'status') {
    lines.push(`任务看板：${summarizeAutopilotBoard(project.board)}`);
  }
  return lines.join('\n');
}

export function formatAutopilotKickoff(
  binding: ChannelBinding,
  project: AutopilotProjectState,
): string {
  return [
    stampAutopilotLine(`Autopilot 已启动：**${binding.projectName}**`),
    '',
    `Prompt：${truncate(project.brief.replace(/\s+/g, ' '), 240)}`,
    `任务看板：${summarizeAutopilotBoard(project.board)}`,
    '说明：下面会持续同步本轮计划、命令、输出和最终结果。',
  ].join('\n');
}

export function formatAutopilotRunSummary(
  binding: ChannelBinding,
  project: AutopilotProjectState,
  boardChanges: AutopilotBoardChange[] = [],
  boardSyncError?: string,
): string {
  const lines = [
    stampAutopilotLine(`Autopilot 本轮结束：**${binding.projectName}**`),
    '',
    `结果：${project.lastResultStatus ?? 'unknown'}`,
  ];

  if (project.lastSummary) {
    lines.push(`完成情况：${project.lastSummary}`);
  }

  if (project.nextSuggestedWork) {
    lines.push(`下一步建议：${project.nextSuggestedWork}`);
  }

  lines.push('看板变化：');
  lines.push(...formatAutopilotBoardChanges(boardChanges));
  lines.push(`任务看板：${summarizeAutopilotBoard(project.board)}`);

  if (boardSyncError) {
    lines.push(`看板同步：${boardSyncError}`);
  }

  return lines.join('\n');
}

export function formatAutopilotSkipNotice(binding: ChannelBinding, reason: string): string {
  return [
    stampAutopilotLine(`Autopilot 跳过：**${binding.projectName}**`),
    '',
    `原因：${reason}`,
  ].join('\n');
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
