import type { ApprovalPolicy, SandboxMode } from './types.js';

import { parseBooleanWord, parseDurationToMs, tokenizeCommand } from './utils.js';

export interface BindCommandOptions {
  model?: string | undefined;
  profile?: string | undefined;
  sandboxMode?: SandboxMode | undefined;
  approvalPolicy?: ApprovalPolicy | undefined;
  search?: boolean | undefined;
  skipGitRepoCheck?: boolean | undefined;
  addDirs: string[];
  extraConfig: string[];
}

export type ParsedCommand =
  | { kind: 'help' }
  | { kind: 'bind'; projectName: string; workspacePath: string; options: BindCommandOptions }
  | { kind: 'guide'; prompt: string }
  | { kind: 'autopilot'; scope: 'help' }
  | { kind: 'autopilot'; scope: 'server'; action: 'on' | 'off' | 'clear' | 'status' }
  | { kind: 'autopilot'; scope: 'project'; action: 'on' | 'off' | 'clear' | 'status' | 'run' }
  | { kind: 'autopilot'; scope: 'project'; action: 'interval'; intervalMs: number; intervalText: string }
  | { kind: 'autopilot'; scope: 'project'; action: 'prompt'; prompt: string }
  | { kind: 'unbind' }
  | { kind: 'projects' }
  | { kind: 'status' }
  | { kind: 'cancel' }
  | { kind: 'reset' }
  | { kind: 'queue' };

function readValue(tokens: string[], flag: string): string {
  const value = tokens.shift();

  if (!value) {
    throw new Error(`参数 ${flag} 缺少值。`);
  }

  return value;
}

function parseSandboxMode(value: string): SandboxMode {
  if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') {
    return value;
  }

  throw new Error(`不支持的 sandbox 模式：${value}`);
}

function parseApprovalPolicy(value: string): ApprovalPolicy {
  if (value === 'untrusted' || value === 'on-failure' || value === 'on-request' || value === 'never') {
    return value;
  }

  throw new Error(`不支持的 approval 模式：${value}`);
}

function parseAutopilotCommand(body: string): Extract<ParsedCommand, { kind: 'autopilot' }> {
  const normalizedBody = body.trim();
  const lowerBody = normalizedBody.toLowerCase();

  if (lowerBody === 'autopilot' || lowerBody === 'autopilot help' || lowerBody === 'autopilot usage') {
    return { kind: 'autopilot', scope: 'help' };
  }

  const projectPromptMatch = normalizedBody.match(/^autopilot\s+project\s+(?:prompt|brief|direction)\s+([\s\S]+)$/i);
  if (projectPromptMatch?.[1]?.trim()) {
    return {
      kind: 'autopilot',
      scope: 'project',
      action: 'prompt',
      prompt: projectPromptMatch[1].trim(),
    };
  }

  const projectIntervalMatch = normalizedBody.match(/^autopilot\s+project\s+interval\s+(\S+)\s*$/i);
  if (projectIntervalMatch?.[1]) {
    const intervalText = projectIntervalMatch[1].trim();
    const intervalMs = parseDurationToMs(intervalText);

    if (!intervalMs) {
      throw new Error('用法：!autopilot project interval <时长>，例如 30m、2h、1d、90m。');
    }

    return {
      kind: 'autopilot',
      scope: 'project',
      action: 'interval',
      intervalMs,
      intervalText,
    };
  }

  const tokens = tokenizeCommand(normalizedBody);
  tokens.shift();

  const scopeOrAction = tokens.shift()?.toLowerCase();

  if (!scopeOrAction) {
    return { kind: 'autopilot', scope: 'help' };
  }

  if (scopeOrAction === 'status') {
    return {
      kind: 'autopilot',
      scope: 'server',
      action: 'status',
    };
  }

  if (scopeOrAction === 'on' || scopeOrAction === 'off' || scopeOrAction === 'clear') {
    return {
      kind: 'autopilot',
      scope: 'server',
      action: scopeOrAction,
    };
  }

  if (scopeOrAction === 'server') {
    const action = tokens.shift()?.toLowerCase();

    if (action === 'on' || action === 'off' || action === 'clear' || action === 'status') {
      return {
        kind: 'autopilot',
        scope: 'server',
        action,
      };
    }

    throw new Error('用法：!autopilot server <on|off|clear|status>');
  }

  if (scopeOrAction === 'project') {
    const action = tokens.shift()?.toLowerCase();

    if (action === 'on' || action === 'off' || action === 'clear' || action === 'status' || action === 'run') {
      return {
        kind: 'autopilot',
        scope: 'project',
        action,
      };
    }

    if (action === 'interval') {
      throw new Error('用法：!autopilot project interval <时长>，例如 30m、2h、1d、90m。');
    }

    if (action === 'prompt' || action === 'brief' || action === 'direction') {
      throw new Error('用法：!autopilot project prompt <自然语言方向>');
    }

    throw new Error('用法：!autopilot project <on|off|clear|status|run|interval|prompt ...>');
  }

  throw new Error('用法：!autopilot [help|status] | !autopilot server <on|off|clear|status> | !autopilot project <on|off|clear|status|run|interval|prompt ...>');
}

