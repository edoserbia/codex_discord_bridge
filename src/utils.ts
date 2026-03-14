import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { BindingCodexOptions } from './types.js';

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function tailLines(value: string, maxLines: number): string {
  const lines = value.trim().split(/\r?\n/).filter(Boolean);

  if (lines.length <= maxLines) {
    return lines.join('\n');
  }

  return lines.slice(-maxLines).join('\n');
}

export function formatClockTimestamp(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `[${hours}:${minutes}]`;
}

export function splitIntoDiscordChunks(value: string, maxLength = 1900): string[] {
  const normalized = value.replace(/\r\n/g, '\n');

  if (normalized.length <= maxLength) {
    return [normalized];
  }

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);

    if (splitAt < Math.floor(maxLength * 0.5)) {
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }

    if (splitAt < Math.floor(maxLength * 0.5)) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

export function tokenizeCommand(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escaped = false;

  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (quote === 'single') {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === 'double') {
      if (char === '"') {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'") {
      quote = 'single';
      continue;
    }

    if (char === '"') {
      quote = 'double';
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    throw new Error('引号未闭合，请检查命令格式。');
  }

  if (escaped) {
    current += '\\';
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

export function parseBooleanWord(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();

  if (['1', 'true', 'on', 'yes', 'y'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'off', 'no', 'n'].includes(normalized)) {
    return false;
  }

  return undefined;
}

export function cloneCodexOptions(value: BindingCodexOptions): BindingCodexOptions {
  return {
    ...value,
    addDirs: [...value.addDirs],
    extraConfig: [...value.extraConfig],
  };
}

export async function resolveExistingDirectory(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath);
  const stat = await fs.stat(resolved);

  if (!stat.isDirectory()) {
    throw new Error(`路径不是目录：${resolved}`);
  }

  return fs.realpath(resolved);
}

export async function normalizeAllowedRoots(roots: string[]): Promise<string[]> {
  const normalized: string[] = [];

  for (const root of roots) {
    const resolved = path.resolve(root);

    try {
      normalized.push(await fs.realpath(resolved));
    } catch {
      normalized.push(resolved);
    }
  }

  return uniqueStrings(normalized);
}

export function isWithinAllowedRoots(targetPath: string, allowedRoots: string[]): boolean {
  if (allowedRoots.length === 0) {
    return true;
  }

  return allowedRoots.some((root) => targetPath === root || targetPath.startsWith(`${root}${path.sep}`));
}

export function sanitizeInlineCode(value: string): string {
  return value.replace(/`/g, "'").replace(/\s+/g, ' ').trim();
}

export function shortId(value: string): string {
  return value.slice(0, 8);
}

export function summarizeReasoningText(value: string, maxLength = 180): string {
  const normalized = value
    .replace(/\r\n/g, '\n')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return '';
  }

  const firstSentence = normalized.split(/(?<=[。！？.!?])\s+/)[0] ?? normalized;
  return truncate(firstSentence.trim() || normalized, maxLength);
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export async function ensureDirectory(targetPath: string): Promise<string> {
  await fs.mkdir(targetPath, { recursive: true });
  return targetPath;
}

export function sanitizeFilename(value: string): string {
  const trimmed = value.trim() || 'attachment';
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

export function detectImageMime(filename: string, contentType?: string | null): boolean {
  if (contentType?.startsWith('image/')) {
    return true;
  }

  const lower = filename.toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].some((ext) => lower.endsWith(ext));
}
