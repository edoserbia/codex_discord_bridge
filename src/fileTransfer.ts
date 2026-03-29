import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_CANDIDATES = 5;
const WORKSPACE_SKIP_DIRS = new Set(['.git']);
const FILE_QUERY_STOP_WORDS = new Set([
  '把',
  '将',
  '请',
  '最新',
  '最新的',
  '最近',
  '最近的',
  '这个',
  '那个',
  '这里',
  '一下',
  '给我',
  '发给我',
  '发送给我',
  '发到这里',
  '发到这个线程',
  'send',
  'to',
  'me',
  'here',
  'thread',
]);

export interface FileTransferCandidate {
  absolutePath: string;
  workspaceRelativePath?: string | undefined;
  name: string;
  size: number;
  modifiedAtMs: number;
  inWorkspace: boolean;
  inInbox: boolean;
}

export type FileRequestResolution =
  | { kind: 'single'; file: FileTransferCandidate }
  | { kind: 'candidates'; candidates: FileTransferCandidate[] }
  | { kind: 'denied'; message: string }
  | { kind: 'missing'; message: string };

export function getWorkspaceInboxDir(workspacePath: string): string {
  return path.join(workspacePath, 'inbox');
}

export async function allocateInboxFilePath(workspacePath: string, fileName: string): Promise<string> {
  const inboxDir = getWorkspaceInboxDir(workspacePath);
  await fs.mkdir(inboxDir, { recursive: true });
  return allocateUniqueFilePath(inboxDir, fileName);
}

export function formatFileCandidates(
  candidates: FileTransferCandidate[],
  options: { commandPrefix?: string } = {},
): string {
  const commandPrefix = options.commandPrefix ?? '!';
  const lines = ['找到多个匹配文件，请回复“发第 2 个”或 `!sendfile 2`：'.replace('!sendfile', `${commandPrefix}sendfile`)];

  for (const [index, candidate] of candidates.entries()) {
    const location = candidate.workspaceRelativePath ?? candidate.absolutePath;
    lines.push(
      `${index + 1}. ${candidate.name} · ${location} · ${formatBytes(candidate.size)} · ${formatCandidateTime(candidate.modifiedAtMs)}`,
    );
  }

  return lines.join('\n');
}

export async function resolveFileRequest(options: {
  workspacePath: string;
  request: string;
  allowAbsolutePath: boolean;
  maxCandidates?: number;
}): Promise<FileRequestResolution> {
  const rawRequest = stripWrappedQuotes(options.request.trim());
  if (!rawRequest) {
    return { kind: 'missing', message: '请告诉我要发送哪个文件，例如 `把 report.pdf 发给我`。' };
  }

  if (path.isAbsolute(rawRequest)) {
    if (!options.allowAbsolutePath) {
      return { kind: 'denied', message: '只有管理员才能通过绝对路径发送文件。' };
    }

    return resolveAbsolutePath(rawRequest, options.workspacePath);
  }

  const candidates = await searchWorkspaceFiles(options.workspacePath, rawRequest);
  if (candidates.length === 0) {
    return { kind: 'missing', message: `在当前绑定目录里没有找到匹配文件：${rawRequest}` };
  }

  if (candidates.length === 1) {
    return { kind: 'single', file: candidates[0]! };
  }

  return {
    kind: 'candidates',
    candidates: candidates.slice(0, options.maxCandidates ?? MAX_CANDIDATES),
  };
}

export function detectNaturalLanguageFileRequest(content: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed) {
    return undefined;
  }

  const chineseMatch = trimmed.match(/^(?:请\s*)?(?:把|将)\s+(.+?)\s*(?:发(?:给我|我|到这里|到这个线程)?|发送(?:给我|到这里|到这个线程)?|上传(?:给我|到这里|到这个线程)?)\s*$/i);
  const englishMatch = trimmed.match(/^(?:please\s+)?send\s+(.+?)\s+(?:to me|here|in this thread)\s*$/i);
  const query = chineseMatch?.[1] ?? englishMatch?.[1];

  if (!query) {
    return undefined;
  }

  const normalized = stripWrappedQuotes(query.trim());
  if (!normalized || !looksLikeFileQuery(normalized)) {
    return undefined;
  }

  return normalized;
}

export function parseFileSelectionFollowUp(content: string): number | undefined {
  const trimmed = content.trim();
  const match = trimmed.match(/^(?:请\s*)?(?:发\s*第?\s*(\d+)\s*个|send\s+(?:number\s+)?(\d+))\s*$/i);
  const value = match?.[1] ?? match?.[2];

  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function resolveAbsolutePath(targetPath: string, workspacePath: string): Promise<FileRequestResolution> {
  try {
    const stat = await fs.stat(targetPath);
    if (!stat.isFile()) {
      return { kind: 'missing', message: `目标不是可发送的普通文件：${targetPath}` };
    }

    return {
      kind: 'single',
      file: buildCandidateFromPath(workspacePath, targetPath, stat),
    };
  } catch {
    return { kind: 'missing', message: `找不到要发送的文件：${targetPath}` };
  }
}

async function searchWorkspaceFiles(workspacePath: string, request: string): Promise<FileTransferCandidate[]> {
  const files: FileTransferCandidate[] = [];
  await walkWorkspaceFiles(workspacePath, workspacePath, files);

  const normalizedRequest = request.toLowerCase();
  const requestBasename = path.basename(normalizedRequest);
  const requestTokens = tokenizeFileQuery(normalizedRequest);

  return files
    .filter((candidate) => {
      const relative = (candidate.workspaceRelativePath ?? candidate.absolutePath).toLowerCase();
      const name = candidate.name.toLowerCase();

      return isExactRelativeMatch(relative, normalizedRequest)
        || name === requestBasename
        || relative.endsWith(`/${normalizedRequest}`)
        || name.includes(normalizedRequest)
        || relative.includes(normalizedRequest)
        || (requestTokens.length > 0 && requestTokens.every((token) => relative.includes(token) || name.includes(token)));
    })
    .sort((left, right) => compareCandidates(left, right, normalizedRequest, requestBasename));
}

async function walkWorkspaceFiles(
  workspacePath: string,
  currentDir: string,
  files: FileTransferCandidate[],
): Promise<void> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (WORKSPACE_SKIP_DIRS.has(entry.name)) {
        continue;
      }

      await walkWorkspaceFiles(workspacePath, absolutePath, files);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const stat = await fs.stat(absolutePath);
    files.push(buildCandidateFromPath(workspacePath, absolutePath, stat));
  }
}

