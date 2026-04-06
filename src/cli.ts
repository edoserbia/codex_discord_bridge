import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { parse as parseDotenv } from 'dotenv';

interface WritableLike {
  write: (chunk: string) => void;
  isTTY?: boolean;
  columns?: number;
}

type ReadableWithTTY = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
};

interface CliRunOptions {
  cwd?: string;
  stdout?: WritableLike;
  stderr?: WritableLike;
  stdin?: NodeJS.ReadableStream;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

interface CliBaseArgs {
  cwd: string;
  json: boolean;
  channelId?: string | undefined;
  projectName?: string | undefined;
  originOverride?: string | undefined;
  authTokenOverride?: string | undefined;
}

type CliParsedArgs =
  | ({ help: true } & CliBaseArgs)
  | ({ help: false; kind: 'autopilot'; commandText: string } & CliBaseArgs)
  | ({ help: false; kind: 'session-status'; codexThreadId: string } & CliBaseArgs)
  | ({ help: false; kind: 'session-send'; codexThreadId: string; prompt: string } & CliBaseArgs)
  | ({ help: false; kind: 'session-resume'; codexThreadId: string } & CliBaseArgs);

const DEFAULT_WEB_PORT = 3769;
const DEFAULT_SECRETS_FILE = path.join(os.homedir(), '.codex-tunning', 'secrets.env');

export async function runCli(args: string[], options: CliRunOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  let parsed: CliParsedArgs;
  try {
    parsed = parseCliArgs(args, options.cwd ?? process.cwd());
  } catch (error) {
    stdout.write(`${buildCliUsage()}\n`);
    if (error instanceof Error && error.message !== 'show_help') {
      stderr.write(`${error.message}\n`);
      return 1;
    }
    return 0;
  }

  if (parsed.help) {
    stdout.write(`${buildCliUsage()}\n`);
    return 0;
  }

  const env = loadCliEnv(options.env ?? process.env);
  const origin = parsed.originOverride?.trim()
    || env.CODEX_DISCORD_BRIDGE_WEB_ORIGIN?.trim()
    || buildDefaultOrigin(env);
  const authToken = parsed.authTokenOverride?.trim()
    || env.CODEX_DISCORD_BRIDGE_WEB_AUTH_TOKEN?.trim()
    || env.WEB_AUTH_TOKEN?.trim()
    || undefined;
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    switch (parsed.kind) {
      case 'autopilot':
        return await runAutopilotCommand(parsed, { origin, authToken, fetchImpl, stdout, stderr });
      case 'session-status':
        return await runSessionStatusCommand(parsed, { origin, authToken, fetchImpl, stdout, stderr });
      case 'session-send':
        return await runSessionSendCommand(parsed, { origin, authToken, fetchImpl, stdout, stderr });
      case 'session-resume':
        return await runSessionResumeCommand(parsed, {
          origin,
          authToken,
          fetchImpl,
          stdout,
          stderr,
          stdin: options.stdin ?? process.stdin,
        });
      default:
        stderr.write('未知命令。\n');
        return 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`bridge 服务不可用：${message}\n`);
    return 1;
  }
}

