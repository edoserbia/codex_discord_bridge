import { once } from 'node:events';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

import type { AppConfig } from './config.js';
import type { ChannelBinding, CodexRunInput, CodexRunResult, CommandRecord } from './types.js';

import { uniqueStrings } from './utils.js';

export interface CodexRunHooks {
  onThreadStarted?: (threadId: string) => void | Promise<void>;
  onActivity?: (activity: string) => void | Promise<void>;
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
    const child = spawn(this.config.codexCommand, args, {
      cwd: binding.workspacePath,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    const commands: CommandRecord[] = [];
    const agentMessages: string[] = [];
    const stderr: string[] = [];
    let codexThreadId = existingThreadId;
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
          case 'item.started': {
            const item = (event.item ?? null) as Record<string, unknown> | null;

            if (item?.type === 'command_execution' && typeof item.command === 'string') {
              await hooks.onCommandStarted?.(item.command);
            }
            break;
          }
          case 'item.completed': {
            const item = (event.item ?? null) as Record<string, unknown> | null;

            if (item?.type === 'agent_message' && typeof item.text === 'string') {
              agentMessages.push(item.text);
              await hooks.onAgentMessage?.(item.text);
            }

            if (item?.type === 'command_execution' && typeof item.command === 'string') {
              const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
              const exitCode = typeof item.exit_code === 'number' ? item.exit_code : null;
              commands.push({ command: item.command, output, exitCode });
              await hooks.onCommandCompleted?.(item.command, output, exitCode);
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

      const result: CodexRunResult = {
        success: exitCode === 0 && turnCompleted,
        exitCode,
        signal,
        codexThreadId,
        usedResume,
        turnCompleted,
        agentMessages,
        stderr,
        commands,
      };

      await hooks.onExit?.(result);
      return result;
    })();

    return {
      pid: child.pid,
      cancel: () => terminateChild(child),
      done,
    };
  }

  private buildArgs(
    binding: ChannelBinding,
    input: CodexRunInput,
    usedResume: boolean,
    existingThreadId: string | undefined,
  ): string[] {
    const rootArgs: string[] = [];

    if (binding.codex.search) {
      rootArgs.push('--search');
    }

    if (binding.codex.model) {
      rootArgs.push('-m', binding.codex.model);
    }

    if (binding.codex.profile) {
      rootArgs.push('-p', binding.codex.profile);
    }

    rootArgs.push('-s', binding.codex.sandboxMode);
    rootArgs.push('-a', binding.codex.approvalPolicy);
    rootArgs.push('-C', binding.workspacePath);

    for (const addDir of uniqueStrings([...binding.codex.addDirs, ...input.extraAddDirs])) {
      rootArgs.push('--add-dir', addDir);
    }

    for (const configEntry of binding.codex.extraConfig) {
      rootArgs.push('-c', configEntry);
    }

    for (const imagePath of uniqueStrings(input.imagePaths)) {
      rootArgs.push('-i', imagePath);
    }

    if (usedResume && existingThreadId) {
      const resumeArgs = ['exec', 'resume', '--json'];

      if (binding.codex.skipGitRepoCheck) {
        resumeArgs.push('--skip-git-repo-check');
      }

      resumeArgs.push(existingThreadId, '-');
      return [...rootArgs, ...resumeArgs];
    }

    const execArgs = ['exec', '--json', '--color', 'never'];

    if (binding.codex.skipGitRepoCheck) {
      execArgs.push('--skip-git-repo-check');
    }

    execArgs.push('-');
    return [...rootArgs, ...execArgs];
  }
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

  setTimeout(() => {
    child.kill('SIGKILL');
  }, 5_000).unref();
}