export function isCommandMessage(content: string, prefix: string): boolean {
  return content.trimStart().startsWith(prefix);
}

export function parseCommand(content: string, prefix: string): ParsedCommand {
  const body = content.trimStart().slice(prefix.length).trim();

  if (!body) {
    return { kind: 'help' };
  }

  const lowerBody = body.toLowerCase();
  if (lowerBody === 'guide') {
    throw new Error('用法：!guide <追加引导内容>');
  }

  if (lowerBody.startsWith('guide ')) {
    return { kind: 'guide', prompt: body.slice('guide'.length).trim() };
  }

  const tokens = tokenizeCommand(body);
  const command = tokens.shift()?.toLowerCase();

  switch (command) {
    case 'help':
      return { kind: 'help' };
    case 'unbind':
      return { kind: 'unbind' };
    case 'projects':
      return { kind: 'projects' };
    case 'status':
      return { kind: 'status' };
    case 'cancel':
      return { kind: 'cancel' };
    case 'reset':
      return { kind: 'reset' };
    case 'queue':
      return { kind: 'queue' };
    case 'autopilot':
      return parseAutopilotCommand(body);
    case 'bind': {
      const projectName = tokens.shift();
      const workspacePath = tokens.shift();

      if (!projectName || !workspacePath) {
        throw new Error('用法：!bind <project-name> <workspace-path> [--model ...] [--sandbox ...] [--approval ...]');
      }

      const options: BindCommandOptions = {
        addDirs: [],
        extraConfig: [],
      };

      while (tokens.length > 0) {
        const flag = tokens.shift();

        switch (flag) {
          case '--model':
            options.model = readValue(tokens, flag);
            break;
          case '--profile':
            options.profile = readValue(tokens, flag);
            break;
          case '--sandbox':
            options.sandboxMode = parseSandboxMode(readValue(tokens, flag));
            break;
          case '--approval':
            options.approvalPolicy = parseApprovalPolicy(readValue(tokens, flag));
            break;
          case '--search': {
            const parsed = parseBooleanWord(readValue(tokens, flag));

            if (parsed === undefined) {
              throw new Error('--search 只接受 on/off、true/false、yes/no。');
            }

            options.search = parsed;
            break;
          }
          case '--skip-git-check': {
            const parsed = parseBooleanWord(readValue(tokens, flag));

            if (parsed === undefined) {
              throw new Error('--skip-git-check 只接受 on/off、true/false、yes/no。');
            }

            options.skipGitRepoCheck = parsed;
            break;
          }
          case '--add-dir':
            options.addDirs.push(readValue(tokens, flag));
            break;
          case '--config':
            options.extraConfig.push(readValue(tokens, flag));
            break;
          default:
            throw new Error(`未知参数：${flag}`);
        }
      }

      return {
        kind: 'bind',
        projectName,
        workspacePath,
        options,
      };
    }
    default:
      throw new Error(`未知命令：${command}`);
  }
}
