import { once } from 'node:events';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

import type { AppConfig } from './config.js';
import type { ChannelBinding, CodexRunInput, CodexRunResult, CommandRecord, PlanItem } from './types.js';

import { uniqueStrings } from './utils.js';

export interface CodexRunHooks {
  onThreadStarted?: (threadId: string) => void | Promise<void>;
  onActivity?: (activity: string) => void | Promise<void>;
  onReasoning?: (message: string) => void | Promise<void>;
  onTodoListChanged?: (items: PlanItem[]) => void | Promise<void>;
  onAgentMessage?: (message: string) => void | Promise<void>;
  onCommandStarted?: (command: string) => void | Promise<void>;
  onCommandCompleted?: (command: string, output: string, exitCode: number | null) => void | Promise<void>;
  onStderr?: (line: string) => void | Promise<void>;
  onExit?: (result: CodexRunResult) => void | Promise<void>;
}

export interface RunningCodexJob {
  pid: number | undefined;
  cancel: () => void;
  done: Promise<CodexRunResult>;
}

export class CodexRunner {
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
          stderr.push(line);
          await hooks.onStderr?.(line);
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
              const nextPlanItems = parsePlanItems(item.items);
              if (nextPlanItems.length > 0) {
                planItems = nextPlanItems;
                await hooks.onTodoListChanged?.(nextPlanItems);
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

        stderr.push(line);
        await hooks.onStderr?.(line);
      });
    });

    try {
      child.stdin.write(input.prompt);
      child.stdin.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr.push(message);
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
          stderr.push(message);
          await hooks.onStderr?.(message);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr.push(message);
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
        stderr.push(cancellationMessage);
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

      for (const configEntry of binding.codex.extraConfig) {
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

    for (const configEntry of binding.codex.extraConfig) {
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

function buildCodexChildEnv(workspacePath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PWD: workspacePath,
  };

  const blockedExactKeys = new Set([
    'CODEX_CI',
    'CODEX_SHELL',
    'CODEX_THREAD_ID',
  ]);

  for (const key of Object.keys(env)) {
    if (key.startsWith('CODEX_TUNNING_')) {
      continue;
    }

    if (key === 'CODEX_HOME' || key === 'CODEX_CONFIG_HOME') {
      continue;
    }

    if (blockedExactKeys.has(key) || key.startsWith('CODEX_INTERNAL_')) {
      delete env[key];
    }
  }

  return env;
}

function parsePlanItems(rawItems: unknown): PlanItem[] {
  if (!Array.isArray(rawItems)) {
    return [];
  }

  return rawItems
    .map((item) => {
      const candidate = item as Record<string, unknown> | null;
      if (!candidate || typeof candidate.text !== 'string') {
        return undefined;
      }

      return {
        text: candidate.text,
        completed: candidate.completed === true,
      } satisfies PlanItem;
    })
    .filter((item): item is PlanItem => Boolean(item));
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
