import { once } from 'node:events';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

import type { AppConfig } from './config.js';
import type { ChannelBinding, CodexDriverMode, CodexRunInput, CodexRunResult, CollabAgentState, CollabAgentStatus, CollabToolCall, CollabToolName, CollabToolStatus, CommandRecord, PlanItem } from './types.js';

import { buildCodexChildEnv } from './codexChildEnv.js';
import { normalizeCodexDiagnosticLine } from './codexDiagnostics.js';
import { uniqueStrings } from './utils.js';

export interface CodexRunHooks {
  onThreadStarted?: (threadId: string) => void | Promise<void>;
  onFallbackActivated?: ((detail: {
    from: CodexDriverMode;
    to: CodexDriverMode;
    reason: string;
  }) => void | Promise<void>) | undefined;
  onActivity?: (activity: string) => void | Promise<void>;
  onReasoning?: (message: string) => void | Promise<void>;
  onTodoListChanged?: (items: PlanItem[]) => void | Promise<void>;
  onCollabToolChanged?: (item: CollabToolCall) => void | Promise<void>;
  onAgentMessage?: (message: string) => void | Promise<void>;
  onCommandStarted?: (command: string) => void | Promise<void>;
  onCommandCompleted?: (command: string, output: string, exitCode: number | null) => void | Promise<void>;
  onStderr?: (line: string) => void | Promise<void>;
  onExit?: (result: CodexRunResult) => void | Promise<void>;
}

export interface RunningCodexJob {
  pid: number | undefined;
  driverMode: CodexDriverMode;
  cancel: () => void;
  steer?: ((prompt: string) => Promise<void>) | undefined;
  done: Promise<CodexRunResult>;
}

export interface CodexExecutionDriver {
  start: (
    binding: ChannelBinding,
    input: CodexRunInput,
    existingThreadId: string | undefined,
    hooks?: CodexRunHooks,
  ) => RunningCodexJob;
  stop?: (() => Promise<void>) | undefined;
}

export class CodexRunner implements CodexExecutionDriver {
  constructor(private readonly config: AppConfig) {}

