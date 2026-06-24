import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

interface ClaudeSettingsFile {
  model?: string | undefined;
  permissions?: {
    allow?: unknown;
    deny?: unknown;
    [key: string]: unknown;
  } | undefined;
  [key: string]: unknown;
}

export interface ClaudeSettingsResolution {
  model?: string | undefined;
  source: 'project' | 'global' | 'none';
  projectSettingsPath: string;
  globalSettingsPath: string;
}

function resolveWorkspaceClaudeSettingsPath(workspacePath: string): string {
  return path.join(workspacePath, '.claude', 'settings.json');
}

export function resolveClaudeSettingsPath(rawPath?: string | undefined): string {
  const candidate = rawPath?.trim();
  return path.resolve(candidate || DEFAULT_CLAUDE_SETTINGS_PATH);
}

async function readJsonSettings(filePath: string): Promise<ClaudeSettingsFile> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as ClaudeSettingsFile;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return {};
    }

    throw error;
  }
}

function readJsonSettingsSync(filePath: string): ClaudeSettingsFile {
  try {
    const raw = fsSync.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as ClaudeSettingsFile;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return {};
    }

    throw error;
  }
}

async function writeJsonSettings(filePath: string, settings: ClaudeSettingsFile): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

export async function readEffectiveClaudeModel(
  workspacePath: string,
  globalSettingsPath: string,
): Promise<ClaudeSettingsResolution> {
  const projectSettingsPath = resolveWorkspaceClaudeSettingsPath(workspacePath);
  const projectSettings = await readJsonSettings(projectSettingsPath);
  if (typeof projectSettings.model === 'string' && projectSettings.model.trim()) {
    return {
      model: projectSettings.model.trim(),
      source: 'project',
      projectSettingsPath,
      globalSettingsPath,
    };
  }

  const globalSettings = await readJsonSettings(globalSettingsPath);
  if (typeof globalSettings.model === 'string' && globalSettings.model.trim()) {
    return {
      model: globalSettings.model.trim(),
      source: 'global',
      projectSettingsPath,
      globalSettingsPath,
    };
  }

  return {
    source: 'none',
    projectSettingsPath,
    globalSettingsPath,
  };
}

export async function readClaudeGlobalModel(globalSettingsPath: string): Promise<string | undefined> {
  const globalSettings = await readJsonSettings(globalSettingsPath);
  return typeof globalSettings.model === 'string' && globalSettings.model.trim()
    ? globalSettings.model.trim()
    : undefined;
}

export async function readClaudeProjectModel(workspacePath: string): Promise<string | undefined> {
  const projectSettings = await readJsonSettings(resolveWorkspaceClaudeSettingsPath(workspacePath));
  return typeof projectSettings.model === 'string' && projectSettings.model.trim()
    ? projectSettings.model.trim()
    : undefined;
}

export function readEffectiveClaudeModelSync(
  workspacePath: string,
  globalSettingsPath: string,
): ClaudeSettingsResolution {
  const projectSettingsPath = resolveWorkspaceClaudeSettingsPath(workspacePath);
  const projectSettings = readJsonSettingsSync(projectSettingsPath);
  if (typeof projectSettings.model === 'string' && projectSettings.model.trim()) {
    return {
      model: projectSettings.model.trim(),
      source: 'project',
      projectSettingsPath,
      globalSettingsPath,
    };
  }

  const globalSettings = readJsonSettingsSync(globalSettingsPath);
  if (typeof globalSettings.model === 'string' && globalSettings.model.trim()) {
    return {
      model: globalSettings.model.trim(),
      source: 'global',
      projectSettingsPath,
      globalSettingsPath,
    };
  }

  return {
    source: 'none',
    projectSettingsPath,
    globalSettingsPath,
  };
}

export async function writeClaudeProjectModel(workspacePath: string, model: string): Promise<void> {
  const projectSettingsPath = resolveWorkspaceClaudeSettingsPath(workspacePath);
  const existing = await readJsonSettings(projectSettingsPath);
  await writeJsonSettings(projectSettingsPath, {
    ...existing,
    model,
  });
}

export async function writeClaudeGlobalModel(globalSettingsPath: string, model: string): Promise<void> {
  const existing = await readJsonSettings(globalSettingsPath);
  await writeJsonSettings(globalSettingsPath, {
    ...existing,
    model,
  });
}

export async function clearClaudeProjectModel(workspacePath: string): Promise<void> {
  const projectSettingsPath = resolveWorkspaceClaudeSettingsPath(workspacePath);
  const existing = await readJsonSettings(projectSettingsPath);
  delete existing.model;
  await writeJsonSettings(projectSettingsPath, existing);
}

export async function allowClaudeProjectTool(workspacePath: string, toolPattern: string): Promise<void> {
  const normalizedPattern = toolPattern.trim();
  if (!normalizedPattern) {
    throw new Error('Claude 权限规则不能为空。');
  }

  const projectSettingsPath = resolveWorkspaceClaudeSettingsPath(workspacePath);
  const existing = await readJsonSettings(projectSettingsPath);
  const permissions = existing.permissions && typeof existing.permissions === 'object'
    ? existing.permissions
    : {};
  const currentAllow = Array.isArray(permissions.allow)
    ? permissions.allow.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const currentDeny = Array.isArray(permissions.deny)
    ? permissions.deny.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const nextAllow = currentAllow.includes(normalizedPattern)
    ? currentAllow
    : [...currentAllow, normalizedPattern];

  await writeJsonSettings(projectSettingsPath, {
    ...existing,
    permissions: {
      ...permissions,
      allow: nextAllow,
      deny: currentDeny.filter((value) => value !== normalizedPattern),
    },
  });
}
