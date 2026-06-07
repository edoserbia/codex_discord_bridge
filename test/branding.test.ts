import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const forbiddenTerms = [
  'cc' + '-bridge',
  'CC' + ' Bridge',
  'ccbridge',
  'CC' + 'Bridge',
];

test('tracked project files do not keep ccbridge branding', async () => {
  const { stdout } = await execFileAsync('git', ['ls-files'], { cwd: process.cwd() });
  const offenders: string[] = [];

  for (const filePath of stdout.split('\n').filter(Boolean)) {
    if (filePath === 'test/branding.test.ts') {
      continue;
    }

    const contents = await readFile(filePath, 'utf8');
    for (const forbiddenTerm of forbiddenTerms) {
      if (contents.includes(forbiddenTerm)) {
        offenders.push(`${filePath}: ${forbiddenTerm}`);
      }
    }
  }

  assert.deepEqual(offenders, []);
});
