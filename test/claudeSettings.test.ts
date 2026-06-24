import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import {
  allowClaudeProjectTool,
  readEffectiveClaudeModel,
  writeClaudeGlobalModel,
  writeClaudeProjectModel,
} from '../src/claudeSettings.js';

import { cleanupDir, createWorkspace, makeTempDir } from './helpers/testUtils.js';

test('project Claude settings override the global Claude model', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('claude-settings-effective-');
  const workspace = await createWorkspace(path.join(rootDir, 'workspace'));
  const globalSettingsPath = path.join(rootDir, '.claude', 'settings.json');
  await mkdir(path.dirname(globalSettingsPath), { recursive: true });
  await writeFile(globalSettingsPath, JSON.stringify({ model: 'claude-global' }, null, 2), 'utf8');

  try {
    await writeClaudeProjectModel(workspace, 'claude-project');
    const effective = await readEffectiveClaudeModel(workspace, globalSettingsPath);

    assert.deepEqual(effective, {
      model: 'claude-project',
      source: 'project',
      projectSettingsPath: path.join(workspace, '.claude', 'settings.json'),
      globalSettingsPath,
    });
  } finally {
    await cleanupDir(rootDir);
  }
});

test('writeClaudeProjectModel writes the workspace .claude/settings.json file', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('claude-settings-project-write-');
  const workspace = await createWorkspace(path.join(rootDir, 'workspace'));
  const globalSettingsPath = path.join(rootDir, '.claude', 'settings.json');
  await mkdir(path.dirname(globalSettingsPath), { recursive: true });
  await writeFile(globalSettingsPath, JSON.stringify({ model: 'claude-global', ui: { theme: 'dark' } }, null, 2), 'utf8');

  try {
    await writeClaudeProjectModel(workspace, 'claude-project');

    const projectSettingsPath = path.join(workspace, '.claude', 'settings.json');
    const projectSettings = JSON.parse(await readFile(projectSettingsPath, 'utf8')) as { model?: string; ui?: { theme?: string } };
    const globalSettings = JSON.parse(await readFile(globalSettingsPath, 'utf8')) as { model?: string; ui?: { theme?: string } };

    assert.equal(projectSettings.model, 'claude-project');
    assert.equal(globalSettings.model, 'claude-global');
    assert.equal(globalSettings.ui?.theme, 'dark');
  } finally {
    await cleanupDir(rootDir);
  }
});

test('writeClaudeGlobalModel writes the global ~/.claude/settings.json file', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('claude-settings-global-write-');
  const globalSettingsPath = path.join(rootDir, '.claude', 'settings.json');
  await mkdir(path.dirname(globalSettingsPath), { recursive: true });
  await writeFile(globalSettingsPath, JSON.stringify({ model: 'claude-old', ui: { theme: 'dark' } }, null, 2), 'utf8');

  try {
    await writeClaudeGlobalModel(globalSettingsPath, 'claude-global');

    const globalSettings = JSON.parse(await readFile(globalSettingsPath, 'utf8')) as { model?: string; ui?: { theme?: string } };
    assert.equal(globalSettings.model, 'claude-global');
    assert.equal(globalSettings.ui?.theme, 'dark');
  } finally {
    await cleanupDir(rootDir);
  }
});

test('allowClaudeProjectTool appends project permission without duplicating or changing global settings', { concurrency: false }, async () => {
  const rootDir = await makeTempDir('claude-settings-project-permission-');
  const workspace = await createWorkspace(path.join(rootDir, 'workspace'));
  const globalSettingsPath = path.join(rootDir, '.claude', 'settings.json');
  await mkdir(path.dirname(globalSettingsPath), { recursive: true });
  await writeFile(globalSettingsPath, JSON.stringify({
    model: 'claude-global',
    permissions: {
      allow: ['Read'],
      deny: ['Bash(rm:*)'],
    },
  }, null, 2), 'utf8');

  try {
    await writeClaudeProjectModel(workspace, 'claude-project');
    await allowClaudeProjectTool(workspace, 'Bash(fake:*)');
    await allowClaudeProjectTool(workspace, 'Bash(fake:*)');

    const projectSettingsPath = path.join(workspace, '.claude', 'settings.json');
    const projectSettings = JSON.parse(await readFile(projectSettingsPath, 'utf8')) as {
      model?: string;
      permissions?: { allow?: string[]; deny?: string[] };
    };
    const globalSettings = JSON.parse(await readFile(globalSettingsPath, 'utf8')) as {
      permissions?: { allow?: string[]; deny?: string[] };
    };

    assert.equal(projectSettings.model, 'claude-project');
    assert.deepEqual(projectSettings.permissions?.allow, ['Bash(fake:*)']);
    assert.deepEqual(projectSettings.permissions?.deny, []);
    assert.deepEqual(globalSettings.permissions?.allow, ['Read']);
    assert.deepEqual(globalSettings.permissions?.deny, ['Bash(rm:*)']);
  } finally {
    await cleanupDir(rootDir);
  }
});
