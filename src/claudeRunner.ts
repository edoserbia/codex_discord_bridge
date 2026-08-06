import { once } from 'node:events';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

import type { AppConfig } from './config.js';
import type { ApprovalPolicy, ChannelBinding, ClaudePermissionRequest, CodexRunInput, CodexRunResult, CommandRecord } from './types.js';
import type { CodexExecutionDriver, CodexRunHooks, RunningCodexJob } from './codexRunner.js';

import { buildCodexChildEnv } from './codexChildEnv.js';
import { readEffectiveClaudeModelSync } from './claudeSettings.js';
import { uniqueStrings } from './utils.js';

interface ClaudeToolCallState {
  id: string;
  name: string;
  command?: string | undefined;
  input: Record<string, unknown>;
  inputJson: string;
  started: boolean;
  completed: boolean;
}

interface ClaudeStreamHandlers {
  publishSessionId: (sessionId: string) => Promise<void>;
  appendDiagnostic: (line: string) => Promise<void>;
  appendPermissionRequest: (request: ClaudePermissionRequest) => Promise<void>;
  startAssistantMessage: () => void;
  appendAssistantText: (message: string, mode: 'delta' | 'snapshot') => Promise<void>;
  onActivity: (activity: string) => Promise<void>;
  onCommandStarted: (command: string) => Promise<void>;
  onCommandCompleted: (command: string, output: string, exitCode: number | null) => Promise<void>;
  markCompleted: () => void;
  toolCalls: Map<string, ClaudeToolCallState>;
  toolIdsByBlockIndex: Map<number, string>;
}

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
    const toolCalls = new Map<string, ClaudeToolCallState>();
    const toolIdsByBlockIndex = new Map<number, string>();
    let assistantTextBuffer = '';
    let assistantMessageIndex: number | undefined;
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
          appendDiagnostic: emitDiagnosticLine,
          appendPermissionRequest: async (request) => {
            if (!claudePermissionRequests.some((candidate) => candidate.id === request.id)) {
              claudePermissionRequests.push(request);
            }
            const description = request.description ? ` · ${request.description}` : '';
            await emitDiagnosticLine(`Claude permission required [${request.id}]: ${request.toolPattern}${description}`);
          },
          startAssistantMessage: () => {
            assistantTextBuffer = '';
            assistantMessageIndex = undefined;
            toolIdsByBlockIndex.clear();
          },
          appendAssistantText: async (message, mode) => {
            if (mode === 'delta') {
              if (!message) {
                return;
              }
              assistantTextBuffer += message;
            } else {
              const normalized = message.trim();
              if (!normalized) {
                return;
              }
              if (normalized !== assistantTextBuffer.trim()) {
                assistantTextBuffer = normalized;
              }
            }

            const nextMessage = assistantTextBuffer.trim();
            if (!nextMessage) {
              return;
            }
            const previousMessage = assistantMessageIndex === undefined
              ? undefined
              : agentMessages[assistantMessageIndex];
            if (assistantMessageIndex === undefined) {
              agentMessages.push(nextMessage);
              assistantMessageIndex = agentMessages.length - 1;
            } else {
              agentMessages[assistantMessageIndex] = nextMessage;
            }
            if (previousMessage !== nextMessage) {
              await hooks.onAgentMessage?.(nextMessage);
            }
          },
          onActivity: async (activity) => hooks.onActivity?.(activity),
          onCommandStarted: async (command) => hooks.onCommandStarted?.(command),
          onCommandCompleted: async (command, output, exitCode) => {
            commands.push({ command, output, exitCode });
            await hooks.onCommandCompleted?.(command, output, exitCode);
          },
          markCompleted: () => {
            turnCompleted = true;
          },
          toolCalls,
          toolIdsByBlockIndex,
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
    const args = [
      '-p',
      '--verbose',
      '--input-format',
      'text',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
    ];

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
    handlers: ClaudeStreamHandlers,
  ): Promise<void> {
    const sessionId = extractString(event.session_id ?? event.sessionId);
    if (sessionId) {
      await handlers.publishSessionId(sessionId);
    }

    const type = extractString(event.type);
    if (type === 'system' || type === 'turn_started' || type === 'turn-started') {
      await handlers.onActivity('Claude 正在分析请求');
      return;
    }

    if (type === 'stream_event') {
      const nestedEvent = asRecord(event.event);
      if (nestedEvent) {
        await handleClaudePartialEvent(nestedEvent, handlers);
      }
      return;
    }

    if (type === 'assistant') {
      await handleClaudeContentMessage(event.message ?? event, handlers);
      return;
    }

    if (type === 'user') {
      await handleClaudeContentMessage(event.message ?? event, handlers);
      if (event.tool_use_result || event.toolUseResult) {
        await handleClaudeToolResult(event, handlers);
      }
      return;
    }

    if (type === 'tool_result' || type === 'tool-result' || type === 'tool_use_result' || type === 'tool-use-result') {
      await handleClaudeToolResult(event, handlers);
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
      const subtype = extractString(event.subtype);
      const isError = event.is_error === true
        || event.isError === true
        || Boolean(subtype && /error|fail|denied|invalid/i.test(subtype));
      const error = extractString(event.error) ?? (isError ? extractString(event.result) : undefined);
      if (isError || error) {
        await handlers.appendDiagnostic(`Claude error: ${error ?? subtype ?? 'unknown failure'}`);
        await handlers.onActivity('Claude 本轮失败');
        return;
      }

      const resultText = extractString(event.result);
      if (resultText) {
        await handlers.appendAssistantText(resultText, 'snapshot');
      }

      handlers.markCompleted();
      await handlers.onActivity('本轮已完成');
    }
  }
}

