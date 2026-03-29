import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { allocateInboxFilePath, formatFileCandidates, getWorkspaceInboxDir, resolveFileRequest } from '../src/fileTransfer.js';

import { cleanupDir, createWorkspace, makeTempDir } from './helpers/testUtils.js';

test('getWorkspaceInboxDir returns the default inbox path inside the workspace', () => {
  assert.equal(getWorkspaceInboxDir('/tmp/demo-workspace'), path.join('/tmp/demo-workspace', 'inbox'));
});

test('allocateInboxFilePath preserves the original name and adds a random suffix only on collision', async () => {
  const rootDir = await makeTempDir('codex-bridge-file-transfer-allocate-');
  const workspace = await createWorkspace(rootDir);
  const inboxDir = path.join(workspace, 'inbox');

  try {
    await mkdir(inboxDir, { recursive: true });

    const freePath = await allocateInboxFilePath(workspace, 'Quarterly Report 终稿.pdf');
    assert.equal(path.basename(freePath), 'Quarterly Report 终稿.pdf');

    await writeFile(path.join(inboxDir, 'Quarterly Report 终稿.pdf'), 'existing', 'utf8');

    const collidedPath = await allocateInboxFilePath(workspace, 'Quarterly Report 终稿.pdf');
    assert.match(path.basename(collidedPath), /^Quarterly Report 终稿-[a-f0-9]{8}\.pdf$/);
    assert.notEqual(path.basename(collidedPath), 'Quarterly Report 终稿.pdf');
  } finally {
    await cleanupDir(rootDir);
  }
});

test('resolveFileRequest ranks inbox matches before the rest of the workspace', async () => {
  const rootDir = await makeTempDir('codex-bridge-file-transfer-rank-');
  const workspace = await createWorkspace(rootDir);
  const inboxDir = path.join(workspace, 'inbox');
  const exportDir = path.join(workspace, 'exports');
  const inboxFile = path.join(inboxDir, 'report.pdf');
  const exportFile = path.join(exportDir, 'report.pdf');

  try {
    await mkdir(inboxDir, { recursive: true });
    await mkdir(exportDir, { recursive: true });
    await writeFile(inboxFile, 'inbox copy', 'utf8');
    await writeFile(exportFile, 'export copy', 'utf8');

    const now = new Date('2026-03-27T10:00:00Z');
    await utimes(inboxFile, now, now);
    await utimes(exportFile, now, now);

    const result = await resolveFileRequest({
      workspacePath: workspace,
      request: 'report.pdf',
      allowAbsolutePath: false,
    });

    assert.equal(result.kind, 'candidates');
    assert.equal(result.candidates[0]?.workspaceRelativePath, path.join('inbox', 'report.pdf'));
    assert.equal(result.candidates[1]?.workspaceRelativePath, path.join('exports', 'report.pdf'));
  } finally {
    await cleanupDir(rootDir);
  }
});

test('formatFileCandidates renders numbered follow-up guidance', () => {
  const text = formatFileCandidates([
    {
      absolutePath: '/tmp/workspace/inbox/report.pdf',
      workspaceRelativePath: 'inbox/report.pdf',
      name: 'report.pdf',
      size: 128,
      modifiedAtMs: Date.parse('2026-03-27T10:23:00Z'),
      inWorkspace: true,
      inInbox: true,
    },
    {
      absolutePath: '/tmp/workspace/exports/report.pdf',
      workspaceRelativePath: 'exports/report.pdf',
      name: 'report.pdf',
      size: 256,
      modifiedAtMs: Date.parse('2026-03-27T10:24:00Z'),
      inWorkspace: true,
      inInbox: false,
    },
  ], { commandPrefix: '!' });

  assert.match(text, /找到多个匹配文件/);
  assert.match(text, /1\.\s+report\.pdf/);
  assert.match(text, /inbox\/report\.pdf/);
  assert.match(text, /2\.\s+report\.pdf/);
  assert.match(text, /exports\/report\.pdf/);
  assert.match(text, /发第 2 个/);
  assert.match(text, /!sendfile 2/);
});

test('resolveFileRequest rejects explicit absolute paths for non-admin send requests', async () => {
  const rootDir = await makeTempDir('codex-bridge-file-transfer-absolute-');
  const workspace = await createWorkspace(rootDir);
  const secretFile = path.join(rootDir, 'secret.txt');

  try {
    await writeFile(secretFile, 'top secret', 'utf8');

    const result = await resolveFileRequest({
      workspacePath: workspace,
      request: secretFile,
      allowAbsolutePath: false,
    });

    assert.equal(result.kind, 'denied');
    assert.match(result.message, /管理员/);
    assert.match(result.message, /绝对路径/);
  } finally {
    await cleanupDir(rootDir);
  }
});
