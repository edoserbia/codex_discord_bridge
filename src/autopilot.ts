import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  AutopilotBoardItem,
  AutopilotBoardStatus,
  AutopilotProjectState,
  ChannelBinding,
} from './types.js';

import { formatClockTimestamp, summarizeReasoningText, truncate } from './utils.js';

const AUTOPILOT_MARKER = 'AUTOPILOT_REPORT';
const BRIDGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUTOPILOT_BOARD_STATUSES = ['ready', 'doing', 'blocked', 'done', 'deferred'] as const;

export const AUTOPILOT_THREAD_NAME_PREFIX = 'Autopilot · ';
export const DEFAULT_AUTOPILOT_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_AUTOPILOT_PARALLELISM = 5;
export const AUTOPILOT_BOARD_RELATIVE_PATH = path.join('.codex', 'autopilot', 'board.json');
export const AUTOPILOT_BOARD_MARKDOWN_RELATIVE_PATH = path.join('docs', 'AUTOPILOT_BOARD.md');
export const DEFAULT_AUTOPILOT_BRIEF = [
  '默认方向：优先测试覆盖、稳定性、低风险修复和小范围清理。',
  '默认边界：不要主动做大功能、不要改部署/权限模型、不要升级依赖。',
  '如果发现更大的机会，先放进任务看板，不要直接执行。',
].join('\n');

export interface AutopilotReport {
  goal: string;
  summary: string;
  next: string;
  board?: Partial<Record<AutopilotBoardStatus, string[]>> | undefined;
}

export interface AutopilotBoardDocument {
  version: 1;
  updatedAt: string;
  items: AutopilotBoardItem[];
}

export interface AutopilotBoardChange {
  kind: 'added' | 'removed' | 'moved' | 'updated';
  itemId: string;
  title: string;
  fromStatus?: AutopilotBoardStatus | undefined;
  toStatus?: AutopilotBoardStatus | undefined;
  previousTitle?: string | undefined;
  previousNotes?: string | undefined;
  nextNotes?: string | undefined;
}

