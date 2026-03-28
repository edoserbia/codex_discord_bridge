import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { downloadAttachments } from '../src/attachments.js';

import { cleanupDir, createWorkspace, makeTempDir, startStaticServer } from './helpers/testUtils.js';

test('downloadAttachments preserves original names and adds random suffixes only when paths collide', async () => {
  const rootDir = await makeTempDir('codex-bridge-attachments-');
  const workspace = await createWorkspace(rootDir);
  const dataDir = path.join(rootDir, 'data');
  const originalName = 'Quarterly Report 终稿.pdf';
  const inboxDir = path.join(workspace, 'inbox');
  const existingInboxPath = path.join(inboxDir, originalName);
  const staticServer = await startStaticServer({
    '/first.pdf': { body: 'first payload', contentType: 'application/pdf' },
    '/second.pdf': { body: 'second payload', contentType: 'application/pdf' },
  });

  try {
    await mkdir(inboxDir, { recursive: true });
    await writeFile(existingInboxPath, 'existing inbox payload', 'utf8');

    const result = await downloadAttachments(
      dataDir,
      'conversation-1',
      'task-1',
      [
        { name: originalName, url: `${staticServer.origin}/first.pdf`, contentType: 'application/pdf', size: 13 },
        { name: originalName, url: `${staticServer.origin}/second.pdf`, contentType: 'application/pdf', size: 14 },
      ],
      workspace,
    );

    assert.equal(result.attachments.length, 2);

    const first = result.attachments[0]!;
    const second = result.attachments[1]!;

    assert.equal(first.name, originalName);
    assert.equal(path.basename(first.localPath), originalName);
    assert.match(path.basename(second.localPath), /^Quarterly Report 终稿-[a-f0-9]{8}\.pdf$/);

    assert.ok(first.workspaceLocalPath);
    assert.ok(second.workspaceLocalPath);
    assert.match(path.basename(first.workspaceLocalPath!), /^Quarterly Report 终稿-[a-f0-9]{8}\.pdf$/);
    assert.match(path.basename(second.workspaceLocalPath!), /^Quarterly Report 终稿-[a-f0-9]{8}\.pdf$/);
    assert.notEqual(path.basename(first.workspaceLocalPath!), originalName);
    assert.notEqual(path.basename(second.workspaceLocalPath!), originalName);
    assert.notEqual(path.basename(first.workspaceLocalPath!), path.basename(second.workspaceLocalPath!));
  } finally {
    await staticServer.close();
    await cleanupDir(rootDir);
  }
});
