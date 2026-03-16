#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const BOARD_RELATIVE_PATH = path.join('.codex', 'autopilot', 'board.json');
const BOARD_MARKDOWN_RELATIVE_PATH = path.join('docs', 'AUTOPILOT_BOARD.md');
const BOARD_STATUSES = ['ready', 'doing', 'blocked', 'done', 'deferred'];

function usage() {
  return [
    '用法：',
    '  boardctl.mjs ensure [--json]',
    '  boardctl.mjs status [--json]',
    '  boardctl.mjs export [--json]',
    '  boardctl.mjs list [status] [--json]',
    '  boardctl.mjs add <status> <title> [--notes <text>] [--json]',
    '  boardctl.mjs move <id-or-title> <status> [--notes <text>] [--json]',
    '  boardctl.mjs update <id-or-title> [--title <text>] [--notes <text>] [--json]',
    '  boardctl.mjs remove <id-or-title> [--json]',
    '  boardctl.mjs clear [--json]',
    '  boardctl.mjs import <input-json-path> [--replace] [--json]',
    '  boardctl.mjs render-md [--stdout]',
  ].join('\n');
}

function errorExit(message) {
  console.error(message);
  process.exit(1);
}

function parseFlags(argv) {
  const positional = [];
  const flags = {
    json: false,
    stdout: false,
    replace: false,
    notes: undefined,
    title: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--json':
        flags.json = true;
        break;
      case '--stdout':
        flags.stdout = true;
        break;
      case '--replace':
        flags.replace = true;
        break;
      case '--notes':
        flags.notes = argv[index + 1] ?? '';
        index += 1;
        break;
      case '--title':
        flags.title = argv[index + 1] ?? '';
        index += 1;
        break;
      default:
        positional.push(arg);
        break;
    }
  }

  return { positional, flags };
}

function normalizeStatus(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!BOARD_STATUSES.includes(normalized)) {
    errorExit(`无效状态：${value ?? ''}。可选值：${BOARD_STATUSES.join(', ')}`);
  }
  return normalized;
}

function makeEmptyBoard(now = new Date().toISOString()) {
  return {
    version: 1,
    updatedAt: now,
    items: [],
  };
}

function normalizeItem(candidate, fallbackTime) {
  if (!candidate || typeof candidate !== 'object') {
    return undefined;
  }

  const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
  const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
  const status = typeof candidate.status === 'string' ? candidate.status.trim().toLowerCase() : '';
  const updatedAt = typeof candidate.updatedAt === 'string' && candidate.updatedAt.trim()
    ? candidate.updatedAt.trim()
    : fallbackTime;
  const createdAt = typeof candidate.createdAt === 'string' && candidate.createdAt.trim()
    ? candidate.createdAt.trim()
    : updatedAt;
  const notes = typeof candidate.notes === 'string' && candidate.notes.trim()
    ? candidate.notes.trim()
    : undefined;

  if (!id || !title || !BOARD_STATUSES.includes(status)) {
    return undefined;
  }

  return {
    id,
    title,
    status,
    updatedAt,
    createdAt,
    notes,
  };
}

function normalizeBoardDocument(raw) {
  const now = new Date().toISOString();
  const document = raw && typeof raw === 'object' ? raw : {};
  const items = Array.isArray(document.items) ? document.items : Array.isArray(document) ? document : [];
  const normalizedItems = [];
  const seenIds = new Set();
  const seenTitles = new Set();

  for (const item of items) {
    const normalized = normalizeItem(item, now);
    if (!normalized || seenIds.has(normalized.id) || seenTitles.has(normalized.title)) {
      continue;
    }
    normalizedItems.push(normalized);
    seenIds.add(normalized.id);
    seenTitles.add(normalized.title);
  }

  return {
    version: 1,
    updatedAt: typeof document.updatedAt === 'string' && document.updatedAt.trim()
      ? document.updatedAt.trim()
      : now,
    items: normalizedItems,
  };
}

