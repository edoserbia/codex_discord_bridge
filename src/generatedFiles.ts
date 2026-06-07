import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { GeneratedFileRecord } from './types.js';

export async function writeGeneratedImageFile(options: {
  workspacePath: string;
  itemId: string;
  base64: string;
}): Promise<GeneratedFileRecord | undefined> {
  const base64 = options.base64.trim();
  if (!base64) {
    return undefined;
  }

  const outputDirName = 'codex-generated-images';
  const safeItemId = sanitizeFileStem(options.itemId) || 'image';
  const outputDir = path.join(options.workspacePath, outputDirName);
  const name = `${safeItemId}.png`;
  const absolutePath = path.join(outputDir, name);

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(absolutePath, Buffer.from(base64, 'base64'));

  return {
    absolutePath,
    workspaceRelativePath: path.join(outputDirName, name),
    name,
    kind: 'image',
  };
}

export async function recordGeneratedImageFile(options: {
  workspacePath: string;
  itemId: string;
  savedPath: string;
}): Promise<GeneratedFileRecord | undefined> {
  const absolutePath = options.savedPath.trim();
  if (!absolutePath) {
    return undefined;
  }

  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat?.isFile()) {
    return undefined;
  }

  const workspaceRelativePath = path.relative(options.workspacePath, absolutePath);
  const safeRelativePath = workspaceRelativePath && !workspaceRelativePath.startsWith(`..${path.sep}`) && workspaceRelativePath !== '..'
    ? workspaceRelativePath
    : path.join('codex-generated-images', `${sanitizeFileStem(options.itemId) || 'image'}${path.extname(absolutePath) || '.png'}`);

  return {
    absolutePath,
    workspaceRelativePath: safeRelativePath,
    name: path.basename(absolutePath),
    kind: 'image',
  };
}

export async function collectGeneratedImageFilesForThread(options: {
  workspacePath: string;
  threadId: string | undefined;
  sinceMs: number;
}): Promise<GeneratedFileRecord[]> {
  if (!options.threadId) {
    return [];
  }

  const generatedDir = path.join(os.homedir(), '.codex', 'generated_images', options.threadId);
  const entries = await fs.readdir(generatedDir, { withFileTypes: true }).catch(() => []);
  const files: GeneratedFileRecord[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !/\.(?:png|jpe?g|webp)$/i.test(entry.name)) {
      continue;
    }

    const absolutePath = path.join(generatedDir, entry.name);
    const stat = await fs.stat(absolutePath).catch(() => null);
    if (!stat?.isFile() || stat.mtimeMs < options.sinceMs) {
      continue;
    }

    files.push({
      absolutePath,
      workspaceRelativePath: path.join('codex-generated-images', entry.name),
      name: entry.name,
      kind: 'image',
    });
  }

  return files.sort((left, right) => left.name.localeCompare(right.name));
}

export function appendUniqueGeneratedFiles(
  target: GeneratedFileRecord[],
  files: GeneratedFileRecord[],
): void {
  for (const file of files) {
    if (!target.some((candidate) => candidate.absolutePath === file.absolutePath)) {
      target.push(file);
    }
  }
}

function sanitizeFileStem(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}
