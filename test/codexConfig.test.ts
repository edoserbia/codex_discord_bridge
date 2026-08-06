import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  clearCodexGlobalReasoningEffort,
  loadCodexGlobalReasoningEffort,
  readRootReasoningEffortFromToml,
  removeRootReasoningEffortFromToml,
  upsertRootReasoningEffortInToml,
  writeCodexGlobalReasoningEffort,
} from '../src/codexConfig.js';

test('read root reasoning effort from double and single quoted TOML strings only', () => {
  assert.equal(readRootReasoningEffortFromToml('model_reasoning_effort = "high"\n'), 'high');
  assert.equal(readRootReasoningEffortFromToml("model_reasoning_effort = 'xhigh' # keep\n"), 'xhigh');
  assert.equal(
    readRootReasoningEffortFromToml('[profiles.default]\nmodel_reasoning_effort = "low"\n'),
    undefined,
  );
  assert.equal(readRootReasoningEffortFromToml('model_reasoning_effort = "extreme"\n'), undefined);
  assert.equal(readRootReasoningEffortFromToml('model_reasoning_effort = high\n'), undefined);
});

test('upsert root reasoning effort preserves indentation, comments, and unrelated sections', () => {
  const content = [
    'model = "gpt-5"',
    "  model_reasoning_effort = 'low'   # operator choice",
    '',
    '[profiles.default]',
    'model_reasoning_effort = "minimal"',
    'approval_policy = "never"',
    '',
  ].join('\n');

  assert.equal(
    upsertRootReasoningEffortInToml(content, 'xhigh'),
    [
      'model = "gpt-5"',
      '  model_reasoning_effort = "xhigh"   # operator choice',
      '',
      '[profiles.default]',
      'model_reasoning_effort = "minimal"',
      'approval_policy = "never"',
      '',
    ].join('\n'),
  );
});

test('upsert root reasoning effort handles empty content and inserts before the first section', () => {
  assert.equal(upsertRootReasoningEffortInToml('', 'medium'), 'model_reasoning_effort = "medium"');
  assert.equal(
    upsertRootReasoningEffortInToml('[profiles.default]\nmodel = "gpt-5"\n', 'high'),
    'model_reasoning_effort = "high"\n\n[profiles.default]\nmodel = "gpt-5"\n',
  );
  assert.equal(
    upsertRootReasoningEffortInToml('model = "gpt-5"\n[profiles.default]\nmodel = "gpt-4"\n', 'low'),
    'model = "gpt-5"\nmodel_reasoning_effort = "low"\n[profiles.default]\nmodel = "gpt-4"\n',
  );
});

test('remove root reasoning effort deletes only the matching root line', () => {
  const content = [
    'model = "gpt-5"',
    'model_reasoning_effort = "high" # remove this line',
    '',
    '[profiles.default]',
    'model_reasoning_effort = "low"',
    '',
  ].join('\n');

  assert.equal(
    removeRootReasoningEffortFromToml(content),
    [
      'model = "gpt-5"',
      '',
      '[profiles.default]',
      'model_reasoning_effort = "low"',
      '',
    ].join('\n'),
  );
  assert.equal(removeRootReasoningEffortFromToml('model = "gpt-5"\n'), 'model = "gpt-5"\n');
});

test('global reasoning effort file helpers handle missing files and preserve final newlines', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'codex-config-effort-'));
  const configPath = path.join(rootDir, '.codex', 'config.toml');

  try {
    assert.equal(await loadCodexGlobalReasoningEffort(configPath), undefined);

    await writeCodexGlobalReasoningEffort(configPath, 'high');
    assert.equal(await loadCodexGlobalReasoningEffort(configPath), 'high');
    assert.equal(await readFile(configPath, 'utf8'), 'model_reasoning_effort = "high"\n');

    await writeFile(configPath, 'model = "gpt-5"\nmodel_reasoning_effort = "high"\n[profiles.default]\nmodel_reasoning_effort = "low"', 'utf8');
    await clearCodexGlobalReasoningEffort(configPath);
    assert.equal(
      await readFile(configPath, 'utf8'),
      'model = "gpt-5"\n[profiles.default]\nmodel_reasoning_effort = "low"\n',
    );

    const missingPath = path.join(rootDir, 'missing', 'config.toml');
    await clearCodexGlobalReasoningEffort(missingPath);
    await assert.rejects(access(missingPath), { code: 'ENOENT' });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('global reasoning effort writes preserve unrelated TOML content', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'codex-config-effort-preserve-'));
  const configPath = path.join(rootDir, '.codex', 'config.toml');

  try {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, '# operator config\nmodel = "gpt-5"\n\n[projects."/tmp/api"]\ntrust_level = "trusted"\n', 'utf8');

    await writeCodexGlobalReasoningEffort(configPath, 'minimal');

    assert.equal(
      await readFile(configPath, 'utf8'),
      '# operator config\nmodel = "gpt-5"\n\nmodel_reasoning_effort = "minimal"\n[projects."/tmp/api"]\ntrust_level = "trusted"\n',
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
