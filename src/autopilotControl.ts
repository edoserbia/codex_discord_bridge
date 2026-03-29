import fs from 'node:fs';
import path from 'node:path';

import type { ChannelBinding } from './types.js';

export interface AutopilotTargetCandidate {
  channelId: string;
  projectName: string;
  workspacePath: string;
}

export interface AutopilotTargetHints {
  channelId?: string | undefined;
  projectName?: string | undefined;
  cwd?: string | undefined;
}

export interface AutopilotResolvedTarget extends AutopilotTargetCandidate {
  mode: 'channel' | 'project' | 'cwd';
}

export type AutopilotTargetResolution =
  | {
    ok: true;
    binding: ChannelBinding;
    mode: AutopilotResolvedTarget['mode'];
  }
  | {
    ok: false;
    code: 'target_required' | 'binding_not_found' | 'ambiguous_target';
    message: string;
    candidates: AutopilotTargetCandidate[];
  };

export function toAutopilotTargetCandidate(binding: ChannelBinding): AutopilotTargetCandidate {
  return {
    channelId: binding.channelId,
    projectName: binding.projectName,
    workspacePath: binding.workspacePath,
  };
}

export function resolveAutopilotBindingTarget(
  bindings: ChannelBinding[],
  hints: AutopilotTargetHints,
): AutopilotTargetResolution {
  const candidates = bindings.map(toAutopilotTargetCandidate);

  if (hints.channelId) {
    const binding = bindings.find((candidate) => candidate.channelId === hints.channelId);
    if (!binding) {
      return {
        ok: false,
        code: 'binding_not_found',
        message: `未找到频道 ${hints.channelId} 对应的绑定项目。`,
        candidates,
      };
    }

    return {
      ok: true,
      binding,
      mode: 'channel',
    };
  }

  if (hints.projectName) {
    const matches = bindings.filter((candidate) => candidate.projectName === hints.projectName);

    if (matches.length === 1) {
      return {
        ok: true,
        binding: matches[0]!,
        mode: 'project',
      };
    }

    if (matches.length > 1) {
      return {
        ok: false,
        code: 'ambiguous_target',
        message: `存在多个绑定项目名为 ${hints.projectName}，请改用 \`--channel\` 指定目标频道。`,
        candidates: matches.map(toAutopilotTargetCandidate),
      };
    }

    return {
      ok: false,
      code: 'binding_not_found',
      message: `未找到项目名为 ${hints.projectName} 的绑定项目。`,
      candidates,
    };
  }

  if (hints.cwd) {
    const resolvedCwd = normalizePathForMatching(hints.cwd);
    const matches = bindings
      .map((binding) => ({
        binding,
        workspacePath: normalizePathForMatching(binding.workspacePath),
      }))
      .filter((candidate) => isWithinPath(resolvedCwd, candidate.workspacePath))
      .sort((left, right) => right.workspacePath.length - left.workspacePath.length);

    if (matches.length === 1) {
      return {
        ok: true,
        binding: matches[0]!.binding,
        mode: 'cwd',
      };
    }

    if (matches.length > 1) {
      const longest = matches[0]!.workspacePath.length;
      const mostSpecific = matches.filter((candidate) => candidate.workspacePath.length === longest);

      if (mostSpecific.length === 1) {
        return {
          ok: true,
          binding: mostSpecific[0]!.binding,
          mode: 'cwd',
        };
      }

      return {
        ok: false,
        code: 'ambiguous_target',
        message: `当前目录 ${resolvedCwd} 同时匹配多个已绑定项目，请改用 \`--project\` 或 \`--channel\` 明确指定。`,
        candidates: mostSpecific.map((candidate) => toAutopilotTargetCandidate(candidate.binding)),
      };
    }

    return {
      ok: false,
      code: 'binding_not_found',
      message: `当前目录 ${resolvedCwd} 没有匹配到任何已绑定项目，请改用 \`--project\` 或 \`--channel\` 指定目标。`,
      candidates,
    };
  }

  return {
    ok: false,
    code: 'target_required',
    message: '项目级 Autopilot 命令需要提供 `--project`、`--channel`，或在已绑定项目目录中执行。',
    candidates,
  };
}

function isWithinPath(targetPath: string, basePath: string): boolean {
  const relative = path.relative(basePath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizePathForMatching(inputPath: string): string {
  const resolved = path.resolve(inputPath);

  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}