async function runAutopilotCommand(
  parsed: Extract<CliParsedArgs, { kind: 'autopilot' }>,
  options: {
    origin: string;
    authToken?: string | undefined;
    fetchImpl: typeof fetch;
    stdout: WritableLike;
    stderr: WritableLike;
  },
): Promise<number> {
  const response = await options.fetchImpl(`${options.origin}/api/autopilot/command`, {
    method: 'POST',
    headers: {
      ...(options.authToken ? { authorization: `Bearer ${options.authToken}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      commandText: parsed.commandText,
      channelId: parsed.channelId,
      projectName: parsed.projectName,
      cwd: parsed.cwd,
    }),
  });

  const payload = await readJsonPayload(response);
  if (!response.ok || payload.ok === false) {
    options.stderr.write(`${payload.message?.trim() || `请求失败（HTTP ${response.status}）`}\n`);
    return 1;
  }

  if (parsed.json) {
    options.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    options.stdout.write(`${payload.message?.trim() || 'Autopilot 命令已执行。'}\n`);
  }

  return 0;
}

async function runSessionStatusCommand(
  parsed: Extract<CliParsedArgs, { kind: 'session-status' }>,
  options: {
    origin: string;
    authToken?: string | undefined;
    fetchImpl: typeof fetch;
    stdout: WritableLike;
    stderr: WritableLike;
  },
): Promise<number> {
  const response = await options.fetchImpl(
    `${options.origin}/api/sessions/by-codex-thread/${encodeURIComponent(parsed.codexThreadId)}`,
    {
      headers: buildAuthHeaders(options.authToken),
    },
  );
  const payload = await readJsonPayload(response);

  if (!response.ok) {
    options.stderr.write(`${payload.message?.trim() || `请求失败（HTTP ${response.status}）`}\n`);
    return 1;
  }

  if (parsed.json) {
    options.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  options.stdout.write([
    `Resume ID: ${payload.codexThreadId}`,
    `项目: ${payload.projectName}`,
    `目录: ${payload.workspacePath}`,
    `会话: ${payload.conversationId}`,
    `状态: ${payload.status}`,
    `队列: ${payload.queueLength}`,
    `本机继续: ${payload.resumeCommand}`,
  ].join('\n'));
  options.stdout.write('\n');
  return 0;
}

async function runSessionSendCommand(
  parsed: Extract<CliParsedArgs, { kind: 'session-send' }>,
  options: {
    origin: string;
    authToken?: string | undefined;
    fetchImpl: typeof fetch;
    stdout: WritableLike;
    stderr: WritableLike;
  },
): Promise<number> {
  const response = await options.fetchImpl(
    `${options.origin}/api/sessions/by-codex-thread/${encodeURIComponent(parsed.codexThreadId)}/send`,
    {
      method: 'POST',
      headers: {
        ...buildAuthHeaders(options.authToken),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ prompt: parsed.prompt }),
    },
  );
  const payload = await readJsonPayload(response);

  if (!response.ok || payload.ok === false) {
    options.stderr.write(`${payload.errorMessage?.trim() || payload.message?.trim() || `请求失败（HTTP ${response.status}）`}\n`);
    return 1;
  }

  if (parsed.json) {
    options.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  options.stdout.write(`${payload.assistantMessage?.trim() || '会话消息已发送。'}\n`);
  return 0;
}

async function runSessionResumeCommand(
  parsed: Extract<CliParsedArgs, { kind: 'session-resume' }>,
  options: {
    origin: string;
    authToken?: string | undefined;
    fetchImpl: typeof fetch;
    stdout: WritableLike;
    stderr: WritableLike;
    stdin: NodeJS.ReadableStream;
  },
): Promise<number> {
  const statusExitCode = await runSessionStatusCommand(parsedSessionStatusArgs(parsed), options);
  if (statusExitCode !== 0) {
    return statusExitCode;
  }

  if (supportsInteractiveSessionResume(options.stdin)) {
    return await runInteractiveSessionResume(parsed, options);
  }

  return await runLineBufferedSessionResume(parsed, options);
}

async function runLineBufferedSessionResume(
  parsed: Extract<CliParsedArgs, { kind: 'session-resume' }>,
  options: {
    origin: string;
    authToken?: string | undefined;
    fetchImpl: typeof fetch;
    stdout: WritableLike;
    stderr: WritableLike;
    stdin: NodeJS.ReadableStream;
  },
): Promise<number> {
  options.stdout.write('进入本机会话继续模式。输入普通文本即可继续当前会话，输入 `/status` 查看状态，输入 `/exit` 退出。\n');
  options.stdout.write('> ');

  const lineReader = readline.createInterface({
    input: options.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  for await (const rawLine of lineReader) {
    const line = rawLine.trim();

    if (!line) {
      options.stdout.write('> ');
      continue;
    }

    if (line === '/exit' || line === '/quit') {
      options.stdout.write('已退出会话继续模式。\n');
      lineReader.close();
      return 0;
    }

    if (line === '/status') {
      const exitCode = await runSessionStatusCommand(parsedSessionStatusArgs(parsed), options);
      if (exitCode !== 0) {
        lineReader.close();
        return exitCode;
      }
      options.stdout.write('> ');
      continue;
    }

    const exitCode = await runSessionSendCommand({
      ...parsed,
      kind: 'session-send',
      prompt: line,
    }, options);
    if (exitCode !== 0) {
      lineReader.close();
      return exitCode;
    }

    options.stdout.write('> ');
  }

  options.stdout.write('已退出会话继续模式。\n');
  return 0;
}

async function runInteractiveSessionResume(
  parsed: Extract<CliParsedArgs, { kind: 'session-resume' }>,
  options: {
    origin: string;
    authToken?: string | undefined;
    fetchImpl: typeof fetch;
    stdout: WritableLike;
    stderr: WritableLike;
    stdin: NodeJS.ReadableStream;
  },
): Promise<number> {
  const stdin = options.stdin as ReadableWithTTY;
  const stdout = options.stdout;
  const promptPrefix = '> ';
  const promptState = { renderedLineCount: 0 };
  let buffer = '';
  let pasteMode = false;
  let processing = false;
  let settled = false;
  const bracketedPasteEnabled = stdout.isTTY === true;

  options.stdout.write(
    '进入本机会话继续模式。直接输入后回车发送；多行粘贴会先暂存在输入框中，粘贴完成后再按一次 Enter 整段发送。输入 `/status` 查看状态，输入 `/exit` 退出。\n',
  );

  readline.emitKeypressEvents(stdin);
  stdin.setRawMode?.(true);
  stdin.resume?.();

  if (bracketedPasteEnabled) {
    stdout.write('\u001b[?2004h');
  }
  renderInteractivePrompt(stdout, promptPrefix, buffer, promptState);

  return await new Promise<number>((resolve, reject) => {
    const cleanup = () => {
      stdin.off('keypress', handleKeypress);
      stdin.off('end', handleEnd);
      stdin.off('error', handleError);
      clearInteractivePrompt(stdout, promptState);
      if (bracketedPasteEnabled) {
        stdout.write('\u001b[?2004l');
      }
      stdin.setRawMode?.(false);
      stdin.pause?.();
    };

    const finish = (exitCode: number) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(exitCode);
    };

    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const submitBuffer = async () => {
      if (processing || settled) {
        return;
      }

      const submitted = buffer;
      const trimmed = submitted.trim();
      const isSingleLineCommand = !submitted.includes('\n');

      buffer = '';
      pasteMode = false;
      processing = true;
      commitInteractivePrompt(stdout, promptPrefix, submitted, promptState);

      try {
        if (!trimmed) {
          processing = false;
          renderInteractivePrompt(stdout, promptPrefix, buffer, promptState);
          return;
        }

        if (isSingleLineCommand && (trimmed === '/exit' || trimmed === '/quit')) {
          stdout.write('已退出会话继续模式。\n');
          finish(0);
          return;
        }

        if (isSingleLineCommand && trimmed === '/status') {
          const exitCode = await runSessionStatusCommand(parsedSessionStatusArgs(parsed), options);
          if (exitCode !== 0) {
            finish(exitCode);
            return;
          }
          processing = false;
          renderInteractivePrompt(stdout, promptPrefix, buffer, promptState);
          return;
        }

        const exitCode = await runSessionSendCommand({
          ...parsed,
          kind: 'session-send',
          prompt: submitted,
        }, options);
        if (exitCode !== 0) {
          finish(exitCode);
          return;
        }

        processing = false;
        renderInteractivePrompt(stdout, promptPrefix, buffer, promptState);
      } catch (error) {
        fail(error);
      }
    };

    const handleKeypress = (str: string, key: { name?: string; ctrl?: boolean } = {}) => {
      if (settled) {
        return;
      }

      if (key.ctrl && key.name === 'c') {
        commitInteractivePrompt(stdout, promptPrefix, buffer, promptState);
        stdout.write('已退出会话继续模式。\n');
        finish(0);
        return;
      }

      if (!processing && key.name === 'paste-start') {
        pasteMode = true;
        return;
      }

      if (!processing && key.name === 'paste-end') {
        pasteMode = false;
        renderInteractivePrompt(stdout, promptPrefix, buffer, promptState);
        return;
      }

      if (processing) {
        return;
      }

      if (pasteMode) {
        if (typeof str === 'string' && str.length > 0) {
          buffer += str;
        }
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        void submitBuffer();
        return;
      }

      if (key.name === 'backspace') {
        buffer = buffer.slice(0, -1);
        renderInteractivePrompt(stdout, promptPrefix, buffer, promptState);
        return;
      }

      if (typeof str === 'string' && str.length > 0) {
        buffer += str;
        renderInteractivePrompt(stdout, promptPrefix, buffer, promptState);
      }
    };

    const handleEnd = () => {
      stdout.write('已退出会话继续模式。\n');
      finish(0);
    };

    const handleError = (error: unknown) => {
      fail(error);
    };

    stdin.on('keypress', handleKeypress);
    stdin.on('end', handleEnd);
    stdin.on('error', handleError);
  });
}

function supportsInteractiveSessionResume(stdin: NodeJS.ReadableStream): stdin is ReadableWithTTY {
  return (stdin as ReadableWithTTY).isTTY === true;
}

function renderInteractivePrompt(
  stdout: WritableLike,
  promptPrefix: string,
  buffer: string,
  state: { renderedLineCount: number },
) {
  if (stdout.isTTY !== true) {
    if (state.renderedLineCount === 0) {
      stdout.write(promptPrefix);
      state.renderedLineCount = 1;
    }
    return;
  }

  clearInteractivePrompt(stdout, state);
  stdout.write(`${promptPrefix}${buffer}`);
  state.renderedLineCount = countRenderedPromptLines(buffer);
}

function commitInteractivePrompt(
  stdout: WritableLike,
  promptPrefix: string,
  buffer: string,
  state: { renderedLineCount: number },
) {
  if (stdout.isTTY === true) {
    clearInteractivePrompt(stdout, state);
    stdout.write(`${promptPrefix}${buffer}\n`);
    return;
  }

  if (state.renderedLineCount > 0) {
    stdout.write('\n');
    state.renderedLineCount = 0;
  }
}

function clearInteractivePrompt(stdout: WritableLike, state: { renderedLineCount: number }) {
  if (stdout.isTTY !== true || state.renderedLineCount === 0) {
    return;
  }

  for (let index = 1; index < state.renderedLineCount; index += 1) {
    readline.moveCursor(stdout as NodeJS.WriteStream, 0, -1);
  }
  readline.cursorTo(stdout as NodeJS.WriteStream, 0);
  readline.clearScreenDown(stdout as NodeJS.WriteStream);
  state.renderedLineCount = 0;
}

function countRenderedPromptLines(buffer: string): number {
  return Math.max(1, buffer.split('\n').length);
}

function parsedSessionStatusArgs(
  parsed: Extract<CliParsedArgs, { kind: 'session-resume' }>,
): Extract<CliParsedArgs, { kind: 'session-status' }> {
  return {
    ...parsed,
    kind: 'session-status',
  };
}

async function readJsonPayload(response: Response): Promise<Record<string, any>> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return await response.json() as Record<string, any>;
  }

  return {
    ok: response.ok,
    message: await response.text(),
  };
}

function buildAuthHeaders(authToken: string | undefined): Record<string, string> {
  return authToken ? { authorization: `Bearer ${authToken}` } : {};
}

function parseCliArgs(args: string[], cwd: string): CliParsedArgs {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    throw new Error('show_help');
  }

  const commandTokens: string[] = [];
  let resolvedCwd = cwd;
  let json = false;
  let channelId: string | undefined;
  let projectName: string | undefined;
  let originOverride: string | undefined;
  let authTokenOverride: string | undefined;
  let parseOptions = true;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;

    if (parseOptions && token === '--') {
      parseOptions = false;
      continue;
    }

    if (parseOptions && token === '--cwd') {
      resolvedCwd = readOptionValue(args, ++index, '--cwd');
      continue;
    }

    if (parseOptions && token === '--channel') {
      channelId = readOptionValue(args, ++index, '--channel');
      continue;
    }

    if (parseOptions && token === '--project') {
      projectName = readOptionValue(args, ++index, '--project');
      continue;
    }

    if (parseOptions && token === '--json') {
      json = true;
      continue;
    }

    if (parseOptions && token === '--origin') {
      originOverride = readOptionValue(args, ++index, '--origin');
      continue;
    }

    if (parseOptions && token === '--token') {
      authTokenOverride = readOptionValue(args, ++index, '--token');
      continue;
    }

    commandTokens.push(token);
  }

  const baseArgs: CliBaseArgs = {
    cwd: path.resolve(resolvedCwd),
    json,
    channelId,
    projectName,
    originOverride,
    authTokenOverride,
  };

  if (
    commandTokens[0] === 'autopilot'
    && (
      commandTokens.length === 1
      || (commandTokens.length === 2 && (commandTokens[1] === 'help' || commandTokens[1] === 'usage'))
    )
  ) {
    return {
      help: true,
      ...baseArgs,
    };
  }

  if (commandTokens[0] === 'autopilot') {
    return {
      help: false,
      kind: 'autopilot',
      commandText: `!${commandTokens.join(' ')}`.trim(),
      ...baseArgs,
    };
  }

  if (commandTokens[0] === 'session' && commandTokens[1] === 'status') {
    const codexThreadId = commandTokens[2];
    if (!codexThreadId) {
      throw new Error('`bridgectl session status` 需要提供 Resume ID。');
    }

    return {
      help: false,
      kind: 'session-status',
      codexThreadId,
      ...baseArgs,
    };
  }

  if (commandTokens[0] === 'session' && commandTokens[1] === 'send') {
    const codexThreadId = commandTokens[2];
    const prompt = commandTokens.slice(3).join(' ').trim();
    if (!codexThreadId || !prompt) {
      throw new Error('用法：`bridgectl session send <Resume ID> \"消息内容\"`');
    }

    return {
      help: false,
      kind: 'session-send',
      codexThreadId,
      prompt,
      ...baseArgs,
    };
  }

  if (commandTokens[0] === 'session' && commandTokens[1] === 'resume') {
    const codexThreadId = commandTokens[2];
    if (!codexThreadId) {
      throw new Error('用法：`bridgectl session resume <Resume ID>`');
    }

    return {
      help: false,
      kind: 'session-resume',
      codexThreadId,
      ...baseArgs,
    };
  }

  throw new Error('当前 CLI 仅支持 `autopilot ...` 和 `session ...` 命令。');
}

function readOptionValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`参数 ${flag} 缺少值。`);
  }
  return value;
}

