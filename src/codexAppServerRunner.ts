import type { AppConfig } from './config.js';
import type { AppServerTurnEvent, ChannelBinding, CodexRunInput, CodexRunResult, CommandRecord, PlanItem } from './types.js';
import type { CodexExecutionDriver, CodexRunHooks, RunningCodexJob } from './codexRunner.js';

import { normalizeCodexDiagnosticLine } from './codexDiagnostics.js';
import { CodexAppServerClient } from './codexAppServerClient.js';
import { extractReasoningText, parseCollabToolCall, parsePlanItems } from './codexRunner.js';

interface AppServerCommandBuffer {
  command: string;
  output: string;
  started: boolean;
}

export class CodexAppServerRunner implements CodexExecutionDriver {
  private readonly clients = new Map<string, CodexAppServerClient>();

  constructor(private readonly config: AppConfig) {}

  start(
    binding: ChannelBinding,
    input: CodexRunInput,
    existingThreadId: string | undefined,
    hooks: CodexRunHooks = {},
  ): RunningCodexJob {
    const client = this.getClient(binding.workspacePath);
    const usedResume = Boolean(existingThreadId);
    const commands: CommandRecord[] = [];
    const commandBuffers = new Map<string, AppServerCommandBuffer>();
    const completedCommandItemIds = new Set<string>();
    const agentMessageBuffers = new Map<string, string>();
    const agentMessageItemOrder: string[] = [];
    const reasoningBuffers = new Map<string, string>();
    const agentMessages: string[] = [];
    const reasoning: string[] = [];
    const stderr: string[] = [];
    let planItems: PlanItem[] = [];
    let codexThreadId = existingThreadId;
    let cancelRequested = false;
    let finished = false;
    let turnContext: { threadId: string; turnId: string } | undefined;
    let resolveTurnReady!: (context: { threadId: string; turnId: string } | undefined) => void;
    const turnReady = new Promise<{ threadId: string; turnId: string } | undefined>((resolve) => {
      resolveTurnReady = resolve;
    });

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

    const flushCommandBuffers = async (exitCode: number | null): Promise<void> => {
      for (const buffer of commandBuffers.values()) {
        commands.push({
          command: buffer.command,
          output: buffer.output,
          exitCode,
        });
        await hooks.onCommandCompleted?.(buffer.command, buffer.output, exitCode);
      }

      commandBuffers.clear();
    };

    const buildVisibleAgentMessage = (): string => {
      const parts = agentMessageItemOrder
        .map((itemId) => agentMessageBuffers.get(itemId)?.trim() ?? '')
        .filter((value) => value.length > 0);

      if (parts.length === 0) {
        return '';
      }

      return parts.join('\n\n');
    };

    const handleEvent = async (event: AppServerTurnEvent): Promise<void> => {
      switch (event.type) {
        case 'turn.started':
          turnContext = { threadId: event.threadId, turnId: event.turnId };
          await hooks.onActivity?.('Codex 正在分析请求');
          break;
        case 'turn.steered':
          await hooks.onActivity?.('已收到新的中途引导');
          break;
        case 'turn.completed':
          await flushCommandBuffers(0);
          await hooks.onActivity?.('本轮已完成');
          break;
        case 'turn.failed':
          await flushCommandBuffers(null);
          await emitDiagnosticLine(event.message ? `Codex turn failed: ${event.message}` : 'Codex turn failed.');
          break;
        case 'turn.interrupted':
          await flushCommandBuffers(null);
          await hooks.onActivity?.('当前轮次已中断');
          break;
        case 'plan.updated':
          planItems = event.plan.map((item, index) => ({
            id: `${event.turnId}:${index}`,
            text: item.step,
            completed: item.status === 'completed',
          }));
          await hooks.onTodoListChanged?.(planItems);
          break;
        case 'command.output.delta': {
          if (completedCommandItemIds.has(event.itemId)) {
            break;
          }

          let buffer = commandBuffers.get(event.itemId);
          if (!buffer) {
            const command = event.delta.trim() || 'command output';
            buffer = { command, output: '', started: true };
            commandBuffers.set(event.itemId, buffer);
            await hooks.onCommandStarted?.(command);
          }

          buffer.output += event.delta;
          break;
        }
        case 'item.started':
        case 'item.updated':
        case 'item.completed': {
          const itemType = normalizeAppServerItemType(event.item.type);

          if (itemType === 'todo_list') {
            const hasRawTodoItems = Array.isArray(event.item.items);
            const nextPlanItems = parsePlanItems(event.item.items, planItems);
            if (hasRawTodoItems) {
              planItems = nextPlanItems;
              await hooks.onTodoListChanged?.(nextPlanItems);
            }
          }

          if (itemType === 'reasoning') {
            const reasoningText = extractReasoningText(event.item);
            if (reasoningText) {
              reasoningBuffers.set(readAppServerItemId(event.item), reasoningText);
              if (reasoning.at(-1) !== reasoningText) {
                reasoning.push(reasoningText);
              }
              await hooks.onReasoning?.(reasoningText);
            }
          }

          if (itemType === 'agent_message') {
            const itemId = readAppServerItemId(event.item);
            const messageText = extractAgentMessageText(event.item);
            if (messageText) {
              if (!agentMessageBuffers.has(itemId)) {
                agentMessageItemOrder.push(itemId);
              }
              agentMessageBuffers.set(itemId, messageText);
              const visibleMessage = buildVisibleAgentMessage();
              if (visibleMessage && agentMessages.at(-1) !== visibleMessage) {
                agentMessages.push(visibleMessage);
                await hooks.onAgentMessage?.(visibleMessage);
              }
            }
          }

          if (itemType === 'command_execution') {
            const command = readCommandText(event.item);
            if (!command) {
              break;
            }

            let buffer = commandBuffers.get(readAppServerItemId(event.item));
            if (!buffer) {
              buffer = {
                command,
                output: '',
                started: false,
              };
              commandBuffers.set(readAppServerItemId(event.item), buffer);
            }

            buffer.command = command;
            if (!buffer.started) {
              buffer.started = true;
              await hooks.onCommandStarted?.(command);
            }

            if (event.type === 'item.completed') {
              const output = readCommandOutput(event.item);
              const exitCode = readCommandExitCode(event.item);
              commands.push({
                command,
                output,
                exitCode,
              });
              const itemId = readAppServerItemId(event.item);
              commandBuffers.delete(itemId);
              completedCommandItemIds.add(itemId);
              await hooks.onCommandCompleted?.(command, output, exitCode);
            }
          }

          if (itemType === 'collab_tool_call') {
            const collabToolCall = parseCollabToolCall(event.item);
            if (collabToolCall) {
              await hooks.onCollabToolChanged?.(collabToolCall);
            }
          }
          break;
        }
        case 'agent.message.delta': {
          if (!agentMessageBuffers.has(event.itemId)) {
            agentMessageItemOrder.push(event.itemId);
          }

          const nextMessage = `${agentMessageBuffers.get(event.itemId) ?? ''}${event.delta}`;
          agentMessageBuffers.set(event.itemId, nextMessage);
          const visibleMessage = buildVisibleAgentMessage();
          if (visibleMessage && agentMessages.at(-1) !== visibleMessage) {
            agentMessages.push(visibleMessage);
            await hooks.onAgentMessage?.(visibleMessage);
          }
          break;
        }
        case 'reasoning.summary.delta': {
          const nextSummary = `${reasoningBuffers.get(event.itemId) ?? ''}${event.delta}`;
          reasoningBuffers.set(event.itemId, nextSummary);
          await hooks.onReasoning?.(nextSummary);
          break;
        }
      }
    };

    const done = (async (): Promise<CodexRunResult> => {
      try {
        const threadId = await client.ensureThread(binding, existingThreadId);
        codexThreadId = threadId;
        if (threadId !== existingThreadId) {
          await hooks.onThreadStarted?.(threadId);
        }

        const turn = await client.startTurn(binding, threadId, {
          prompt: input.prompt,
          imagePaths: input.imagePaths,
          extraAddDirs: input.extraAddDirs,
          onEvent: handleEvent,
        });
        turnContext = { threadId, turnId: turn.turnId };
        resolveTurnReady(turnContext);

        if (cancelRequested) {
          await client.interruptTurn(threadId, turn.turnId);
        }

        const turnResult = await turn.done;
        finished = true;

        const result: CodexRunResult = {
          success: turnResult.success,
          exitCode: turnResult.success ? 0 : null,
          signal: null,
          codexThreadId,
          usedResume,
          turnCompleted: turnResult.success,
          agentMessages,
          reasoning,
          planItems,
          stderr,
          commands,
        };

        await hooks.onExit?.(result);
        return result;
      } catch (error) {
        finished = true;
        resolveTurnReady(turnContext);
        const message = error instanceof Error ? error.message : String(error);
        await emitDiagnosticLine(message);
        await flushCommandBuffers(null);

        const result: CodexRunResult = {
          success: false,
          exitCode: null,
          signal: null,
          codexThreadId,
          usedResume,
          turnCompleted: false,
          agentMessages,
          reasoning,
          planItems,
          stderr,
          commands,
        };

        await hooks.onExit?.(result);
        return result;
      }
    })();

    return {
      pid: undefined,
      driverMode: 'app-server',
      cancel: () => {
        cancelRequested = true;
        if (finished || !turnContext) {
          return;
        }

        void client.interruptTurn(turnContext.threadId, turnContext.turnId).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          appendDiagnosticLine(message);
        });
      },
      steer: async (prompt: string) => {
        if (finished) {
          return;
        }

        const activeTurn = turnContext ?? await turnReady;
        if (!activeTurn) {
          return;
        }

        await client.steerTurn(activeTurn.threadId, activeTurn.turnId, prompt);
      },
      done,
    };
  }

  async stop(): Promise<void> {
    await Promise.all([...this.clients.values()].map(async (client) => client.stop()));
    this.clients.clear();
  }

  private getClient(workspacePath: string): CodexAppServerClient {
    const existing = this.clients.get(workspacePath);
    if (existing) {
      return existing;
    }

    const client = new CodexAppServerClient(this.config);
    this.clients.set(workspacePath, client);
    return client;
  }
}