export function getAutopilotTickMs(): number {
  const parsed = Number.parseInt(process.env.AUTOPILOT_TICK_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 5_000 ? parsed : 10_000;
}

export function getAutopilotDefaultIntervalMs(): number {
  const parsed = Number.parseInt(process.env.AUTOPILOT_DEFAULT_INTERVAL_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AUTOPILOT_INTERVAL_MS;
}

export function normalizeAutopilotParallelism(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_AUTOPILOT_PARALLELISM;
}

export function getAutopilotSkillPath(): string {
  return path.join(BRIDGE_ROOT, 'skills', 'autopilot-governor', 'SKILL.md');
}

export function getAutopilotSkillDir(): string {
  return path.dirname(getAutopilotSkillPath());
}

export function getAutopilotBoardCtlPath(): string {
  return path.join(getAutopilotSkillDir(), 'scripts', 'boardctl.mjs');
}

export function getAutopilotBoardJsonPath(workspacePath: string): string {
  return path.join(workspacePath, AUTOPILOT_BOARD_RELATIVE_PATH);
}

export function getAutopilotBoardMarkdownPath(workspacePath: string): string {
  return path.join(workspacePath, AUTOPILOT_BOARD_MARKDOWN_RELATIVE_PATH);
}

export function getAutopilotThreadName(projectName: string): string {
  return `${AUTOPILOT_THREAD_NAME_PREFIX}${projectName}`;
}

export function buildAutopilotPrompt(binding: ChannelBinding, project: AutopilotProjectState): string {
  const board = summarizeBoardForPrompt(project.board);
  const skillPath = getAutopilotSkillPath();
  const boardCtlPath = getAutopilotBoardCtlPath();
  const boardJsonPath = getAutopilotBoardJsonPath(binding.workspacePath);
  const boardMarkdownPath = getAutopilotBoardMarkdownPath(binding.workspacePath);

  return [
    '系统提示：你正在作为 Discord Bridge 的项目 Autopilot 运行。',
    '你的任务不是自由发挥，而是在当前项目里做一次低风险、可验证、可汇报的自动迭代。',
    '',
    `项目：${binding.projectName}`,
    `目录：${binding.workspacePath}`,
    `当前时间：${new Date().toISOString()}`,
    '',
    '先阅读并遵守这个治理规则文件：',
    skillPath,
    '',
    '看板脚本：',
    boardCtlPath,
    `看板 JSON：${boardJsonPath}`,
    `看板文档：${boardMarkdownPath}`,
    '',
    '如果规则文件不可读，则继续执行，但仍必须遵守下面这些核心要求：',
    '- 默认聚焦 1 个主任务；如果同一链路下有紧密相关的多个验证或小修复，可以作为同一任务一起完成。',
    '- 优先测试、稳定性、低风险修复和小范围清理。',
    '- 如果用户自然语言明确允许小功能，才可以做小功能；否则不要主动扩功能。',
    '- 如果改动风险高、边界不清或需要产品判断，就不要落地，把它写进任务看板。',
    '- 完成后必须运行必要验证；验证失败不能伪装成完成。',
    '- 任务看板只能通过 boardctl 脚本维护；不要只在最终总结里口头描述看板变化。',
    '',
    '当前 Prompt：',
    project.brief.trim() || DEFAULT_AUTOPILOT_BRIEF,
    '',
    '当前任务看板：',
    board,
    '',
    '开始前先执行这些命令读取并维护看板：',
    `- node "${boardCtlPath}" ensure --json`,
    `- node "${boardCtlPath}" status --json`,
    `- node "${boardCtlPath}" list --json`,
    '',
    '任务选择与执行规则：',
    `1. 如果有合适的 doing 项，优先继续推进或明确转成 blocked / done。`,
    `2. 如果有合适的 ready 项，先用 node "${boardCtlPath}" move "<任务标题或ID>" doing 把它转到 doing，再执行。`,
    `3. 如果没有合适的 ready 项，就根据当前 Prompt 和仓库现状新建一个 ready 任务，再立刻转到 doing 并继续执行，不要停在“只建任务不做”。`,
    `4. 完成后把 doing 项转成 done；如果受阻，就转成 blocked；如果发现下一轮合适的新方向，就补到 ready 或 deferred。`,
    `5. 每次修改看板后，boardctl 会自动同步 ${AUTOPILOT_BOARD_MARKDOWN_RELATIVE_PATH}，结束前仍要确认文档已更新。`,
    '',
    '执行步骤：',
    '1. 先读取当前看板和最近相关上下文。',
    '2. 给出一个简短计划。',
    '3. 按照上面的规则选择或创建任务，并用 boardctl 更新状态。',
    '4. 实施改动。',
    '5. 运行必要验证。',
    '6. 用自然语言总结结果。',
    `6. 最后一条模型消息必须包含 ${AUTOPILOT_MARKER} JSON 代码块，格式如下：`,
    '```json',
    JSON.stringify({
      goal: '本轮实际执行的任务标题',
      summary: '本轮完成情况，1-3 句',
      next: '下一步建议，1 句',
      board: {
        ready: ['下一轮可做的事项'],
        doing: ['本轮结束后仍未完成的事项，可为空'],
        blocked: ['当前受阻事项'],
        done: ['本轮或已确认完成事项'],
        deferred: ['明确延后事项'],
      },
    }, null, 2),
    '```',
    '',
    '要求：',
    '- JSON 必须有效。',
    '- goal / summary / next 必填。',
    '- board 可以作为冗余摘要返回，但真实看板状态以 boardctl 写入的 JSON 和文档为准。',
    '- 如果你没有先执行 boardctl 更新真实看板，就不要声称已更新看板。',
  ].join('\n');
}

function summarizeBoardForPrompt(items: AutopilotBoardItem[]): string {
  if (items.length === 0) {
    return '当前看板为空。你需要在本轮工作中建立和整理一个轻量看板。';
  }

  const lines: string[] = [];

  for (const status of AUTOPILOT_BOARD_STATUSES) {
    const grouped = items.filter((item) => item.status === status);
    lines.push(`${status.toUpperCase()}:`);
    if (grouped.length === 0) {
      lines.push('- (empty)');
      continue;
    }

    for (const item of grouped.slice(0, 12)) {
      const note = item.notes ? ` · ${truncate(item.notes, 80)}` : '';
      lines.push(`- ${item.title}${note}`);
    }
  }

  return lines.join('\n');
}

export function parseAutopilotReport(agentMessages: string[]): AutopilotReport | undefined {
  for (let index = agentMessages.length - 1; index >= 0; index -= 1) {
    const candidate = agentMessages[index];
    if (!candidate || !candidate.includes(AUTOPILOT_MARKER)) {
      continue;
    }

    const matched = candidate.match(/AUTOPILOT_REPORT[\s\S]*?```json\s*([\s\S]*?)```/i);
    if (!matched?.[1]) {
      continue;
    }

    try {
      const parsed = JSON.parse(matched[1]) as Partial<AutopilotReport>;
      if (typeof parsed.goal !== 'string' || typeof parsed.summary !== 'string' || typeof parsed.next !== 'string') {
        continue;
      }

      return {
        goal: parsed.goal.trim(),
        summary: parsed.summary.trim(),
        next: parsed.next.trim(),
        board: normalizeBoard(parsed.board),
      };
    } catch {
      continue;
    }
  }

  return undefined;
}

function normalizeBoard(board: unknown): Partial<Record<AutopilotBoardStatus, string[]>> | undefined {
  if (!board || typeof board !== 'object') {
    return undefined;
  }

  const candidate = board as Record<string, unknown>;
  const result: Partial<Record<AutopilotBoardStatus, string[]>> = {};

  for (const status of AUTOPILOT_BOARD_STATUSES) {
    if (!Array.isArray(candidate[status])) {
      result[status] = [];
      continue;
    }

    result[status] = candidate[status]
      .map((item) => typeof item === 'string' ? item.trim() : '')
      .filter(Boolean);
  }

  return result;
}

export function boardItemsFromReport(report: AutopilotReport, existing: AutopilotBoardItem[] = []): AutopilotBoardItem[] {
  const nextItems: AutopilotBoardItem[] = [];
  const existingByKey = new Map(existing.map((item) => [`${item.status}:${item.title}`, item]));
  const now = new Date().toISOString();

  for (const status of AUTOPILOT_BOARD_STATUSES) {
    for (const title of report.board?.[status] ?? []) {
      const key = `${status}:${title}`;
      const matched = existingByKey.get(key);
      nextItems.push({
        id: matched?.id ?? `${status}:${title}`.toLowerCase().replace(/[^a-z0-9:_-]+/g, '-'),
        title,
        status,
        updatedAt: now,
        notes: matched?.notes,
      });
    }
  }

  return nextItems;
}

export function normalizeAutopilotBoardItems(items: unknown): AutopilotBoardItem[] {
  if (!Array.isArray(items)) {
    return [];
  }

  const normalized: AutopilotBoardItem[] = [];
  const seenIds = new Set<string>();

  for (const candidate of items) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }

    const item = candidate as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const status = typeof item.status === 'string' ? item.status.trim().toLowerCase() : '';
    const updatedAt = typeof item.updatedAt === 'string' && item.updatedAt.trim()
      ? item.updatedAt.trim()
      : new Date().toISOString();
    const createdAt = typeof item.createdAt === 'string' && item.createdAt.trim()
      ? item.createdAt.trim()
      : undefined;
    const notes = typeof item.notes === 'string' && item.notes.trim()
      ? item.notes.trim()
      : undefined;

    if (!id || !title || !AUTOPILOT_BOARD_STATUSES.includes(status as AutopilotBoardStatus) || seenIds.has(id)) {
      continue;
    }

    normalized.push({
      id,
      title,
      status: status as AutopilotBoardStatus,
      updatedAt,
      createdAt,
      notes,
    });
    seenIds.add(id);
  }

  return normalized;
}

