import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseDotenv } from 'dotenv';

interface WritableLike {
  write: (chunk: string) => void;
}

interface CliRunOptions {
  cwd?: string;
  stdout?: WritableLike;
  stderr?: WritableLike;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

interface CliParsedArgs {
  help: boolean;
  commandText: string;
  channelId?: string | undefined;
  projectName?: string | undefined;
  cwd: string;
  json: boolean;
  originOverride?: string | undefined;
  authTokenOverride?: string | undefined;
}

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
    const response = await fetchImpl(`${origin}/api/autopilot/command`, {
      method: 'POST',
      headers: {
        ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        commandText: parsed.commandText,
        channelId: parsed.channelId,
        projectName: parsed.projectName,
        cwd: parsed.cwd,
      }),
    });

    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.includes('application/json')
      ? await response.json() as { ok?: boolean; message?: string }
      : { ok: response.ok, message: await response.text() };

    if (!response.ok || payload.ok === false) {
      stderr.write(`${payload.message?.trim() || `请求失败（HTTP ${response.status}）`}\n`);
      return 1;
    }

    if (parsed.json) {
      stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      stdout.write(`${payload.message?.trim() || 'Autopilot 命令已执行。'}\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`bridge 服务不可用：${message}\n`);
    return 1;
  }
}

function parseCliArgs(args: string[], cwd: string): CliParsedArgs {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    throw new Error('show_help');
  }

  const commandTokens: string[] = [];
  let channelId: string | undefined;
  let projectName: string | undefined;
  let resolvedCwd = cwd;
  let json = false;
  let originOverride: string | undefined;
  let authTokenOverride: string | undefined;
  let parseOptions = true;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;

    if (parseOptions && token === '--') {
      parseOptions = false;
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

    if (parseOptions && token === '--cwd') {
      resolvedCwd = readOptionValue(args, ++index, '--cwd');
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

  if (
    commandTokens[0] === 'autopilot'
    && (
      commandTokens.length === 1
      || (commandTokens.length === 2 && (commandTokens[1] === 'help' || commandTokens[1] === 'usage'))
    )
  ) {
    return {
      help: true,
      commandText: '!autopilot',
      channelId,
      projectName,
      cwd: path.resolve(resolvedCwd),
      json,
      originOverride,
      authTokenOverride,
    };
  }

  if (commandTokens[0] !== 'autopilot') {
    throw new Error('当前 CLI 仅支持 `autopilot` 命令。');
  }

  return {
    help: false,
    commandText: `!${commandTokens.join(' ')}`.trim(),
    channelId,
    projectName,
    cwd: path.resolve(resolvedCwd),
    json,
    originOverride,
    authTokenOverride,
  };
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
    '  bridgectl autopilot project status --project api',
    '  bridgectl autopilot project interval 30m --project api',
    '  bridgectl autopilot project prompt "优先补测试和稳定性，不要做大功能" --project api',
    '',
    '定位规则：',
    '  --channel <频道ID> 优先',
    '  --project <绑定项目名> 次之',
    '  否则按当前工作目录匹配已绑定项目',
  ].join('\n');
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
