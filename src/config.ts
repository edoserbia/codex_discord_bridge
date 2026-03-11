import 'dotenv/config';

import path from 'node:path';

import type { ApprovalPolicy, BindingCodexOptions, SandboxMode } from './types.js';

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
  codexCommand: string;
  allowedWorkspaceRoots: string[];
  adminUserIds: Set<string>;
  defaultCodex: BindingCodexOptions;
  web: WebConfig;
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

export function loadConfig(): AppConfig {
  const discordToken = process.env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_TOKEN;

  if (!discordToken) {
    throw new Error('缺少环境变量 DISCORD_BOT_TOKEN。');
  }

  return {
    discordToken,
    commandPrefix: process.env.COMMAND_PREFIX?.trim() || '!',
    dataDir: path.resolve(process.env.DATA_DIR ?? './data'),
    codexCommand: process.env.CODEX_COMMAND?.trim() || 'codex',
    allowedWorkspaceRoots: parseList(process.env.ALLOWED_WORKSPACE_ROOTS).map((item) => path.resolve(item)),
    adminUserIds: new Set(parseList(process.env.DISCORD_ADMIN_USER_IDS)),
    defaultCodex: {
      model: process.env.DEFAULT_CODEX_MODEL?.trim() || undefined,
      profile: process.env.DEFAULT_CODEX_PROFILE?.trim() || undefined,
      sandboxMode: parseSandboxMode(process.env.DEFAULT_CODEX_SANDBOX, 'workspace-write'),
      approvalPolicy: parseApprovalPolicy(process.env.DEFAULT_CODEX_APPROVAL, 'never'),
      search: parseBoolean(process.env.DEFAULT_CODEX_SEARCH, false),
      skipGitRepoCheck: parseBoolean(process.env.DEFAULT_CODEX_SKIP_GIT_REPO_CHECK, true),
      addDirs: parseList(process.env.DEFAULT_CODEX_ADD_DIRS).map((item) => path.resolve(item)),
      extraConfig: parseList(process.env.DEFAULT_CODEX_CONFIGS),
    },
    web: {
      enabled: parseBoolean(process.env.WEB_ENABLED, true),
      bind: process.env.WEB_BIND?.trim() || '127.0.0.1',
      port: parseInteger(process.env.WEB_PORT, 3769),
      authToken: process.env.WEB_AUTH_TOKEN?.trim() || undefined,
    },
  };
}
