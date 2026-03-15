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

export const AUTOPILOT_THREAD_NAME_PREFIX = 'Autopilot · ';
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

export function getAutopilotTickMs(): number {
  const parsed = Number.parseInt(process.env.AUTOPILOT_TICK_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 5_000 ? parsed : 60_000;
}

export function getAutopilotMinIntervalMs(): number {
  const parsed = Number.parseInt(process.env.AUTOPILOT_MIN_INTERVAL_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : 12 * 60 * 60 * 1000;
}

export function getAutopilotSkillPath(): string {
  return path.join(BRIDGE_ROOT, 'skills', 'autopilot-governor', 'SKILL.md');
}

export function getAutopilotSkillDir(): string {
  return path.dirname(getAutopilotSkillPath());
}

export function getAutopilotThreadName(projectName: string): string {
  return `${AUTOPILOT_THREAD_NAME_PREFIX}${projectName}`;
}

export function buildAutopilotPrompt(binding: ChannelBinding, project: AutopilotProjectState): string {
  const board = summarizeBoardForPrompt(project.board);
  const skillPath = getAutopilotSkillPath();

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
    '如果规则文件不可读，则继续执行，但仍必须遵守下面这些核心要求：',
    '- 一轮只做 1 个任务。',
    '- 优先测试、稳定性、低风险修复和小范围清理。',
    '- 如果用户自然语言明确允许小功能，才可以做小功能；否则不要主动扩功能。',
    '- 如果改动风险高、边界不清或需要产品判断，就不要落地，把它写进任务看板。',
    '- 完成后必须运行必要验证；验证失败不能伪装成完成。',
    '',
    '当前项目自动迭代要求：',
    project.brief.trim() || DEFAULT_AUTOPILOT_BRIEF,
    '',
    '当前任务看板：',
    board,
    '',
    '执行步骤：',
    '1. 先根据当前项目要求和看板，挑选 1 个最值得做且风险最低的任务。',
    '2. 给出一个简短计划。',
    '3. 实施改动。',
    '4. 运行必要验证。',
    '5. 用自然语言总结结果。',
    `6. 最后一条模型消息必须包含 ${AUTOPILOT_MARKER} JSON 代码块，格式如下：`,
    '```json',
    JSON.stringify({
      goal: '本轮目标',
      summary: '本轮完成情况，1-3 句',
      next: '下一步建议，1 句',
      board: {
        ready: ['还没做、但下一轮可做的事项'],
        doing: ['如果本轮结束后仍未完成，可保留 0-1 项'],
        blocked: ['当前受阻事项'],
        done: ['本轮或已确认完成事项'],
        deferred: ['明确延后事项'],
      },
    }, null, 2),
    '```',
    '',
    '要求：',
    '- JSON 必须有效。',
    '- board 中的每个数组都可以为空，但字段要保留。',
    '- 最后一条模型消息里，JSON 代码块前后都可以有普通说明文字。',
  ].join('\n');
}

function summarizeBoardForPrompt(items: AutopilotBoardItem[]): string {
  if (items.length === 0) {
    return '当前看板为空。你需要在本轮工作中建立和整理一个轻量看板。';
  }

  const lines: string[] = [];

  for (const status of ['ready', 'doing', 'blocked', 'done', 'deferred'] satisfies AutopilotBoardStatus[]) {
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

  for (const status of ['ready', 'doing', 'blocked', 'done', 'deferred'] satisfies AutopilotBoardStatus[]) {
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

  for (const status of ['ready', 'doing', 'blocked', 'done', 'deferred'] satisfies AutopilotBoardStatus[]) {
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
