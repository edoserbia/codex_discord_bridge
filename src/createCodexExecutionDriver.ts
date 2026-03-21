import type { AppConfig } from './config.js';
import type { CodexExecutionDriver } from './codexRunner.js';

import { CodexRunner } from './codexRunner.js';
import { ResilientCodexExecutionDriver } from './resilientCodexExecutionDriver.js';

export function createCodexExecutionDriver(config: AppConfig): CodexExecutionDriver {
  if ((config.codexDriverMode ?? 'app-server') === 'app-server') {
    return new ResilientCodexExecutionDriver(config);
  }

  return new CodexRunner(config);
}