async function handleClaudePartialEvent(
  event: Record<string, unknown>,
  handlers: ClaudeStreamHandlers,
): Promise<void> {
  const type = extractString(event.type);

  if (type === 'message_start') {
    handlers.startAssistantMessage();
    await handlers.onActivity('Claude 正在分析请求');
    return;
  }

  if (type === 'content_block_start') {
    const index = typeof event.index === 'number' ? event.index : undefined;
    const block = asRecord(event.content_block);
    if (!block || index === undefined || extractString(block.type) !== 'tool_use') {
      return;
    }

    const id = extractString(block.id) ?? `claude-tool-${index}`;
    handlers.toolIdsByBlockIndex.set(index, id);
    ensureClaudeToolCall(handlers, id, extractString(block.name) ?? 'unknown', block.input);
    return;
  }

  if (type === 'content_block_delta') {
    const index = typeof event.index === 'number' ? event.index : undefined;
    const delta = asRecord(event.delta);
    if (!delta) {
      return;
    }

    const deltaType = extractString(delta.type);
    if (deltaType === 'text_delta') {
      const text = typeof delta.text === 'string' ? delta.text : undefined;
      if (text !== undefined && text.length > 0) {
        await handlers.appendAssistantText(text, 'delta');
      }
      return;
    }

    if (deltaType === 'input_json_delta' && index !== undefined) {
      const id = handlers.toolIdsByBlockIndex.get(index);
      const partialJson = typeof delta.partial_json === 'string' ? delta.partial_json : undefined;
      if (id && partialJson !== undefined) {
        const toolCall = handlers.toolCalls.get(id);
        if (toolCall) {
          toolCall.inputJson += partialJson;
        }
      }
    }
    return;
  }

  if (type === 'content_block_stop') {
    const index = typeof event.index === 'number' ? event.index : undefined;
    if (index === undefined) {
      return;
    }

    const id = handlers.toolIdsByBlockIndex.get(index);
    const toolCall = id ? handlers.toolCalls.get(id) : undefined;
    if (toolCall) {
      await finalizeClaudeToolCall(toolCall, handlers);
    }
    return;
  }

  if (type === 'message_stop') {
    await handlers.onActivity('Claude 正在等待工具结果');
  }
}

async function handleClaudeContentMessage(
  event: unknown,
  handlers: ClaudeStreamHandlers,
): Promise<void> {
  const record = asRecord(event);
  if (!record) {
    return;
  }

  const content: unknown[] | undefined = Array.isArray(record.content)
    ? record.content
    : Array.isArray(asRecord(record.message)?.content)
      ? asRecord(record.message)?.content as unknown[]
      : undefined;

  if (!content) {
    const text = extractString(record.text);
    if (text) {
      await handlers.appendAssistantText(text, 'snapshot');
    }
    return;
  }

  const text = content
    .flatMap((item) => {
      const block = asRecord(item);
      const value = block && extractString(block.type) === 'text'
        ? extractString(block.text)
        : undefined;
      return value ? [value] : [];
    })
    .join('\n')
    .trim();
  if (text) {
    await handlers.appendAssistantText(text, 'snapshot');
  }

  for (const item of content) {
    const block = asRecord(item);
    if (!block) {
      continue;
    }

    const type = extractString(block.type);
    if (type === 'text') {
      continue;
    }

    if (type === 'tool_use') {
      const id = extractString(block.id) ?? `claude-tool-${Math.random().toString(16).slice(2, 10)}`;
      const toolCall = ensureClaudeToolCall(handlers, id, extractString(block.name) ?? 'unknown', block.input);
      await finalizeClaudeToolCall(toolCall, handlers);
      continue;
    }

    if (type === 'tool_result') {
      await handleClaudeToolResult(block, handlers);
    }
  }
}

