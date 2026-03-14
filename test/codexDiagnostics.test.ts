import test from 'node:test';
import assert from 'node:assert/strict';

import { diagnoseCodexFailure, filterDiagnosticStderr, isIgnorableCodexStderrLine, shouldRetryUnexpectedCodexExit } from '../src/codexDiagnostics.js';

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

test('diagnostics classifies transient Codex stream failures from structured events as retryable', () => {
  const diagnosis = diagnoseCodexFailure({
    success: false,
    exitCode: 1,
    signal: null,
    usedResume: true,
    turnCompleted: false,
    agentMessages: [],
    reasoning: [],
    planItems: [],
    stderr: ['Codex turn failed: stream disconnected before completion: error sending request for url (https://example.invalid/v1/responses)'],
    commands: [],
  });

  assert.equal(diagnosis.retryable, true);
  assert.equal(diagnosis.kind, 'transient');
});

test('diagnostics classifies stale resume failures separately from generic exits', () => {
  const diagnosis = diagnoseCodexFailure({
    success: false,
    exitCode: 1,
    signal: null,
    usedResume: true,
    turnCompleted: false,
    agentMessages: [],
    reasoning: [],
    planItems: [],
    stderr: ['Codex turn failed: conversation session not found for resume thread'],
    commands: [],
  });

  assert.equal(diagnosis.retryable, true);
  assert.equal(diagnosis.kind, 'stale-session');
});

test('diagnostics retries zero-exit incomplete turns when no diagnostic signal exists', () => {
  const diagnosis = diagnoseCodexFailure({
    success: false,
    exitCode: 0,
    signal: null,
    usedResume: true,
    turnCompleted: false,
    agentMessages: [],
    reasoning: [],
    planItems: [],
    stderr: ['WARNING: failed to clean up stale arg0 temp dirs: Permission denied (os error 13)'],
    commands: [],
  });

  assert.equal(diagnosis.retryable, true);
  assert.equal(diagnosis.kind, 'unexpected-empty-exit');
});
