import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { cleanupDir, createWorkspace, makeTempDir } from './helpers/testUtils.js';

const execFileAsync = promisify(execFile);
const boardctlPath = path.join(process.cwd(), 'skills', 'autopilot-governor', 'scripts', 'boardctl.mjs');

async function runBoardCtl(workspace: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [boardctlPath, ...args], {
    cwd: workspace,
  });
  return stdout.trim();
}

test('boardctl creates, updates, and synchronizes board artifacts', async () => {
  const rootDir = await makeTempDir('codex-bridge-boardctl-');
  const workspace = await createWorkspace(rootDir);

  try {
    const ensured = JSON.parse(await runBoardCtl(workspace, 'ensure', '--json'));
    assert.equal(ensured.items.length, 0);

    const first = JSON.parse(await runBoardCtl(workspace, 'add', 'ready', '验证 noVNC 键盘输入', '--notes', '优先测试真实容器', '--json'));
    assert.equal(first.status, 'ready');

    const moved = JSON.parse(await runBoardCtl(workspace, 'move', first.id, 'doing', '--json'));
    assert.equal(moved.status, 'doing');

    const updated = JSON.parse(await runBoardCtl(workspace, 'update', first.id, '--notes', '已补充交互链路', '--json'));
    assert.equal(updated.notes, '已补充交互链路');

    await runBoardCtl(workspace, 'add', 'ready', '补充 gateway fallback 覆盖', '--json');
    await runBoardCtl(workspace, 'move', first.id, 'done', '--json');

    const exported = JSON.parse(await runBoardCtl(workspace, 'export', '--json'));
    assert.equal(exported.items.length, 2);
    assert.equal(exported.items.filter((item: { status: string }) => item.status === 'done').length, 1);
    assert.equal(exported.items.filter((item: { status: string }) => item.status === 'ready').length, 1);

    const status = JSON.parse(await runBoardCtl(workspace, 'status', '--json'));
    assert.equal(status.counts.done, 1);
    assert.equal(status.counts.ready, 1);

    const boardJsonPath = path.join(workspace, '.codex', 'autopilot', 'board.json');
    const boardMarkdownPath = path.join(workspace, 'docs', 'AUTOPILOT_BOARD.md');
    await access(boardJsonPath);
    await access(boardMarkdownPath);
    const markdown = await readFile(boardMarkdownPath, 'utf8');
    assert.match(markdown, /## done/);
    assert.match(markdown, /验证 noVNC 键盘输入/);
    assert.match(markdown, /补充 gateway fallback 覆盖/);
  } finally {
    await cleanupDir(rootDir);
  }
});

test('boardctl imports a legacy board payload with replace semantics', async () => {
  const rootDir = await makeTempDir('codex-bridge-boardctl-import-');
  const workspace = await createWorkspace(rootDir);

  try {
    const importPath = path.join(rootDir, 'legacy-board.json');
    await writeFile(importPath, JSON.stringify({
      items: [
        {
          id: 'legacy-ready',
          title: '补充实例删除确认回归',
          status: 'ready',
          updatedAt: '2026-03-16T00:00:00.000Z',
        },
        {
          id: 'legacy-done',
          title: '修复 cron 删除确认',
          status: 'done',
          updatedAt: '2026-03-16T00:00:00.000Z',
        },
      ],
    }, null, 2));

    const imported = JSON.parse(await runBoardCtl(workspace, 'import', importPath, '--replace', '--json'));
    assert.equal(imported.items.length, 2);

    const listed = JSON.parse(await runBoardCtl(workspace, 'list', 'ready', '--json'));
    assert.equal(listed.length, 1);
    assert.equal(listed[0].title, '补充实例删除确认回归');
  } finally {
    await cleanupDir(rootDir);
  }
});
