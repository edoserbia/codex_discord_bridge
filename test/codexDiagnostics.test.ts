import test from 'node:test';
import assert from 'node:assert/strict';

import {
  diagnoseCodexFailure,
  filterDiagnosticStderr,
  isIgnorableCodexStderrLine,
  normalizeCodexDiagnosticLine,
  shouldRetryUnexpectedCodexExit,
} from '../src/codexDiagnostics.js';

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

test('diagnostics rewrites obsolete full-permission profile errors into actionable guidance', () => {
  const normalized = normalizeCodexDiagnosticLine(
    '\u001b[31mERROR\u001b[0m Permissions profile `full` does not define any recognized filesystem entries for this version of Codex. Filesystem access will remain restricted. Upgrade Codex if this profile expects filesystem permissions.',
  );

  assert.match(normalized, /default_permissions="full"/);
  assert.match(normalized, /\[permissions\.full\]/);
  assert.match(normalized, /sandbox_mode="danger-full-access"/);
  assert.doesNotMatch(normalized, /\u001b\[/);
});
