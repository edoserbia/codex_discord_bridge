import type { CancellationReason, CodexRunResult } from './types.js';

const IGNORABLE_CODEX_STDERR_PATTERNS = [
  /^WARNING: failed to clean up stale arg0 temp dirs: Permission denied \(os error 13\)$/,
];

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

export function shouldRetryUnexpectedCodexExit(
  result: CodexRunResult,
  cancellationReason?: CancellationReason,
): boolean {
  if (result.success || cancellationReason) {
    return false;
  }

  if (result.exitCode !== 1 || result.signal !== null || result.turnCompleted) {
    return false;
  }

  return filterDiagnosticStderr(result.stderr).length === 0;
}
