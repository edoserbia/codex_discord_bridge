import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ReasoningEffort } from './types.js';

export const DEFAULT_CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');

const REASONING_EFFORTS: ReadonlySet<string> = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);

export function resolveCodexConfigPath(rawPath = process.env.CODEX_CONFIG_PATH): string {
  const candidate = rawPath?.trim();
  return path.resolve(candidate || DEFAULT_CODEX_CONFIG_PATH);
}

function decodeTomlString(rawValue: string, quote: '"' | "'"): string {
  if (quote === '"') {
    return JSON.parse(`"${rawValue}"`) as string;
  }

  return rawValue.replace(/\\'/g, "'");
}

function encodeTomlString(value: string): string {
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createRootStringPattern(key: string): RegExp {
  const escapedKey = escapeRegExp(key);
  return new RegExp(`^(\\s*${escapedKey}\\s*=\\s*)(?:"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)')(\\s*(?:#.*)?)$`);
}

function createRootAssignmentPattern(key: string): RegExp {
  return new RegExp(`^(\\s*${escapeRegExp(key)}\\s*=\\s*)(.*)$`);
}

function readRootStringFromToml(content: string, key: string): string | undefined {
  const pattern = createRootStringPattern(key);

  for (const line of content.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      break;
    }

    const match = line.match(pattern);
    if (!match) {
      continue;
    }

    if (match[2] !== undefined) {
      return decodeTomlString(match[2], '"');
    }

    if (match[3] !== undefined) {
      return decodeTomlString(match[3], "'");
    }
  }

  return undefined;
}

function findTrailingTomlComment(valueAndComment: string): string {
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (let index = 0; index < valueAndComment.length; index += 1) {
    const character = valueAndComment[index]!;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (quote) {
      if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === '#') {
      let commentStart = index;
      while (commentStart > 0 && /\s/.test(valueAndComment[commentStart - 1]!)) {
        commentStart -= 1;
      }
      return valueAndComment.slice(commentStart);
    }
  }

  return '';
}

function upsertRootStringInToml(content: string, key: string, value: string): string {
  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  const encoded = encodeTomlString(value);
  const stringPattern = createRootStringPattern(key);
  const assignmentPattern = createRootAssignmentPattern(key);
  const firstSectionIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEndIndex = firstSectionIndex >= 0 ? firstSectionIndex : lines.length;

  for (let index = 0; index < rootEndIndex; index += 1) {
    const line = lines[index]!;
    const stringMatch = line.match(stringPattern);
    if (stringMatch) {
      lines[index] = `${stringMatch[1]}${encoded}${stringMatch[4] ?? ''}`;
      return lines.join('\n');
    }

    const assignmentMatch = line.match(assignmentPattern);
    if (!assignmentMatch) {
      continue;
    }

    lines[index] = `${assignmentMatch[1]}${encoded}${findTrailingTomlComment(assignmentMatch[2] ?? '')}`;
    return lines.join('\n');
  }

  const insertLine = `${key} = ${encoded}`;

  if (lines.length === 0) {
    return insertLine;
  }

  if (rootEndIndex === 0) {
    return [insertLine, '', ...lines].join('\n');
  }

  lines.splice(rootEndIndex, 0, insertLine);
  return lines.join('\n');
}

function removeRootStringFromToml(content: string, key: string): string {
  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  const assignmentPattern = createRootAssignmentPattern(key);
  const firstSectionIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEndIndex = firstSectionIndex >= 0 ? firstSectionIndex : lines.length;

  for (let index = 0; index < rootEndIndex; index += 1) {
    if (assignmentPattern.test(lines[index]!)) {
      lines.splice(index, 1);
      return lines.join('\n');
    }
  }

  return content;
}

async function readCodexConfigIfPresent(configPath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(configPath, 'utf8');
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
}

async function writeCodexConfig(configPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });

  const normalized = content.endsWith('\n') ? content : `${content}\n`;
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;

  try {
    await fs.writeFile(tempPath, normalized, 'utf8');
    await fs.rename(tempPath, configPath);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

export function readRootModelFromToml(content: string): string | undefined {
  return readRootStringFromToml(content, 'model');
}

export function upsertRootModelInToml(content: string, model: string): string {
  return upsertRootStringInToml(content, 'model', model);
}

export function readRootReasoningEffortFromToml(content: string): ReasoningEffort | undefined {
  let value: string | undefined;
  try {
    value = readRootStringFromToml(content, 'model_reasoning_effort');
  } catch {
    return undefined;
  }

  return value && REASONING_EFFORTS.has(value) ? value as ReasoningEffort : undefined;
}

export function upsertRootReasoningEffortInToml(content: string, effort: ReasoningEffort): string {
  return upsertRootStringInToml(content, 'model_reasoning_effort', effort);
}

export function removeRootReasoningEffortFromToml(content: string): string {
  return removeRootStringFromToml(content, 'model_reasoning_effort');
}

export async function loadCodexGlobalModel(configPath: string): Promise<string | undefined> {
  const content = await readCodexConfigIfPresent(configPath);
  return content === undefined ? undefined : readRootModelFromToml(content);
}

export async function writeCodexGlobalModel(configPath: string, model: string): Promise<void> {
  const existing = await readCodexConfigIfPresent(configPath) ?? '';
  const next = upsertRootModelInToml(existing, model);
  await writeCodexConfig(configPath, next);
}

export async function loadCodexGlobalReasoningEffort(configPath: string): Promise<ReasoningEffort | undefined> {
  const content = await readCodexConfigIfPresent(configPath);
  return content === undefined ? undefined : readRootReasoningEffortFromToml(content);
}

export async function writeCodexGlobalReasoningEffort(configPath: string, effort: ReasoningEffort): Promise<void> {
  const existing = await readCodexConfigIfPresent(configPath) ?? '';
  await writeCodexConfig(configPath, upsertRootReasoningEffortInToml(existing, effort));
}

export async function clearCodexGlobalReasoningEffort(configPath: string): Promise<void> {
  const existing = await readCodexConfigIfPresent(configPath);
  if (existing === undefined) {
    return;
  }

  await writeCodexConfig(configPath, removeRootReasoningEffortFromToml(existing));
}
