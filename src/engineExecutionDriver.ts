import type { AppConfig } from './config.js';
import type { ChannelBinding, CodexRunInput } from './types.js';
import type { CodexExecutionDriver, CodexRunHooks, RunningCodexJob } from './codexRunner.js';

import { ClaudeRunner } from './claudeRunner.js';

export class EngineExecutionDriver implements CodexExecutionDriver {
  private readonly claudeRunner: ClaudeRunner;

  constructor(
    config: AppConfig,
    private readonly codexDriver: CodexExecutionDriver,
  ) {
    this.claudeRunner = new ClaudeRunner(config);
  }

  start(
    binding: ChannelBinding,
    input: CodexRunInput,
    existingThreadId: string | undefined,
    hooks: CodexRunHooks = {},
  ): RunningCodexJob {
    if (input.engine === 'claude') {
      return this.claudeRunner.start(binding, input, existingThreadId, hooks);
    }

    return this.codexDriver.start(binding, input, existingThreadId, hooks);
  }

  async stop(): Promise<void> {
    await this.codexDriver.stop?.();
  }
}