  start(binding: ChannelBinding, input: CodexRunInput, existingThreadId: string | undefined, hooks: CodexRunHooks = {}): RunningCodexJob {
    const usedResume = Boolean(existingThreadId);
    const args = this.buildArgs(binding, input, usedResume, existingThreadId);
    const env = buildCodexChildEnv(binding.workspacePath);
    let cancelRequested = false;
    const child = spawn(this.config.codexCommand, args, {
      cwd: binding.workspacePath,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    const commands: CommandRecord[] = [];
    const agentMessages: string[] = [];
    const reasoning: string[] = [];
    const stderr: string[] = [];
    let codexThreadId = existingThreadId;
    let planItems: PlanItem[] = [];
    let turnCompleted = false;
    let stdoutChain = Promise.resolve();
    let stderrChain = Promise.resolve();

    const appendDiagnosticLine = (line: string): void => {
      const normalized = normalizeCodexDiagnosticLine(line);

      if (!normalized || stderr.at(-1) === normalized) {
        return;
      }

      stderr.push(normalized);
    };

    const emitDiagnosticLine = async (line: string): Promise<void> => {
      appendDiagnosticLine(line);
      await hooks.onStderr?.(line);
    };

    const stdoutInterface = readline.createInterface({ input: child.stdout });
    const stderrInterface = readline.createInterface({ input: child.stderr });

    stdoutInterface.on('line', (line) => {
      stdoutChain = stdoutChain.then(async () => {
        if (!line.trim()) {
          return;
        }

        let event: Record<string, unknown>;

        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          await emitDiagnosticLine(line);
          return;
        }

        switch (event.type) {
          case 'thread.started': {
            const nextThreadId = typeof event.thread_id === 'string' ? event.thread_id : undefined;

            if (nextThreadId) {
              codexThreadId = nextThreadId;
              await hooks.onThreadStarted?.(nextThreadId);
            }
            break;
          }
          case 'turn.started':
            await hooks.onActivity?.('Codex 正在分析请求');
            break;
          case 'item.started':
          case 'item.updated':
          case 'item.completed': {
            const item = (event.item ?? null) as Record<string, unknown> | null;

            if (!item || typeof item.type !== 'string') {
              break;
            }

            if (item.type === 'reasoning' && event.type === 'item.completed' && typeof item.text === 'string') {
              reasoning.push(item.text);
              await hooks.onReasoning?.(item.text);
            }

            if (item.type === 'todo_list') {
              const hasRawTodoItems = Array.isArray(item.items);
              const nextPlanItems = parsePlanItems(item.items, planItems);
              if (hasRawTodoItems) {
                planItems = nextPlanItems;
                await hooks.onTodoListChanged?.(nextPlanItems);
              }
            }

            if (item.type === 'collab_tool_call') {
              const collabToolCall = parseCollabToolCall(item);
              if (collabToolCall) {
                await hooks.onCollabToolChanged?.(collabToolCall);
              }
            }

            if (item.type === 'agent_message' && event.type === 'item.completed' && typeof item.text === 'string') {
              agentMessages.push(item.text);
              await hooks.onAgentMessage?.(item.text);
            }

            if (item.type === 'command_execution' && typeof item.command === 'string') {
              if (event.type === 'item.started') {
                await hooks.onCommandStarted?.(item.command);
              }

              if (event.type === 'item.completed') {
                const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
                const exitCode = typeof item.exit_code === 'number' ? item.exit_code : null;
                commands.push({ command: item.command, output, exitCode });
                await hooks.onCommandCompleted?.(item.command, output, exitCode);
              }
            }
            break;
          }
          case 'turn.completed':
            turnCompleted = true;
            await hooks.onActivity?.('本轮已完成');
            break;
          case 'error': {
            const message = typeof event.message === 'string'
              ? event.message
              : typeof (event.error as Record<string, unknown> | null)?.message === 'string'
                ? String((event.error as Record<string, unknown>).message)
                : undefined;

            if (message) {
              await emitDiagnosticLine(`Codex error: ${message}`);
            }
            break;
          }
          case 'turn.failed': {
            const error = (event.error ?? null) as Record<string, unknown> | null;
            const message = typeof error?.message === 'string'
              ? error.message
              : typeof event.message === 'string'
                ? event.message
                : 'Codex turn failed.';

            await emitDiagnosticLine(`Codex turn failed: ${message}`);
            break;
          }
          default:
            break;
        }
      });
    });

    stderrInterface.on('line', (line) => {
      stderrChain = stderrChain.then(async () => {
        if (!line.trim()) {
          return;
        }

        appendDiagnosticLine(line);
        await hooks.onStderr?.(line);
      });
    });

    try {
      child.stdin.write(input.prompt);
      child.stdin.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendDiagnosticLine(message);
      stderrChain = stderrChain.then(async () => hooks.onStderr?.(message));
    }

    const done = (async (): Promise<CodexRunResult> => {
      let exitCode: number | null = null;
      let signal: NodeJS.Signals | null = null;

      try {
        const outcome = await Promise.race([
          once(child, 'exit').then(([code, nextSignal]) => ({ kind: 'exit' as const, code, signal: nextSignal })),
          once(child, 'error').then(([error]) => ({ kind: 'error' as const, error: error as Error })),
        ]);

        if (outcome.kind === 'exit') {
          exitCode = outcome.code as number | null;
          signal = outcome.signal as NodeJS.Signals | null;
        } else {
          const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
          appendDiagnosticLine(message);
          await hooks.onStderr?.(message);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendDiagnosticLine(message);
        await hooks.onStderr?.(message);
      }

      await stdoutChain;
      await stderrChain;
      stdoutInterface.close();
      stderrInterface.close();

      if (cancelRequested && stderr.length === 0) {
        const cancellationMessage = signal
          ? `Codex process interrupted by ${signal}.`
          : 'Codex process cancelled by bridge.';
        appendDiagnosticLine(cancellationMessage);
        await hooks.onStderr?.(cancellationMessage);
      }

      const result: CodexRunResult = {
        success: exitCode === 0 && turnCompleted,
        exitCode,
        signal,
        codexThreadId,
        usedResume,
        turnCompleted,
        agentMessages,
        reasoning,
        planItems,
        stderr,
        commands,
      };

      await hooks.onExit?.(result);
      return result;
    })();

    return {
      pid: child.pid,
      driverMode: 'legacy-exec',
      cancel: () => {
        cancelRequested = true;
        terminateChild(child);
      },
      done,
    };
  }

  private buildArgs(
    binding: ChannelBinding,
    input: CodexRunInput,
    usedResume: boolean,
    existingThreadId: string | undefined,
  ): string[] {
    const globalArgs: string[] = ['-a', binding.codex.approvalPolicy];
    const configEntries = resolveCodexConfigEntries(binding.codex.extraConfig);

    if (binding.codex.search) {
      globalArgs.push('--search');
    }

    for (const addDir of uniqueStrings([...binding.codex.addDirs, ...input.extraAddDirs])) {
      globalArgs.push('--add-dir', addDir);
    }

    if (usedResume && existingThreadId) {
      const resumeArgs = ['exec', 'resume'];

      if (binding.codex.model) {
        resumeArgs.push('-m', binding.codex.model);
      }

      for (const configEntry of configEntries) {
        resumeArgs.push('-c', configEntry);
      }

      for (const imagePath of uniqueStrings(input.imagePaths)) {
        resumeArgs.push('-i', imagePath);
      }

      if (binding.codex.sandboxMode === 'danger-full-access') {
        resumeArgs.push('--dangerously-bypass-approvals-and-sandbox');
      }

      if (binding.codex.skipGitRepoCheck) {
        resumeArgs.push('--skip-git-repo-check');
      }

      resumeArgs.push('--json');
      resumeArgs.push(existingThreadId, '-');
      return [...globalArgs, ...resumeArgs];
    }

    const execArgs = ['exec'];

    if (binding.codex.model) {
      execArgs.push('-m', binding.codex.model);
    }

    if (binding.codex.profile) {
      execArgs.push('-p', binding.codex.profile);
    }

    execArgs.push('-s', binding.codex.sandboxMode);
    execArgs.push('-C', binding.workspacePath);

    for (const configEntry of configEntries) {
      execArgs.push('-c', configEntry);
    }

    for (const imagePath of uniqueStrings(input.imagePaths)) {
      execArgs.push('-i', imagePath);
    }

    if (binding.codex.skipGitRepoCheck) {
      execArgs.push('--skip-git-repo-check');
    }

    execArgs.push('--json', '--color', 'never');
    execArgs.push('-');
    return [...globalArgs, ...execArgs];
  }
}

export function resolveCodexConfigEntries(extraConfig: string[]): string[] {
  const entries = uniqueStrings(extraConfig.map((value) => value.trim()).filter(Boolean));
  const hasMultiAgentOverride = entries.some((entry) => {
    const normalized = entry.replace(/\s+/g, '').toLowerCase();
    return /^(?:features\.)?(?:multi_agent|collab)=/.test(normalized);
  });

  if (!hasMultiAgentOverride) {
    entries.push('features.multi_agent=true');
  }

  return entries;
}

export function parsePlanItems(rawItems: unknown, existingItems: PlanItem[] = []): PlanItem[] {
  if (!Array.isArray(rawItems)) {
    return [];
  }

  const existingById = new Map(
    existingItems
      .filter((item) => typeof item.id === 'string' && item.id)
      .map((item) => [item.id as string, item]),
  );

  const parsed: Array<PlanItem | undefined> = rawItems
    .map((item, index) => {
      const candidate = item as Record<string, unknown> | null;
      if (!candidate) {
        return undefined;
      }

      const id = typeof candidate.id === 'string' && candidate.id.trim()
        ? candidate.id.trim()
        : undefined;
      const previous = (id ? existingById.get(id) : undefined) ?? existingItems[index];
      const text = extractPlanItemText(candidate) || previous?.text;
      if (!text) {
        return undefined;
      }

      const status = normalizePlanStatus(candidate.status ?? candidate.state ?? candidate.phase);

      const completed = candidate.completed === true
        || candidate.done === true
        || candidate.finished === true
        || status === 'completed'
        || status === 'complete'
        || status === 'done'
        || status === 'checked'
        || status === 'finished'
        || status === 'resolved'
        || status === 'success'
        || status === 'succeeded';

      return {
        id,
        text,
        completed,
      } satisfies PlanItem;
    });

  return parsed.filter((item): item is PlanItem => item !== undefined);
}

function extractPlanItemText(candidate: Record<string, unknown>): string | undefined {
  return coercePlanText(
    candidate.text
      ?? candidate.title
      ?? candidate.label
      ?? candidate.content
      ?? candidate.name
      ?? candidate.task
      ?? candidate.description,
  );
}

export function parseCollabToolCall(item: Record<string, unknown>): CollabToolCall | undefined {
  const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : undefined;
  const tool = normalizeCollabTool(item.tool);
  const status = normalizeCollabToolStatus(item.status);

  if (!id || !tool || !status) {
    return undefined;
  }

  const senderThreadId = typeof item.sender_thread_id === 'string'
    ? item.sender_thread_id
    : typeof item.senderThreadId === 'string'
      ? item.senderThreadId
    : '';
  const rawReceiverThreadIds = Array.isArray(item.receiver_thread_ids)
    ? item.receiver_thread_ids
    : Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds
      : [];
  const receiverThreadIds = rawReceiverThreadIds
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const prompt = typeof item.prompt === 'string' && item.prompt.trim().length > 0
    ? item.prompt.trim()
    : undefined;
  const agentNicknames = parseCollabAgentNicknames(item, receiverThreadIds);
  const agentRoles = parseCollabAgentRoles(item, receiverThreadIds);

  return {
    id,
    tool,
    senderThreadId,
    receiverThreadIds,
    prompt,
    agentsStates: parseCollabAgentStates(item.agents_states ?? item.agentsStates, agentNicknames, agentRoles),
    status,
  };
}

function parseCollabAgentStates(
  rawStates: unknown,
  agentNicknames: Map<string, string>,
  agentRoles: Map<string, string>,
): Record<string, CollabAgentState> {
  if (!rawStates || typeof rawStates !== 'object' || Array.isArray(rawStates)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(rawStates).flatMap(([threadId, rawState]) => {
      if (!threadId.trim() || !rawState || typeof rawState !== 'object' || Array.isArray(rawState)) {
        return [];
      }

      const candidate = rawState as Record<string, unknown>;
      const status = normalizeCollabAgentStatus(candidate.status);
      if (!status) {
        return [];
      }

      const message = typeof candidate.message === 'string'
        ? candidate.message
        : candidate.message === null
          ? null
          : undefined;
      const nickname = coerceOptionalString(
        candidate.agent_nickname
          ?? candidate.agentNickname
          ?? candidate.nickname,
      ) ?? agentNicknames.get(threadId);
      const role = coerceOptionalString(
        candidate.agent_role
          ?? candidate.agentRole
          ?? candidate.role,
      ) ?? agentRoles.get(threadId);

      return [[threadId, {
        status,
        message,
        nickname,
        role,
      } satisfies CollabAgentState]];
    }),
  );
}

function parseCollabAgentNicknames(item: Record<string, unknown>, receiverThreadIds: string[]): Map<string, string> {
  const nicknames = new Map<string, string>();
  assignCollabAgentMap(nicknames, item.receiver_agent_nicknames ?? item.receiverAgentNicknames);
  assignSingleReceiverValue(
    nicknames,
    receiverThreadIds,
    coerceOptionalString(item.receiver_agent_nickname ?? item.receiverAgentNickname),
  );
  assignSingleReceiverValue(
    nicknames,
    receiverThreadIds,
    coerceOptionalString(item.new_agent_nickname ?? item.newAgentNickname),
  );
  return nicknames;
}

function parseCollabAgentRoles(item: Record<string, unknown>, receiverThreadIds: string[]): Map<string, string> {
  const roles = new Map<string, string>();
  assignCollabAgentMap(roles, item.receiver_agent_roles ?? item.receiverAgentRoles);
  assignSingleReceiverValue(
    roles,
    receiverThreadIds,
    coerceOptionalString(item.receiver_agent_role ?? item.receiverAgentRole),
  );
  assignSingleReceiverValue(
    roles,
    receiverThreadIds,
    coerceOptionalString(item.new_agent_role ?? item.newAgentRole),
  );
  return roles;
}

function assignCollabAgentMap(target: Map<string, string>, rawValue: unknown): void {
  if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
    return;
  }

  for (const [threadId, value] of Object.entries(rawValue)) {
    const normalized = coerceOptionalString(value);
    if (!threadId.trim() || !normalized) {
      continue;
    }

    target.set(threadId, normalized);
  }
}

function assignSingleReceiverValue(
  target: Map<string, string>,
  receiverThreadIds: string[],
  value: string | undefined,
): void {
  if (!value || receiverThreadIds.length !== 1 || target.has(receiverThreadIds[0]!)) {
    return;
  }

  target.set(receiverThreadIds[0]!, value);
}

function coerceOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeCollabTool(value: unknown): CollabToolName | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  if (value === 'spawn_agent' || value === 'send_input' || value === 'wait' || value === 'close_agent') {
    return value;
  }