function normalizeAppServerItemType(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  switch (value) {
    case 'todo_list':
    case 'agent_message':
    case 'reasoning':
    case 'command_execution':
    case 'collab_tool_call':
      return value;
    case 'commandExecution':
      return 'command_execution';
    case 'collabAgentToolCall':
      return 'collab_tool_call';
    case 'agentMessage':
      return 'agent_message';
    case 'todoList':
      return 'todo_list';
    default:
      return value;
  }
}

function readAppServerItemId(item: Record<string, unknown>): string {
  return typeof item.id === 'string' && item.id.trim() ? item.id.trim() : 'unknown-item';
}

function extractAgentMessageText(item: Record<string, unknown>): string | undefined {
  if (typeof item.text === 'string' && item.text.trim()) {
    return item.text.trim();
  }

  const content = Array.isArray(item.content)
    ? item.content.map(extractTextFragment).filter((value): value is string => Boolean(value)).join('\n').trim()
    : '';

  return content || undefined;
}

function extractTextFragment(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() || undefined;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  for (const key of ['text', 'content', 'value']) {
    const text = candidate[key];
    if (typeof text === 'string' && text.trim()) {
      return text.trim();
    }
  }

  return undefined;
}

function readCommandText(item: Record<string, unknown>): string | undefined {
  return typeof item.command === 'string' && item.command.trim() ? item.command : undefined;
}

function readCommandOutput(item: Record<string, unknown>): string {
  if (typeof item.aggregatedOutput === 'string') {
    return item.aggregatedOutput;
  }

  if (typeof item.aggregated_output === 'string') {
    return item.aggregated_output;
  }

  return '';
}

function readCommandExitCode(item: Record<string, unknown>): number | null {
  if (typeof item.exitCode === 'number') {
    return item.exitCode;
  }

  if (typeof item.exit_code === 'number') {
    return item.exit_code;
  }

  return null;
}