function loadCliEnv(runtimeEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const envFiles = [
    runtimeEnv.CODEX_TUNNING_SECRETS_FILE?.trim() || DEFAULT_SECRETS_FILE,
    path.join(packageRoot, '.env'),
  ];
  const merged: NodeJS.ProcessEnv = {};

  for (const envFile of envFiles) {
    if (!envFile || !existsSync(envFile)) {
      continue;
    }

    Object.assign(merged, parseDotenv(readFileSync(envFile, 'utf8')));
  }

  return {
    ...merged,
    ...runtimeEnv,
  };
}

function buildDefaultOrigin(env: NodeJS.ProcessEnv): string {
  const parsedPort = Number.parseInt(env.WEB_PORT ?? '', 10);
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_WEB_PORT;
  const bind = env.WEB_BIND?.trim() || '127.0.0.1';
  const host = bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind;
  return `http://${host}:${port}`;
}

function buildCliUsage(): string {
  return [
    '用法：',
    '  bridgectl autopilot status',
    '  bridgectl autopilot server on',
    '  bridgectl autopilot server concurrency 3',
    '  bridgectl autopilot project status --project <绑定项目名>',
    '  bridgectl autopilot project status --cwd /path/to/workspace',
    '  bridgectl session status <Resume ID>',
    '  bridgectl session send <Resume ID> "hello"',
    '  bridgectl session resume <Resume ID>',
    '',
    '说明：',
    '  `--channel <频道ID>` 和 `--project <绑定项目名>` 仍可用于 autopilot 命令定位目标。',
    '  `session ...` 会通过本地 bridge 继续同一个 Codex 会话，而不是绕过 bridge 直连 Codex。',
    '  `session resume` 支持 `/status` 和 `/exit`。',
    '  在支持 bracketed paste 的终端里，多行粘贴会先暂存，需再按一次 Enter 才会整段发送。',
  ].join('\n');
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
