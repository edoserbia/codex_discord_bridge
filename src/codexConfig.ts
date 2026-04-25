import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');

const ROOT_MODEL_PATTERN = /^(\s*model\s*=\s*)(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')(\s*(?:#.*)?)$/;

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

export function readRootModelFromToml(content: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      break;
    }

    const match = line.match(ROOT_MODEL_PATTERN);
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

export function upsertRootModelInToml(content: string, model: string): string {
  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  const encoded = encodeTomlString(model);
  const firstSectionIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEndIndex = firstSectionIndex >= 0 ? firstSectionIndex : lines.length;

  for (let index = 0; index < rootEndIndex; index += 1) {
    const match = lines[index]!.match(ROOT_MODEL_PATTERN);
    if (!match) {
      continue;
    }

    lines[index] = `${match[1]}${encoded}${match[4] ?? ''}`;
    return lines.join('\n');
  }

  const insertLine = `model = ${encoded}`;

  if (lines.length === 0) {
    return insertLine;
  }

  if (rootEndIndex === 0) {
    return [insertLine, '', ...lines].join('\n');
  }

  lines.splice(rootEndIndex, 0, insertLine);
  return lines.join('\n');
}

export async function loadCodexGlobalModel(configPath: string): Promise<string | undefined> {
  try {
    return readRootModelFromToml(await fs.readFile(configPath, 'utf8'));
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
}

export async function writeCodexGlobalModel(configPath: string, model: string): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });

  let existing = '';
  try {
    existing = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      throw error;
    }
  }

  const next = upsertRootModelInToml(existing, model);
  await fs.writeFile(configPath, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
}
