import type { AppConfig } from './config.js';
import type { AppServerTurnEvent, ChannelBinding, CodexRunInput, CodexRunResult, CommandRecord, PlanItem } from './types.js';
import type { CodexExecutionDriver, CodexRunHooks, RunningCodexJob } from './codexRunner.js';

import { CodexAppServerClient } from './codexAppServerClient.js';
import { extractReasoningText, parseCollabToolCall } from './codexRunner.js';

interface AppServerCommandBuffer {
  command: string;
  output: string;
}

export class CodexAppServerRunner implements CodexExecutionDriver {
  private readonly client: CodexAppServerClient;

  constructor(config: AppConfig) {
    this.client = new CodexAppServerClient(config);
  }

  start(
    binding: ChannelBinding,
    input: CodexRunInput,
    existingThreadId: string | undefined,
    hooks: CodexRunHooks = {},
  ): RunningCodexJob {
    const usedResume = Boolean(existingThreadId);
    const commands: CommandRecord[] = [];
    const commandBuffers = new Map<string, AppServerCommandBuffer>();
    const agentMessageBuffers = new Map<string, string>();
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
      const normalized = line.trim();

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
          await emitDiagnosticLine('Codex turn failed.');
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
          let buffer = commandBuffers.get(event.itemId);
          if (!buffer) {
            const command = event.delta.trim() || 'command output';
            buffer = { command, output: '' };
            commandBuffers.set(event.itemId, buffer);
            await hooks.onCommandStarted?.(command);
          }

          buffer.output += event.delta;
          break;
        }
        case 'item.started': {
          if (event.item.type === 'commandExecution' && typeof event.item.command === 'string') {
            let buffer = commandBuffers.get(String(event.item.id ?? ''));
            if (!buffer) {
              buffer = {
                command: event.item.command,
                output: '',
              };
              commandBuffers.set(String(event.item.id ?? ''), buffer);
            }
            await hooks.onCommandStarted?.(event.item.command);
          }

          if (event.item.type === 'collabAgentToolCall') {
            const collabToolCall = parseCollabToolCall(event.item);
            if (collabToolCall) {
              await hooks.onCollabToolChanged?.(collabToolCall);
            }
          }
          break;
        }
        case 'item.completed': {
          if (event.item.type === 'reasoning') {
            const reasoningText = extractReasoningText(event.item);
            if (reasoningText) {
              reasoning.push(reasoningText);
              await hooks.onReasoning?.(reasoningText);
            }
          }

          if (event.item.type === 'commandExecution' && typeof event.item.command === 'string') {
            const output = typeof event.item.aggregatedOutput === 'string' ? event.item.aggregatedOutput : '';
            const exitCode = typeof event.item.exitCode === 'number' ? event.item.exitCode : null;
            commands.push({
              command: event.item.command,
              output,
              exitCode,
            });
            commandBuffers.delete(String(event.item.id ?? ''));
            await hooks.onCommandCompleted?.(event.item.command, output, exitCode);
          }

          if (event.item.type === 'collabAgentToolCall') {
            const collabToolCall = parseCollabToolCall(event.item);
            if (collabToolCall) {
              await hooks.onCollabToolChanged?.(collabToolCall);
            }
          }
          break;
        }
        case 'agent.message.delta': {
          const nextMessage = `${agentMessageBuffers.get(event.itemId) ?? ''}${event.delta}`;
          agentMessageBuffers.set(event.itemId, nextMessage);
          if (agentMessages.at(-1) !== nextMessage) {
            agentMessages.push(nextMessage);
            await hooks.onAgentMessage?.(nextMessage);
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
        const threadId = await this.client.ensureThread(binding, existingThreadId);
        codexThreadId = threadId;
        if (threadId !== existingThreadId) {
          await hooks.onThreadStarted?.(threadId);
        }

        const turn = await this.client.startTurn(binding, threadId, {
          prompt: input.prompt,
          imagePaths: input.imagePaths,
          extraAddDirs: input.extraAddDirs,
          onEvent: handleEvent,
        });
        turnContext = { threadId, turnId: turn.turnId };
        resolveTurnReady(turnContext);

        if (cancelRequested) {
          await this.client.interruptTurn(threadId, turn.turnId);
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

        void this.client.interruptTurn(turnContext.threadId, turnContext.turnId).catch((error) => {
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

        await this.client.steerTurn(activeTurn.threadId, activeTurn.turnId, prompt);
      },
      done,
    };
  }

  async stop(): Promise<void> {
    await this.client.stop();
  }
}
