const BRIDGE_MANAGED_PROXY_FLAG = 'CODEX_TUNNING_DISCORD_PROXY_INJECTED';
const BRIDGE_MANAGED_PROXY_KEYS_ENV = 'CODEX_TUNNING_DISCORD_PROXY_INJECTED_KEYS';
const BRIDGE_MANAGED_PROXY_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
];

export function buildCodexChildEnv(workspacePath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PWD: workspacePath,
  };

  const blockedExactKeys = new Set([
    'CODEX_CI',
    'CODEX_SHELL',
    'CODEX_THREAD_ID',
  ]);

  for (const key of Object.keys(env)) {
    if (key.startsWith('CODEX_TUNNING_')) {
      continue;
    }

    if (key === 'CODEX_HOME' || key === 'CODEX_CONFIG_HOME') {
      continue;
    }

    if (blockedExactKeys.has(key) || key.startsWith('CODEX_INTERNAL_')) {
      delete env[key];
    }
  }

  const bridgeManagedProxyKeys = resolveBridgeManagedProxyKeys(env);
  if (bridgeManagedProxyKeys.length > 0) {
    for (const key of bridgeManagedProxyKeys) {
      delete env[key];
    }
  }

  return env;
}

function isBridgeManagedProxyEnabled(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function resolveBridgeManagedProxyKeys(env: NodeJS.ProcessEnv): string[] {
  const explicitKeys = env[BRIDGE_MANAGED_PROXY_KEYS_ENV]
    ?.split(',')
    .map((key) => key.trim())
    .filter((key) => BRIDGE_MANAGED_PROXY_KEYS.includes(key));

  if (explicitKeys && explicitKeys.length > 0) {
    return [...new Set(explicitKeys)];
  }

  return isBridgeManagedProxyEnabled(env[BRIDGE_MANAGED_PROXY_FLAG])
    ? BRIDGE_MANAGED_PROXY_KEYS
    : [];
}