async function handleClaudeToolResult(
  event: Record<string, unknown>,
  handlers: ClaudeStreamHandlers,
): Promise<void> {
  const block = extractClaudeToolResultBlock(event);
  if (!block) {
    return;
  }

  const id = extractString(block.tool_use_id ?? block.toolUseId ?? block.id);
  const toolCall = id ? handlers.toolCalls.get(id) : undefined;
  if (!toolCall || toolCall.completed) {
    return;
  }

  const output = extractClaudeToolResultOutput(block);
  const exitCode = typeof block.exit_code === 'number'
    ? block.exit_code
    : typeof block.exitCode === 'number'
      ? block.exitCode
      : block.is_error === true || block.isError === true
        ? 1
        : 0;

  toolCall.completed = true;
  if (toolCall.command) {
    await handlers.onCommandCompleted(toolCall.command, output, exitCode);
  } else {
    await handlers.onActivity(`Claude 工具已完成：${toolCall.name}`);
  }
}

function ensureClaudeToolCall(
  handlers: ClaudeStreamHandlers,
  id: string,
  name: string,
  input: unknown,
): ClaudeToolCallState {
  const existing = handlers.toolCalls.get(id);
  if (existing) {
    const inputRecord = asRecord(input);
    if (inputRecord) {
      existing.input = { ...existing.input, ...inputRecord };
    }
    return existing;
  }

  const inputRecord = asRecord(input) ?? {};
  const state: ClaudeToolCallState = {
    id,
    name,
    command: undefined,
    input: inputRecord,
    inputJson: '',
    started: false,
    completed: false,
  };
  handlers.toolCalls.set(id, state);
  return state;
}

async function finalizeClaudeToolCall(
  toolCall: ClaudeToolCallState,
  handlers: ClaudeStreamHandlers,
): Promise<void> {
  if (toolCall.inputJson.trim()) {
    try {
      const parsed = JSON.parse(toolCall.inputJson) as unknown;
      const input = asRecord(parsed);
      if (input) {
        toolCall.input = { ...toolCall.input, ...input };
      }
    } catch {
      await handlers.appendDiagnostic(`Claude tool input was not valid JSON: ${toolCall.name}`);
    }
  }

  const command = extractClaudeToolCommand(toolCall.name, toolCall.input);
  if (command && !toolCall.started) {
    toolCall.command = command;
    toolCall.started = true;
    await handlers.onCommandStarted(command);
    return;
  }

  if (!toolCall.started) {
    toolCall.started = true;
    await handlers.onActivity(`Claude 正在使用工具：${toolCall.name}`);
  }
}

function extractClaudeToolCommand(name: string, input: Record<string, unknown>): string | undefined {
  const normalizedName = name.trim().toLowerCase();
  if (!['bash', 'shell', 'command', 'run_shell_command', 'computer_bash'].includes(normalizedName)) {
    return undefined;
  }

  return extractString(input.command ?? input.cmd ?? input.script);
}

function extractClaudeToolResultBlock(event: Record<string, unknown>): Record<string, unknown> | undefined {
  if (extractString(event.type) === 'tool_result') {
    return event;
  }

  const nested = asRecord(event.tool_use_result ?? event.toolUseResult ?? event.result);
  return nested ? { ...event, ...nested } : event;
}

function extractClaudeToolResultOutput(block: Record<string, unknown>): string {
  const direct = block.content ?? block.output ?? block.stdout ?? block.stderr;
  if (typeof direct === 'string') {
    return direct;
  }

  if (Array.isArray(direct)) {
    return direct
      .flatMap((item) => {
        if (typeof item === 'string') {
          return [item];
        }

        const record = asRecord(item);
        const text = record ? extractString(record.text ?? record.content) : undefined;
        return text ? [text] : [];
      })
      .join('\n');
  }

  return '';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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