async function readBoardFile(boardPath) {
  try {
    const raw = await readFile(boardPath, 'utf8');
    return normalizeBoardDocument(JSON.parse(raw));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function formatBoardSummary(document) {
  const counts = Object.fromEntries(BOARD_STATUSES.map((status) => [status, 0]));
  for (const item of document.items) {
    counts[item.status] += 1;
  }

  return `Ready ${counts.ready} · Doing ${counts.doing} · Blocked ${counts.blocked} · Done ${counts.done} · Deferred ${counts.deferred}`;
}

function formatBoardMarkdown(document) {
  const lines = [
    '# Autopilot Board',
    '',
    `Last Updated: ${document.updatedAt}`,
    '',
  ];

  for (const status of BOARD_STATUSES) {
    lines.push(`## ${status}`);
    lines.push('');
    const items = document.items.filter((item) => item.status === status);
    if (items.length === 0) {
      lines.push('- 无');
      lines.push('');
      continue;
    }

    for (const item of items) {
      const notes = item.notes ? ` | ${item.notes}` : '';
      lines.push(`- ${item.title}${notes}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trim()}\n`;
}

async function writeBoardArtifacts(boardPath, markdownPath, document) {
  const normalized = normalizeBoardDocument(document);
  await mkdir(path.dirname(boardPath), { recursive: true });
  await mkdir(path.dirname(markdownPath), { recursive: true });
  await writeFile(boardPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, formatBoardMarkdown(normalized), 'utf8');
  return normalized;
}

function printValue(value, json = false) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }

  if (typeof value === 'string') {
    process.stdout.write(`${value}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function findItem(document, selector) {
  const normalizedSelector = String(selector ?? '').trim();
  if (!normalizedSelector) {
    errorExit('缺少任务选择器：请提供条目的 ID 或精确标题。');
  }

  const byId = document.items.find((item) => item.id === normalizedSelector);
  if (byId) {
    return byId;
  }

  const byTitle = document.items.filter((item) => item.title === normalizedSelector);
  if (byTitle.length === 1) {
    return byTitle[0];
  }

  if (byTitle.length > 1) {
    errorExit(`标题不唯一：${normalizedSelector}。请改用 ID。`);
  }

  errorExit(`未找到任务：${normalizedSelector}`);
}

function assertUniqueTitle(document, title, skipItemId) {
  const duplicate = document.items.find((item) => item.title === title && item.id !== skipItemId);
  if (duplicate) {
    errorExit(`任务标题已存在：${title}。请先移动或更新现有条目。`);
  }
}

async function ensureBoard(boardPath, markdownPath) {
  const existing = await readBoardFile(boardPath);
  if (existing) {
    return writeBoardArtifacts(boardPath, markdownPath, existing);
  }
  return writeBoardArtifacts(boardPath, markdownPath, makeEmptyBoard());
}

async function main() {
  const boardPath = path.join(process.cwd(), BOARD_RELATIVE_PATH);
  const markdownPath = path.join(process.cwd(), BOARD_MARKDOWN_RELATIVE_PATH);
  const { positional, flags } = parseFlags(process.argv.slice(2));
  const [command, ...rest] = positional;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printValue(usage());
    return;
  }

  switch (command) {
    case 'ensure': {
      const document = await ensureBoard(boardPath, markdownPath);
      printValue(document, flags.json);
      return;
    }
    case 'status': {
      const document = await ensureBoard(boardPath, markdownPath);
      if (flags.json) {
        printValue({
          boardPath,
          markdownPath,
          updatedAt: document.updatedAt,
          summary: formatBoardSummary(document),
          counts: Object.fromEntries(BOARD_STATUSES.map((status) => [status, document.items.filter((item) => item.status === status).length])),
        }, true);
        return;
      }
      printValue(`${formatBoardSummary(document)}\nJSON: ${boardPath}\nMarkdown: ${markdownPath}`);
      return;
    }
    case 'export': {
      const document = await ensureBoard(boardPath, markdownPath);
      printValue(document, true);
      return;
    }
    case 'list': {
      const document = await ensureBoard(boardPath, markdownPath);
      const requestedStatus = rest[0] ? normalizeStatus(rest[0]) : undefined;
      const items = requestedStatus ? document.items.filter((item) => item.status === requestedStatus) : document.items;
      if (flags.json) {
        printValue(items, true);
        return;
      }
      printValue(items.length === 0 ? '无' : items.map((item) => `${item.id} | ${item.status} | ${item.title}`).join('\n'));
      return;
    }
    case 'add': {
      if (rest.length < 2) {
        errorExit('用法：boardctl.mjs add <status> <title> [--notes <text>] [--json]');
      }
      const document = await ensureBoard(boardPath, markdownPath);
      const status = normalizeStatus(rest[0]);
      const title = rest.slice(1).join(' ').trim();
      if (!title) {
        errorExit('任务标题不能为空。');
      }
      assertUniqueTitle(document, title);
      const now = new Date().toISOString();
      const nextItem = {
        id: randomUUID(),
        title,
        status,
        createdAt: now,
        updatedAt: now,
        notes: flags.notes?.trim() ? flags.notes.trim() : undefined,
      };
      const nextDocument = await writeBoardArtifacts(boardPath, markdownPath, {
        ...document,
        updatedAt: now,
        items: [...document.items, nextItem],
      });
      printValue(nextDocument.items.find((item) => item.id === nextItem.id), flags.json);
      return;
    }
    case 'move': {
      if (rest.length < 2) {
        errorExit('用法：boardctl.mjs move <id-or-title> <status> [--notes <text>] [--json]');
      }
      const document = await ensureBoard(boardPath, markdownPath);
      const item = findItem(document, rest[0]);
      const nextStatus = normalizeStatus(rest[1]);
      const now = new Date().toISOString();
      const nextNotes = flags.notes === undefined
        ? item.notes
        : flags.notes.trim()
          ? flags.notes.trim()
          : undefined;
      const nextDocument = await writeBoardArtifacts(boardPath, markdownPath, {
        ...document,
        updatedAt: now,
        items: document.items.map((candidate) => candidate.id === item.id
          ? { ...candidate, status: nextStatus, notes: nextNotes, updatedAt: now }
          : candidate),
      });
      printValue(nextDocument.items.find((candidate) => candidate.id === item.id), flags.json);
      return;
    }
    case 'update': {
      if (rest.length < 1) {
        errorExit('用法：boardctl.mjs update <id-or-title> [--title <text>] [--notes <text>] [--json]');
      }
      if (!flags.title && flags.notes === undefined) {
        errorExit('update 至少需要提供 --title 或 --notes。');
      }
      const document = await ensureBoard(boardPath, markdownPath);
      const item = findItem(document, rest[0]);
      const nextTitle = flags.title?.trim() ? flags.title.trim() : item.title;
      assertUniqueTitle(document, nextTitle, item.id);
      const nextNotes = flags.notes === undefined
        ? item.notes
        : flags.notes.trim()
          ? flags.notes.trim()
          : undefined;
      const now = new Date().toISOString();
      const nextDocument = await writeBoardArtifacts(boardPath, markdownPath, {
        ...document,
        updatedAt: now,
        items: document.items.map((candidate) => candidate.id === item.id
          ? { ...candidate, title: nextTitle, notes: nextNotes, updatedAt: now }
          : candidate),
      });
      printValue(nextDocument.items.find((candidate) => candidate.id === item.id), flags.json);
      return;
    }
    case 'remove': {
      if (rest.length < 1) {
        errorExit('用法：boardctl.mjs remove <id-or-title> [--json]');
      }
      const document = await ensureBoard(boardPath, markdownPath);
      const item = findItem(document, rest[0]);
      const now = new Date().toISOString();
      const nextDocument = await writeBoardArtifacts(boardPath, markdownPath, {
        ...document,
        updatedAt: now,
        items: document.items.filter((candidate) => candidate.id !== item.id),
      });
      printValue(flags.json ? item : `${item.title}\n${formatBoardSummary(nextDocument)}`, flags.json);
      return;
    }
    case 'clear': {
      const document = await writeBoardArtifacts(boardPath, markdownPath, makeEmptyBoard());
      printValue(document, flags.json);
      return;
    }
    case 'import': {
      if (rest.length < 1) {
        errorExit('用法：boardctl.mjs import <input-json-path> [--replace] [--json]');
      }
      const payload = JSON.parse(await readFile(path.resolve(process.cwd(), rest[0]), 'utf8'));
      const imported = normalizeBoardDocument(payload);
      const current = await ensureBoard(boardPath, markdownPath);
      const merged = flags.replace
        ? imported
        : normalizeBoardDocument({
          version: 1,
          updatedAt: new Date().toISOString(),
          items: [...current.items, ...imported.items],
        });
      const nextDocument = await writeBoardArtifacts(boardPath, markdownPath, {
        ...merged,
        updatedAt: new Date().toISOString(),
      });
      printValue(nextDocument, flags.json || true);
      return;
    }
    case 'render-md': {
      const document = await ensureBoard(boardPath, markdownPath);
      const markdown = formatBoardMarkdown(document);
      if (flags.stdout) {
        printValue(markdown);
        return;
      }
      await writeBoardArtifacts(boardPath, markdownPath, document);
      printValue(markdownPath);
      return;
    }
    default:
      errorExit(`未知命令：${command}\n\n${usage()}`);
  }
}

await main();