export function normalizeAutopilotBoardDocument(document: unknown): AutopilotBoardDocument {
  const candidate = document && typeof document === 'object'
    ? document as Record<string, unknown>
    : {};

  const version = candidate.version === 1 ? 1 : 1;
  const updatedAt = typeof candidate.updatedAt === 'string' && candidate.updatedAt.trim()
    ? candidate.updatedAt.trim()
    : new Date().toISOString();

  return {
    version,
    updatedAt,
    items: normalizeAutopilotBoardItems(candidate.items),
  };
}

export function areAutopilotBoardsEquivalent(
  left: AutopilotBoardItem[],
  right: AutopilotBoardItem[],
): boolean {
  const normalize = (items: AutopilotBoardItem[]) => items
    .map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      notes: item.notes ?? '',
    }))
    .sort((first, second) => first.id.localeCompare(second.id));

  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export function diffAutopilotBoards(
  before: AutopilotBoardItem[],
  after: AutopilotBoardItem[],
): AutopilotBoardChange[] {
  const changes: AutopilotBoardChange[] = [];
  const beforeById = new Map(before.map((item) => [item.id, item]));
  const afterById = new Map(after.map((item) => [item.id, item]));

  for (const item of after) {
    const previous = beforeById.get(item.id);
    if (!previous) {
      changes.push({
        kind: 'added',
        itemId: item.id,
        title: item.title,
        toStatus: item.status,
        nextNotes: item.notes,
      });
      continue;
    }

    if (previous.status !== item.status) {
      changes.push({
        kind: 'moved',
        itemId: item.id,
        title: item.title,
        fromStatus: previous.status,
        toStatus: item.status,
        previousNotes: previous.notes,
        nextNotes: item.notes,
      });
    }

    if (previous.title !== item.title || (previous.notes ?? '') !== (item.notes ?? '')) {
      changes.push({
        kind: 'updated',
        itemId: item.id,
        title: item.title,
        previousTitle: previous.title,
        previousNotes: previous.notes,
        nextNotes: item.notes,
      });
    }
  }

  for (const item of before) {
    if (!afterById.has(item.id)) {
      changes.push({
        kind: 'removed',
        itemId: item.id,
        title: item.title,
        fromStatus: item.status,
        previousNotes: item.notes,
      });
    }
  }

  return changes;
}

