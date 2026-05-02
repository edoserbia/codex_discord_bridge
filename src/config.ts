import 'dotenv/config';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { config as dotenvConfig } from 'dotenv';

import type { AppServerTransport, ApprovalPolicy, BindingCodexOptions, CodexDriverMode, SandboxMode } from './types.js';
import { ensureCodexFeatureFlags, resolveCodexConfigPath } from './codexConfig.js';

const DEFAULT_SECRETS_FILE = path.join(os.homedir(), '.codex-tunning', 'secrets.env');

export interface WebConfig {
  enabled: boolean;
  bind: string;
  port: number;
  authToken?: string | undefined;
}

export interface AppConfig {
  discordToken: string;
  commandPrefix: string;
  dataDir: string;
  codexConfigPath?: string | undefined;
  codexCommand: string;
  codexMaxAttempts: number;
  codexRateLimitMaxAttempts: number;
  codexRateLimitBaseDelayMs: number;
  codexRateLimitMaxDelayMs: number;
  codexDriverMode?: CodexDriverMode | undefined;
  codexAppServerTransport?: AppServerTransport | undefined;
  codexAppServerStartupTimeoutMs?: number | undefined;
  codexAppServerRequestTimeoutMs?: number | undefined;
  allowedWorkspaceRoots: string[];
  adminUserIds: Set<string>;
  defaultCodex: BindingCodexOptions;
  web: WebConfig;
}

export const REQUIRED_CODEX_FEATURE_FLAGS = ['multi_agent', 'goals'] as const;

function loadExternalSecretEnv(): void {
  const secretFile = process.env.CODEX_TUNNING_SECRETS_FILE?.trim() || DEFAULT_SECRETS_FILE;

  if (!fs.existsSync(secretFile)) {
    return;
  }

  dotenvConfig({ path: secretFile, override: false });
}

function parseList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();

  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseMinimumInteger(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = parseInteger(value, fallback);
  return parsed >= minimum ? parsed : fallback;
}

function parseSandboxMode(value: string | undefined, fallback: SandboxMode): SandboxMode {
  if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') {
    return value;
  }

  return fallback;
}

function parseApprovalPolicy(value: string | undefined, fallback: ApprovalPolicy): ApprovalPolicy {
  if (value === 'untrusted' || value === 'on-failure' || value === 'on-request' || value === 'never') {
    return value;
  }

  return fallback;
}

function parseCodexDriverMode(value: string | undefined, fallback: CodexDriverMode): CodexDriverMode {
  if (value === 'legacy-exec' || value === 'app-server') {
    return value;
  }

  return fallback;
}

function parseAppServerTransport(value: string | undefined, fallback: AppServerTransport): AppServerTransport {
  if (value === 'auto' || value === 'stdio' || value === 'ws') {
    return value;
  }

  return fallback;
}

export function loadConfig(): AppConfig {
  loadExternalSecretEnv();

  const discordToken = process.env.CODEX_TUNNING_DISCORD_BOT_TOKEN?.trim()
    || process.env.DISCORD_BOT_TOKEN?.trim()
    || process.env.DISCORD_TOKEN?.trim();

  if (!discordToken) {
    throw new Error('缺少环境变量 CODEX_TUNNING_DISCORD_BOT_TOKEN。');
  }

  return {
    discordToken,
    commandPrefix: process.env.COMMAND_PREFIX?.trim() || '!',
    dataDir: path.resolve(process.env.DATA_DIR ?? './data'),
    codexConfigPath: resolveCodexConfigPath(),
    codexCommand: process.env.CODEX_COMMAND?.trim() || 'codex',
    codexMaxAttempts: parseMinimumInteger(process.env.CODEX_MAX_ATTEMPTS, 10, 1),
    codexRateLimitMaxAttempts: parseMinimumInteger(process.env.CODEX_RATE_LIMIT_MAX_ATTEMPTS, 0, 0),
    codexRateLimitBaseDelayMs: parseMinimumInteger(process.env.CODEX_RATE_LIMIT_BASE_DELAY_MS, 5_000, 0),
    codexRateLimitMaxDelayMs: parseMinimumInteger(process.env.CODEX_RATE_LIMIT_MAX_DELAY_MS, 60_000, 0),
    codexDriverMode: parseCodexDriverMode(process.env.CODEX_DRIVER_MODE?.trim(), 'app-server'),
    codexAppServerTransport: parseAppServerTransport(process.env.CODEX_APP_SERVER_TRANSPORT?.trim(), 'auto'),
    codexAppServerStartupTimeoutMs: parseInteger(process.env.CODEX_APP_SERVER_STARTUP_TIMEOUT_MS, 10_000),
    codexAppServerRequestTimeoutMs: parseInteger(process.env.CODEX_APP_SERVER_REQUEST_TIMEOUT_MS, 10_000),
    allowedWorkspaceRoots: parseList(process.env.ALLOWED_WORKSPACE_ROOTS).map((item) => path.resolve(item)),
    adminUserIds: new Set(parseList(process.env.DISCORD_ADMIN_USER_IDS)),
    defaultCodex: {
      model: process.env.DEFAULT_CODEX_MODEL?.trim() || undefined,
      profile: process.env.DEFAULT_CODEX_PROFILE?.trim() || undefined,
      sandboxMode: parseSandboxMode(process.env.DEFAULT_CODEX_SANDBOX, 'danger-full-access'),
      approvalPolicy: parseApprovalPolicy(process.env.DEFAULT_CODEX_APPROVAL, 'never'),
      search: parseBoolean(process.env.DEFAULT_CODEX_SEARCH, true),
      skipGitRepoCheck: parseBoolean(process.env.DEFAULT_CODEX_SKIP_GIT_REPO_CHECK, true),
      addDirs: parseList(process.env.DEFAULT_CODEX_ADD_DIRS).map((item) => path.resolve(item)),
      extraConfig: parseList(process.env.DEFAULT_CODEX_CONFIGS),
    },
    web: {
      enabled: parseBoolean(process.env.WEB_ENABLED, true),
      bind: process.env.WEB_BIND?.trim() || '0.0.0.0',
      port: parseInteger(process.env.WEB_PORT, 3769),
      authToken: process.env.WEB_AUTH_TOKEN?.trim() || undefined,
    },
  };
}

export async function ensureRequiredCodexFeatures(config: AppConfig): Promise<void> {
  await ensureCodexFeatureFlags(resolveCodexConfigPath(config.codexConfigPath), [...REQUIRED_CODEX_FEATURE_FLAGS]);
}
