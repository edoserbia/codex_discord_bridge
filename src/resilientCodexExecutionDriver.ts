import type { AppConfig } from './config.js';
import type { ChannelBinding, CodexRunInput, CodexRunResult } from './types.js';
import type { CodexExecutionDriver, CodexRunHooks, RunningCodexJob } from './codexRunner.js';

import { CodexAppServerRunner } from './codexAppServerRunner.js';
import { CodexRunner } from './codexRunner.js';

export class ResilientCodexExecutionDriver implements CodexExecutionDriver {
  private readonly appServerRunner: CodexAppServerRunner;
  private readonly legacyRunner: CodexRunner;

  constructor(config: AppConfig) {
    this.appServerRunner = new CodexAppServerRunner(config);
    this.legacyRunner = new CodexRunner(config);
  }

  start(
    binding: ChannelBinding,
    input: CodexRunInput,
    existingThreadId: string | undefined,
    hooks: CodexRunHooks = {},
  ): RunningCodexJob {
    let currentJob!: RunningCodexJob;
    let cancelled = false;
    let pendingThreadId: string | undefined;
    let threadForwarded = false;
    let appServerEngaged = false;

    const flushPendingThread = async (): Promise<void> => {
      if (threadForwarded || !pendingThreadId) {
        return;
      }

      threadForwarded = true;
      await hooks.onThreadStarted?.(pendingThreadId);
    };

    const markAppServerEngaged = async (): Promise<void> => {
      appServerEngaged = true;
      await flushPendingThread();
    };

    const primaryHooks: CodexRunHooks = {
      onThreadStarted: async (threadId: string) => {
        pendingThreadId = threadId;
      },
      onActivity: async (activity: string) => {
        await markAppServerEngaged();
        await hooks.onActivity?.(activity);
      },
      onReasoning: async (message: string) => {
        await markAppServerEngaged();
        await hooks.onReasoning?.(message);
      },
      onTodoListChanged: async (items) => {
        await markAppServerEngaged();
        await hooks.onTodoListChanged?.(items);
      },
      onCollabToolChanged: async (item) => {
        await markAppServerEngaged();
        await hooks.onCollabToolChanged?.(item);
      },
      onAgentMessage: async (message: string) => {
        await markAppServerEngaged();
        await hooks.onAgentMessage?.(message);
      },
      onCommandStarted: async (command: string) => {
        await markAppServerEngaged();
        await hooks.onCommandStarted?.(command);
      },
      onCommandCompleted: async (command: string, output: string, exitCode: number | null) => {
        await markAppServerEngaged();
        await hooks.onCommandCompleted?.(command, output, exitCode);
      },
      onStderr: async (line: string) => {
        await hooks.onStderr?.(line);
      },
    };

    const startLegacyFallback = async (reason: string): Promise<CodexRunResult> => {
      const fallbackGate = Promise.resolve(
        hooks.onFallbackActivated?.({
          from: 'app-server',
          to: 'legacy-exec',
          reason,
        }),
      ).catch(() => undefined);
      currentJob = this.legacyRunner.start(binding, input, undefined, gateHooksAfterFallbackNotice(hooks, fallbackGate));
      return currentJob.done;
    };

    currentJob = this.appServerRunner.start(binding, input, existingThreadId, primaryHooks);

    const done = (async (): Promise<CodexRunResult> => {
      const primaryResult = await currentJob.done;

      if (primaryResult.success) {
        await flushPendingThread();
        await hooks.onExit?.(primaryResult);
        return primaryResult;
      }

      const fallbackReason = primaryResult.stderr.find((line) => line.trim()) ?? 'app-server unavailable';
      const canFallback = !cancelled
        && !appServerEngaged
        && !threadForwarded;

      if (canFallback) {
        return startLegacyFallback(fallbackReason);
      }

      await flushPendingThread();
      await hooks.onExit?.(primaryResult);
      return primaryResult;
    })();

    return {
      get pid() {
        return currentJob?.pid;
      },
      get driverMode() {
        return currentJob?.driverMode ?? 'app-server';
      },
      cancel: () => {
        cancelled = true;
        currentJob?.cancel();
      },
      get steer() {
        return currentJob?.steer;
      },
      done,
    };
  }

  async setGoal(binding: ChannelBinding, existingThreadId: string | undefined, objective: string): Promise<string> {
    return this.appServerRunner.setGoal(binding, existingThreadId, objective);
  }

  async clearGoal(binding: ChannelBinding, existingThreadId: string | undefined): Promise<void> {
    await this.appServerRunner.clearGoal(binding, existingThreadId);
  }

  async stop(): Promise<void> {
    await this.appServerRunner.stop?.();
  }
}

function gateHooksAfterFallbackNotice(hooks: CodexRunHooks, gate: Promise<unknown>): CodexRunHooks {
  const waitForGate = async (): Promise<void> => {
    await gate;
  };

  return {
    onThreadStarted: async (threadId) => {
      await waitForGate();
      await hooks.onThreadStarted?.(threadId);
    },
    onActivity: async (activity) => {
      await waitForGate();
      await hooks.onActivity?.(activity);
    },
    onReasoning: async (message) => {
      await waitForGate();
      await hooks.onReasoning?.(message);
    },
    onTodoListChanged: async (items) => {
      await waitForGate();
      await hooks.onTodoListChanged?.(items);
    },
    onCollabToolChanged: async (item) => {
      await waitForGate();
      await hooks.onCollabToolChanged?.(item);
    },
    onAgentMessage: async (message) => {
      await waitForGate();
      await hooks.onAgentMessage?.(message);
    },
    onCommandStarted: async (command) => {
      await waitForGate();
      await hooks.onCommandStarted?.(command);
    },
    onCommandCompleted: async (command, output, exitCode) => {
      await waitForGate();
      await hooks.onCommandCompleted?.(command, output, exitCode);
    },
    onStderr: async (line) => {
      await waitForGate();
      await hooks.onStderr?.(line);
    },
    onExit: async (result) => {
      await waitForGate();
      await hooks.onExit?.(result);
    },
  };
}