export function formatAutopilotBoardChanges(changes: AutopilotBoardChange[], limit = 8): string[] {
  if (changes.length === 0) {
    return ['- 无'];
  }

  const lines: string[] = [];
  for (const change of changes.slice(0, limit)) {
    switch (change.kind) {
      case 'added':
        lines.push(`- 新增 ${change.toStatus?.toUpperCase() ?? 'ITEM'} · ${change.title}`);
        break;
      case 'removed':
        lines.push(`- 删除 ${change.fromStatus?.toUpperCase() ?? 'ITEM'} · ${change.title}`);
        break;
      case 'moved':
        lines.push(`- ${change.fromStatus?.toUpperCase() ?? 'ITEM'} -> ${change.toStatus?.toUpperCase() ?? 'ITEM'} · ${change.title}`);
        break;
      case 'updated':
        lines.push(`- 更新条目 · ${change.title}`);
        break;
    }
  }

  if (changes.length > limit) {
    lines.push(`- 其余 ${changes.length - limit} 项变化已省略`);
  }

  return lines;
}

export function summarizeAutopilotBoard(items: AutopilotBoardItem[]): string {
  const counts = {
    ready: items.filter((item) => item.status === 'ready').length,
    doing: items.filter((item) => item.status === 'doing').length,
    blocked: items.filter((item) => item.status === 'blocked').length,
    done: items.filter((item) => item.status === 'done').length,
    deferred: items.filter((item) => item.status === 'deferred').length,
  };

  return `Ready ${counts.ready} · Doing ${counts.doing} · Blocked ${counts.blocked} · Done ${counts.done} · Deferred ${counts.deferred}`;
}

export function buildAutopilotFallbackSummary(goal: string | undefined, finalMessage: string | undefined): string {
  const summary = summarizeReasoningText(finalMessage ?? '', 180);
  return summary || goal || '本轮已结束，但模型没有返回可解析的总结。';
}

export function stampAutopilotLine(message: string, at: string | Date = new Date()): string {
  return `${formatClockTimestamp(at)} ${message}`;
}