  return undefined;
}

function normalizeCollabToolStatus(value: unknown): CollabToolStatus | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  if (value === 'in_progress' || value === 'completed' || value === 'failed') {
    return value;
  }

  return undefined;
}

export function extractReasoningText(item: Record<string, unknown>): string | undefined {
  const summary = Array.isArray(item.summary)
    ? item.summary.map(extractTextValue).filter((value): value is string => Boolean(value))
    : [];
  if (summary.length > 0) {
    return summary.join('\n').trim();
  }

  const content = Array.isArray(item.content)
    ? item.content.map(extractTextValue).filter((value): value is string => Boolean(value))
    : [];
  if (content.length > 0) {
    return content.join('\n').trim();
  }

  const rawContent = Array.isArray(item.raw_content)
    ? item.raw_content.map(extractTextValue).filter((value): value is string => Boolean(value))
    : [];
  if (rawContent.length > 0) {
    return rawContent.join('\n').trim();
  }

  if (typeof item.text === 'string' && item.text.trim()) {
    return item.text.trim();
  }

  if (typeof item.reasoning_text === 'string' && item.reasoning_text.trim()) {
    return item.reasoning_text.trim();
  }

  return undefined;
}

function extractTextValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() || undefined;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  return coerceOptionalString(
    candidate.text
      ?? candidate.content
      ?? candidate.value
      ?? candidate.reasoning_text
      ?? candidate.summary_text,
  );
}

function normalizeCollabAgentStatus(value: unknown): CollabAgentStatus | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  if (
    value === 'pending_init'
    || value === 'running'
    || value === 'interrupted'
    || value === 'completed'
    || value === 'errored'
    || value === 'shutdown'
    || value === 'not_found'
  ) {
    return value;
  }

  return undefined;
}

function coercePlanText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized || undefined;
  }

  if (Array.isArray(value)) {
    const joined = value
      .map((entry) => coercePlanText(entry))
      .filter((entry): entry is string => Boolean(entry))
      .join(' ')
      .trim();
    return joined || undefined;
  }

  if (value && typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    return coercePlanText(
      candidate.text
        ?? candidate.value
        ?? candidate.label
        ?? candidate.title
        ?? candidate.content,
    );
  }

  return undefined;
}

function normalizePlanStatus(value: unknown): string | undefined {
  return typeof value === 'string'
    ? value.trim().toLowerCase()
    : undefined;
}

function terminateChild(child: ReturnType<typeof spawn>): void {
  if (child.killed) {
    return;
  }

  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }

    setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, 5_000).unref();
    return;
  }

  child.kill('SIGTERM');
}
