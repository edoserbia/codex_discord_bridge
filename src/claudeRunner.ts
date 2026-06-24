import { once } from 'node:events';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

import type { AppConfig } from './config.js';
import type { ApprovalPolicy, ChannelBinding, ClaudePermissionRequest, CodexRunInput, CodexRunResult, CommandRecord } from './types.js';
import type { CodexExecutionDriver, CodexRunHooks, RunningCodexJob } from './codexRunner.js';

import { buildCodexChildEnv } from './codexChildEnv.js';
import { readEffectiveClaudeModelSync } from './claudeSettings.js';
import { uniqueStrings } from './utils.js';

export class ClaudeRunner implements CodexExecutionDriver {
  constructor(private readonly config: AppConfig) {}

  start(
    binding: ChannelBinding,
    input: CodexRunInput,
    existingSessionId: string | undefined,
    hooks: CodexRunHooks = {},
  ): RunningCodexJob {
    const usedResume = Boolean(existingSessionId);
    const args = this.buildArgs(binding, input, existingSessionId);
    const env = buildCodexChildEnv(binding.workspacePath);
    let cancelRequested = false;
    const child = spawn(this.config.claudeCommand, args, {
      cwd: binding.workspacePath,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    const commands: CommandRecord[] = [];
    const agentMessages: string[] = [];
    const reasoning: string[] = [];
    const stderr: string[] = [];
    const claudePermissionRequests: ClaudePermissionRequest[] = [];
    let claudeSessionId = existingSessionId;
    let turnCompleted = false;
    let stdoutChain = Promise.resolve();
    let stderrChain = Promise.resolve();

    const appendDiagnosticLine = (line: string): void => {
      if (!line.trim() || stderr.at(-1) === line) {
        return;
      }

      stderr.push(line);
    };

    const emitDiagnosticLine = async (line: string): Promise<void> => {
      appendDiagnosticLine(line);
      await hooks.onStderr?.(line);
    };

    const publishSessionId = async (sessionId: string): Promise<void> => {
      if (sessionId === claudeSessionId) {
        return;
      }

      claudeSessionId = sessionId;
      await hooks.onThreadStarted?.(sessionId);
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

        await this.handleStreamEvent(event, {
          publishSessionId,
          appendAgentMessage: async (message) => {
            agentMessages.push(message);
            await hooks.onAgentMessage?.(message);
          },
          appendDiagnostic: emitDiagnosticLine,
          appendPermissionRequest: async (request) => {
            if (!claudePermissionRequests.some((candidate) => candidate.id === request.id)) {
              claudePermissionRequests.push(request);
            }
            const description = request.description ? ` · ${request.description}` : '';
            await emitDiagnosticLine(`Claude permission required [${request.id}]: ${request.toolPattern}${description}`);
          },
          markCompleted: () => {
            turnCompleted = true;
          },
        });
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
          ? `Claude process interrupted by ${signal}.`
          : 'Claude process cancelled by bridge.';
        appendDiagnosticLine(cancellationMessage);
        await hooks.onStderr?.(cancellationMessage);
      }

      const result: CodexRunResult = {
        engine: 'claude',
        success: exitCode === 0 && turnCompleted,
        exitCode,
        signal,
        codexThreadId: undefined,
        claudeSessionId,
        usedResume,
        turnCompleted,
        agentMessages,
        reasoning,
        planItems: [],
        stderr,
        commands,
        claudePermissionRequests: claudePermissionRequests.length > 0 ? claudePermissionRequests : undefined,
      };

      await hooks.onExit?.(result);
      return result;
    })();

    return {
      pid: child.pid,
      driverMode: 'claude-cli',
      cancel: () => {
        cancelRequested = true;
        terminateChild(child);
      },
      done,
    };
  }

  private buildArgs(binding: ChannelBinding, input: CodexRunInput, existingSessionId: string | undefined): string[] {
    const args = ['-p', '--verbose', '--input-format', 'text', '--output-format', 'stream-json'];

    if (existingSessionId) {
      args.push('--resume', existingSessionId);
    }

    const effectiveClaudeModel = readEffectiveClaudeModelSync(binding.workspacePath, this.config.claudeSettingsPath).model;
    if (effectiveClaudeModel) {
      args.push('--model', effectiveClaudeModel);
    }

    args.push('--permission-mode', resolveClaudePermissionMode(binding.codex.sandboxMode, binding.codex.approvalPolicy));

    for (const addDir of uniqueStrings([...binding.codex.addDirs, ...input.extraAddDirs])) {
      args.push('--add-dir', addDir);
    }

    return args;
  }

  private async handleStreamEvent(
    event: Record<string, unknown>,
    handlers: {
      publishSessionId: (sessionId: string) => Promise<void>;
      appendAgentMessage: (message: string) => Promise<void>;
      appendDiagnostic: (line: string) => Promise<void>;
      appendPermissionRequest: (request: ClaudePermissionRequest) => Promise<void>;
      markCompleted: () => void;
    },
  ): Promise<void> {
    const sessionId = extractString(event.session_id ?? event.sessionId);
    if (sessionId) {
      await handlers.publishSessionId(sessionId);
    }

    const type = extractString(event.type);
    if (type === 'assistant') {
      const text = extractClaudeAssistantText(event);
      if (text) {
        await handlers.appendAgentMessage(text);
      }
      return;
    }

    if (type === 'permission_request' || type === 'permission-request' || type === 'tool_permission') {
      const request = extractClaudePermissionRequest(event);
      if (request) {
        await handlers.appendPermissionRequest(request);
      }
      return;
    }

    if (type === 'result') {
      const error = extractString(event.error);
      if (error) {
        await handlers.appendDiagnostic(`Claude error: ${error}`);
        return;
      }

      const resultText = extractString(event.result);
      if (resultText) {
        await handlers.appendAgentMessage(resultText);
      }

      handlers.markCompleted();
    }
  }
}

function resolveClaudePermissionMode(
  sandboxMode: ChannelBinding['codex']['sandboxMode'],
  approvalPolicy: ApprovalPolicy,
): 'default' | 'bypassPermissions' {
  return sandboxMode === 'danger-full-access' && approvalPolicy === 'never'
    ? 'bypassPermissions'
    : 'default';
}

function extractString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined;
}

function extractClaudeAssistantText(event: Record<string, unknown>): string | undefined {
  const message = event.message as Record<string, unknown> | undefined;
  const content = Array.isArray(message?.content)
    ? message.content
    : Array.isArray(event.content)
      ? event.content
      : undefined;

  if (!content) {
    return extractString(event.text);
  }

  const parts = content.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }

    const candidate = item as Record<string, unknown>;
    const text = extractString(candidate.text);
    return text ? [text] : [];
  });

  return parts.join('\n').trim() || undefined;
}

function extractClaudePermissionRequest(event: Record<string, unknown>): ClaudePermissionRequest | undefined {
  const id = extractString(event.id ?? event.request_id ?? event.requestId)
    ?? `claude-${Math.random().toString(16).slice(2, 10)}`;
  const toolPattern = extractString(
    event.toolPattern
      ?? event.tool_pattern
      ?? event.tool
      ?? event.tool_name
      ?? event.toolName,
  );

  if (!toolPattern) {
    return undefined;
  }

  return {
    id,
    toolPattern,
    description: extractString(event.description ?? event.reason ?? event.message),
  };
}

function terminateChild(child: ReturnType<typeof spawn>): void {
  if (!child.pid || child.killed) {
    return;
  }

  try {
    if (process.platform === 'win32') {
      child.kill('SIGTERM');
      return;
    }

    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}