function buildCandidateFromPath(
  workspacePath: string,
  absolutePath: string,
  stat: { size: number; mtimeMs: number },
): FileTransferCandidate {
  const relativePath = path.relative(workspacePath, absolutePath);
  const inWorkspace = relativePath !== '' && !relativePath.startsWith(`..${path.sep}`) && relativePath !== '..';

  return {
    absolutePath,
    workspaceRelativePath: inWorkspace ? relativePath : undefined,
    name: path.basename(absolutePath),
    size: stat.size,
    modifiedAtMs: stat.mtimeMs,
    inWorkspace,
    inInbox: inWorkspace && (relativePath === 'inbox' || relativePath.startsWith(`inbox${path.sep}`)),
  };
}

function compareCandidates(
  left: FileTransferCandidate,
  right: FileTransferCandidate,
  normalizedRequest: string,
  requestBasename: string,
): number {
  const leftScore = buildCandidateScore(left, normalizedRequest, requestBasename);
  const rightScore = buildCandidateScore(right, normalizedRequest, requestBasename);

  for (let index = 0; index < leftScore.length; index += 1) {
    const diff = rightScore[index]! - leftScore[index]!;
    if (diff !== 0) {
      return diff;
    }
  }

  const leftRelative = left.workspaceRelativePath ?? left.absolutePath;
  const rightRelative = right.workspaceRelativePath ?? right.absolutePath;
  return leftRelative.localeCompare(rightRelative);
}

function buildCandidateScore(
  candidate: FileTransferCandidate,
  normalizedRequest: string,
  requestBasename: string,
): number[] {
  const relative = (candidate.workspaceRelativePath ?? candidate.absolutePath).toLowerCase();
  const name = candidate.name.toLowerCase();
  const exactRelative = isExactRelativeMatch(relative, normalizedRequest) ? 1 : 0;
  const exactName = name === requestBasename ? 1 : 0;
  const suffixMatch = relative.endsWith(`/${normalizedRequest}`) ? 1 : 0;
  const substringMatch = relative.includes(normalizedRequest) || name.includes(normalizedRequest) ? 1 : 0;

  return [
    candidate.inInbox ? 1 : 0,
    exactRelative,
    exactName,
    suffixMatch,
    substringMatch,
    Math.round(candidate.modifiedAtMs),
  ];
}

function isExactRelativeMatch(relativePath: string, normalizedRequest: string): boolean {
  return relativePath === normalizedRequest
    || relativePath === normalizedRequest.replaceAll('\\', '/')
    || relativePath.replaceAll('\\', '/') === normalizedRequest.replaceAll('\\', '/');
}

function tokenizeFileQuery(value: string): string[] {
  return value
    .replace(/[“”"'`]/g, ' ')
    .split(/[\s/\\.,:;()[\]{}<>_-]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 2 && !FILE_QUERY_STOP_WORDS.has(token));
}

function looksLikeFileQuery(value: string): boolean {
  return path.isAbsolute(value)
    || /[\\/]/.test(value)
    || /\.[a-z0-9]{1,8}$/i.test(value)
    || /(文件|截图|图片|相片|image|img|pdf|png|jpe?g|webp|gif|txt|csv|json|md|docx?|xlsx?|pptx?|zip|tar|gz|log|patch|diff|yaml|yml)$/i.test(value);
}

function stripWrappedQuotes(value: string): string {
  const trimmed = value.trim();

  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed.at(-1);
    if ((first === '"' && last === '"') || (first === '\'' && last === '\'') || (first === '`' && last === '`')) {
      return trimmed.slice(1, -1).trim();
    }
  }

  return trimmed;
}

export async function allocateUniqueFilePath(directory: string, fileName: string): Promise<string> {
  const extension = path.extname(fileName);
  const baseName = extension ? fileName.slice(0, -extension.length) : fileName;
  const originalPath = path.join(directory, fileName);

  try {
    await fs.access(originalPath);
  } catch {
    return originalPath;
  }

  for (let index = 0; index < 256; index += 1) {
    const suffix = randomBytes(4).toString('hex');
    const candidateName = `${baseName}-${suffix}${extension}`;
    const candidatePath = path.join(directory, candidateName);

    try {
      await fs.access(candidatePath);
    } catch {
      return candidatePath;
    }
  }

  throw new Error(`无法为文件分配可用路径：${fileName}`);
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCandidateTime(value: number): string {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hour = `${date.getHours()}`.padStart(2, '0');
  const minute = `${date.getMinutes()}`.padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}
