import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');

const ROOT_MODEL_PATTERN = /^(\s*model\s*=\s*)(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')(\s*(?:#.*)?)$/;
const SECTION_PATTERN = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;
const BOOLEAN_VALUE_PATTERN = /^(true|false)\s*(?:#.*)?$/i;

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

export function readCodexFeatureFlag(content: string, featureName: string): boolean | undefined {
  let inFeaturesSection = false;

  for (const line of content.split(/\r?\n/)) {
    const sectionMatch = line.match(SECTION_PATTERN);
    if (sectionMatch) {
      inFeaturesSection = sectionMatch[1]?.trim() === 'features';
      continue;
    }

    if (!inFeaturesSection) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex < 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (key !== featureName) {
      continue;
    }

    const value = line.slice(separatorIndex + 1).trim();
    const valueMatch = value.match(BOOLEAN_VALUE_PATTERN);
    return valueMatch ? valueMatch[1]!.toLowerCase() === 'true' : undefined;
  }

  return undefined;
}

export function upsertCodexFeatureFlagsInToml(content: string, featureNames: string[]): string {
  const uniqueFeatures = [...new Set(featureNames.map((value) => value.trim()).filter(Boolean))];
  if (uniqueFeatures.length === 0) {
    return content;
  }

  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  let featuresStart = -1;
  let featuresEnd = lines.length;

  for (let index = 0; index < lines.length; index += 1) {
    const sectionMatch = lines[index]!.match(SECTION_PATTERN);
    if (!sectionMatch) {
      continue;
    }

    if (sectionMatch[1]?.trim() === 'features') {
      featuresStart = index;
      featuresEnd = lines.length;
      for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
        if (SECTION_PATTERN.test(lines[nextIndex]!)) {
          featuresEnd = nextIndex;
          break;
        }
      }
      break;
    }
  }

  if (featuresStart < 0) {
    const nextLines = [...lines];
    if (nextLines.length > 0 && nextLines.at(-1) !== '') {
      nextLines.push('');
    }
    nextLines.push('[features]');
    for (const featureName of uniqueFeatures) {
      nextLines.push(`${featureName} = true`);
    }
    return nextLines.join('\n');
  }

  const remaining = new Set(uniqueFeatures);
  for (let index = featuresStart + 1; index < featuresEnd; index += 1) {
    const separatorIndex = lines[index]!.indexOf('=');
    if (separatorIndex < 0) {
      continue;
    }

    const key = lines[index]!.slice(0, separatorIndex).trim();
    if (!remaining.has(key)) {
      continue;
    }

    const commentMatch = lines[index]!.slice(separatorIndex + 1).match(/(\s+#.*)$/);
    lines[index] = `${lines[index]!.slice(0, separatorIndex + 1)} true${commentMatch?.[1] ?? ''}`;
    remaining.delete(key);
  }

  if (remaining.size > 0) {
    lines.splice(featuresEnd, 0, ...[...remaining].map((featureName) => `${featureName} = true`));
  }

  return lines.join('\n');
}

export async function ensureCodexFeatureFlags(configPath: string, featureNames: string[]): Promise<void> {
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

  const next = upsertCodexFeatureFlagsInToml(existing, featureNames);
  if (next === existing) {
    return;
  }

  await fs.writeFile(configPath, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
}
