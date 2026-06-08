const DISCORD_WS_STACK_PATTERNS = [
  /node_modules\/@discordjs\/ws\//i,
  /node_modules\/discord\.js\/src\/client\/websocket\//i,
];

const WS_STACK_PATTERN = /node_modules\/ws\/lib\/websocket\.js/i;

const TRANSIENT_WS_ERROR_PATTERNS = [
  /Opening handshake has timed out/i,
  /socket hang up/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /Client network socket disconnected/i,
  /secure TLS connection was established/i,
];

export function isKnownDiscordWebSocketNetworkError(error: unknown): boolean {
  const text = describeProcessError(error);
  if (!text) {
    return false;
  }

  const hasTransientNetworkError = TRANSIENT_WS_ERROR_PATTERNS.some((pattern) => pattern.test(text));
  if (!hasTransientNetworkError) {
    return false;
  }

  if (/Opening handshake has timed out/i.test(text) && WS_STACK_PATTERN.test(text)) {
    return true;
  }

  const hasDiscordWebSocketStack = DISCORD_WS_STACK_PATTERNS.some((pattern) => pattern.test(text));
  return hasDiscordWebSocketStack && WS_STACK_PATTERN.test(text);
}

export function describeProcessError(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();

  const visit = (value: unknown, depth = 0): void => {
    if (value == null || depth > 3 || seen.has(value)) {
      return;
    }

    seen.add(value);

    if (value instanceof Error) {
      if (value.message) {
        parts.push(value.message);
      }
      const code = (value as NodeJS.ErrnoException).code;
      if (typeof code === 'string') {
        parts.push(code);
      }
      if (value.stack) {
        parts.push(value.stack);
      }
      visit((value as Error & { cause?: unknown }).cause, depth + 1);
      return;
    }

    if (typeof value === 'object') {
      const candidate = value as { message?: unknown; code?: unknown; stack?: unknown; cause?: unknown; error?: unknown };
      if (typeof candidate.message === 'string') {
        parts.push(candidate.message);
      }
      if (typeof candidate.code === 'string') {
        parts.push(candidate.code);
      }
      if (typeof candidate.stack === 'string') {
        parts.push(candidate.stack);
      }
      visit(candidate.error, depth + 1);
      visit(candidate.cause, depth + 1);
      return;
    }

    if (typeof value === 'string') {
      parts.push(value);
    }
  };

  visit(error);
  return parts.join('\n');
}
