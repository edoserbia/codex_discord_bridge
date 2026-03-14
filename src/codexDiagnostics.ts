import type { CancellationReason, CodexRunResult } from './types.js';

const IGNORABLE_CODEX_STDERR_PATTERNS = [
  /^WARNING: failed to clean up stale arg0 temp dirs: Permission denied \(os error 13\)$/,
];

const TRANSIENT_CODEX_FAILURE_PATTERNS = [
  /stream disconnected before completion/i,
  /error sending request for url/i,
  /connection reset/i,
  /timed? out/i,
  /temporarily unavailable/i,
  /reconnecting\.\.\./i,
  /rate limit/i,
  /too many requests/i,
  /\b429\b/,
  /\b5\d\d\b/,
];

const STALE_SESSION_FAILURE_PATTERNS = [
  /(thread|conversation|session).*(not found|missing|unknown|invalid|expired|stale)/i,
  /failed to resume/i,
  /could not resume/i,
  /resume.*failed/i,
];

export type CodexFailureKind = 'none' | 'unexpected-empty-exit' | 'transient' | 'stale-session' | 'diagnostic';

export interface CodexFailureDiagnosis {
  retryable: boolean;
  kind: CodexFailureKind;
  diagnosticLines: string[];
}

export function isIgnorableCodexStderrLine(line: string): boolean {
  const normalized = line.trim();

  if (!normalized) {
    return true;
  }

  return IGNORABLE_CODEX_STDERR_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function filterDiagnosticStderr(lines: string[]): string[] {
  return lines.filter((line) => !isIgnorableCodexStderrLine(line));
}

function looksLikeAbruptIncompleteTurn(result: CodexRunResult): boolean {
  return !result.turnCompleted
    && result.signal === null
    && (result.exitCode === 0 || result.exitCode === 1 || result.exitCode === null);
}

export function diagnoseCodexFailure(
  result: CodexRunResult,
  cancellationReason?: CancellationReason,
): CodexFailureDiagnosis {
  const diagnosticLines = filterDiagnosticStderr(result.stderr);

  if (result.success || cancellationReason) {
    return {
      retryable: false,
      kind: 'none',
      diagnosticLines,
    };
  }

  const hasStaleSessionSignal = diagnosticLines.some((line) => STALE_SESSION_FAILURE_PATTERNS.some((pattern) => pattern.test(line)));
  if (hasStaleSessionSignal && looksLikeAbruptIncompleteTurn(result)) {
    return {
      retryable: true,
      kind: 'stale-session',
      diagnosticLines,
    };
  }

  const hasTransientSignal = diagnosticLines.some((line) => TRANSIENT_CODEX_FAILURE_PATTERNS.some((pattern) => pattern.test(line)));
  if (hasTransientSignal && !result.turnCompleted) {
    return {
      retryable: true,
      kind: 'transient',
      diagnosticLines,
    };
  }

  if (looksLikeAbruptIncompleteTurn(result) && diagnosticLines.length === 0) {
    return {
      retryable: true,
      kind: 'unexpected-empty-exit',
      diagnosticLines,
    };
  }

  return {
    retryable: false,
    kind: diagnosticLines.length > 0 ? 'diagnostic' : 'none',
    diagnosticLines,
  };
}

export function shouldRetryUnexpectedCodexExit(
  result: CodexRunResult,
  cancellationReason?: CancellationReason,
): boolean {
  return diagnoseCodexFailure(result, cancellationReason).retryable;
}
