import test from 'node:test';
import assert from 'node:assert/strict';

import { filterDiagnosticStderr, isIgnorableCodexStderrLine, shouldRetryUnexpectedCodexExit } from '../src/codexDiagnostics.js';

test('diagnostics filters known non-fatal codex temp-dir warning', () => {
  assert.equal(
    isIgnorableCodexStderrLine('WARNING: failed to clean up stale arg0 temp dirs: Permission denied (os error 13)'),
    true,
  );

  assert.deepEqual(
    filterDiagnosticStderr([
      'WARNING: failed to clean up stale arg0 temp dirs: Permission denied (os error 13)',
      'real stderr line',
    ]),
    ['real stderr line'],
  );
});

test('diagnostics retries unexpected codex exit when only ignorable warning is present', () => {
  assert.equal(
    shouldRetryUnexpectedCodexExit({
      success: false,
      exitCode: 1,
      signal: null,
      usedResume: false,
      turnCompleted: false,
      agentMessages: [],
      reasoning: [],
      planItems: [],
      stderr: ['WARNING: failed to clean up stale arg0 temp dirs: Permission denied (os error 13)'],
      commands: [],
    }),
    true,
  );

  assert.equal(
    shouldRetryUnexpectedCodexExit({
      success: false,
      exitCode: 1,
      signal: null,
      usedResume: false,
      turnCompleted: false,
      agentMessages: [],
      reasoning: [],
      planItems: [],
      stderr: ['intentional fake failure'],
      commands: [],
    }),
    false,
  );

  assert.equal(
    shouldRetryUnexpectedCodexExit({
      success: false,
      exitCode: 1,
      signal: null,
      usedResume: false,
      turnCompleted: false,
      agentMessages: [],
      reasoning: [],
      planItems: [],
      stderr: ['WARNING: failed to clean up stale arg0 temp dirs: Permission denied (os error 13)'],
      commands: [],
    }, 'guidance'),
    false,
  );
});
