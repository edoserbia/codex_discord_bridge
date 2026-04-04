import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { cleanupDir, makeTempDir, startStaticServer } from './helpers/testUtils.js';

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve('scripts/macos-bridge.sh');

async function runBash(script: string, env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync('/bin/bash', ['-lc', script], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      ...env,
    },
  });

  return stdout;
}

async function startProxyResponder(): Promise<{ proxyUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    if (!request.url?.startsWith('http://')) {
      response.writeHead(502);
      response.end('expected proxy request');
      return;
    }

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"url":"proxied"}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to get proxy address');
  }

  return {
    proxyUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

test('macos bridge proxy autodetect clears the bridge proxy when direct Discord access works', async () => {
  const rootDir = await makeTempDir('codex-bridge-macos-proxy-direct-');
  const envFile = path.join(rootDir, '.env');
  const server = await startStaticServer({
    '/gateway': {
      body: '{}',
      contentType: 'application/json',
    },
  });

  try {
    await writeFile(envFile, 'CODEX_DISCORD_BRIDGE_PROXY=http://127.0.0.1:9999\n', 'utf8');

    await runBash(
      `source "${scriptPath}"
ENV_FILE="${envFile}"
CODEX_DISCORD_BRIDGE_PROBE_URL="${server.origin}/gateway"
CODEX_DISCORD_BRIDGE_PROBE_TIMEOUT_SECONDS=2
auto_configure_bridge_proxy`,
      {},
    );

    const envContents = await readFile(envFile, 'utf8');
    assert.match(envContents, /^CODEX_DISCORD_BRIDGE_PROXY=$/m);
  } finally {
    await server.close();
    await cleanupDir(rootDir);
  }
});

test('macos bridge proxy autodetect falls back to the configured proxy candidate when direct access fails', async () => {
  const rootDir = await makeTempDir('codex-bridge-macos-proxy-fallback-');
  const envFile = path.join(rootDir, '.env');
  const proxyServer = await startProxyResponder();

  try {
    await writeFile(envFile, 'CODEX_DISCORD_BRIDGE_PROXY=\n', 'utf8');

    await runBash(
      `source "${scriptPath}"
ENV_FILE="${envFile}"
CODEX_DISCORD_BRIDGE_PROBE_URL="http://discord-probe.invalid/gateway"
CODEX_DISCORD_BRIDGE_PROXY_CANDIDATE="${proxyServer.proxyUrl}"
CODEX_DISCORD_BRIDGE_PROBE_TIMEOUT_SECONDS=2
auto_configure_bridge_proxy`,
      {},
    );

    const envContents = await readFile(envFile, 'utf8');
    assert.match(envContents, new RegExp(`^CODEX_DISCORD_BRIDGE_PROXY=${proxyServer.proxyUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  } finally {
    await proxyServer.close();
    await cleanupDir(rootDir);
  }
});

test('macos bridge proxy migration rewrites legacy OpenClaw proxy keys into bridge-specific keys', async () => {
  const rootDir = await makeTempDir('codex-bridge-macos-proxy-migrate-');
  const envFile = path.join(rootDir, '.env');

  try {
    await writeFile(
      envFile,
      [
        'OPENCLAW_DISCORD_PROXY=http://127.0.0.1:7890',
        'OPENCLAW_DISCORD_CA_CERT=~/.codex-tunning/clash-ca.pem',
        '',
      ].join('\n'),
      'utf8',
    );

    await runBash(
      `source "${scriptPath}"
ENV_FILE="${envFile}"
migrate_legacy_bridge_proxy_env_keys`,
      {},
    );

    const envContents = await readFile(envFile, 'utf8');
    assert.match(envContents, /^CODEX_DISCORD_BRIDGE_PROXY=http:\/\/127\.0\.0\.1:7890$/m);
    assert.match(envContents, /^CODEX_DISCORD_BRIDGE_CA_CERT=~\/\.codex-tunning\/clash-ca\.pem$/m);
    assert.doesNotMatch(envContents, /^OPENCLAW_DISCORD_PROXY=/m);
    assert.doesNotMatch(envContents, /^OPENCLAW_DISCORD_CA_CERT=/m);
  } finally {
    await cleanupDir(rootDir);
  }
});

test('macos bridge proxy export marks bridge-managed proxy injection for child process filtering', async () => {
  const rootDir = await makeTempDir('codex-bridge-macos-proxy-export-');
  const envFile = path.join(rootDir, '.env');

  try {
    await writeFile(envFile, 'CODEX_DISCORD_BRIDGE_PROXY=http://127.0.0.1:7890\n', 'utf8');

    const output = await runBash(
      `source "${scriptPath}"
ENV_FILE="${envFile}"
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy CODEX_TUNNING_DISCORD_PROXY_INJECTED
maybe_export_proxy
printf 'HTTP_PROXY=%s\\n' "$HTTP_PROXY"
printf 'HTTPS_PROXY=%s\\n' "$HTTPS_PROXY"
printf 'CODEX_TUNNING_DISCORD_PROXY_INJECTED=%s\\n' "$CODEX_TUNNING_DISCORD_PROXY_INJECTED"
printf 'CODEX_TUNNING_DISCORD_PROXY_INJECTED_KEYS=%s\\n' "$CODEX_TUNNING_DISCORD_PROXY_INJECTED_KEYS"`,
      {},
    );

    assert.match(output, /^HTTP_PROXY=http:\/\/127\.0\.0\.1:7890$/m);
    assert.match(output, /^HTTPS_PROXY=http:\/\/127\.0\.0\.1:7890$/m);
    assert.match(output, /^CODEX_TUNNING_DISCORD_PROXY_INJECTED=1$/m);
    assert.match(output, /^CODEX_TUNNING_DISCORD_PROXY_INJECTED_KEYS=HTTP_PROXY,http_proxy,HTTPS_PROXY,https_proxy$/m);
  } finally {
    await cleanupDir(rootDir);
  }
});

test('macos bridge proxy force mode keeps the configured 7890 proxy even when direct access works', async () => {
  const rootDir = await makeTempDir('codex-bridge-macos-proxy-force-');
  const envFile = path.join(rootDir, '.env');
  const server = await startStaticServer({
    '/gateway': {
      body: '{}',
      contentType: 'application/json',
    },
  });

  try {
    await writeFile(
      envFile,
      [
        'CODEX_DISCORD_BRIDGE_PROXY=http://127.0.0.1:7890',
        'CODEX_DISCORD_BRIDGE_PROXY_FORCE=1',
        '',
      ].join('\n'),
      'utf8',
    );

    const output = await runBash(
      `source "${scriptPath}"
ENV_FILE="${envFile}"
CODEX_DISCORD_BRIDGE_PROBE_URL="${server.origin}/gateway"
CODEX_DISCORD_BRIDGE_PROBE_TIMEOUT_SECONDS=2
auto_configure_bridge_proxy
printf 'proxy=%s\\n' "$(read_env_value CODEX_DISCORD_BRIDGE_PROXY || true)"`,
      {},
    );

    assert.match(output, /^proxy=http:\/\/127\.0\.0\.1:7890$/m);
  } finally {
    await server.close();
    await cleanupDir(rootDir);
  }
});

test('macos bridge restart uses launchctl kickstart for installed launchd services', async () => {
  const output = await runBash(
    `source "${scriptPath}"
run_stop() { echo unexpected-stop; return 99; }
run_start() { echo unexpected-start; return 99; }
detect_installed_service_mode() { echo agent; }
has_multiple_installed_service_modes() { return 1; }
service_mode_label() { echo LaunchAgent; }
normalize_service_plist_permissions() { echo "normalize:$1"; }
service_is_bootstrapped() { return 0; }
service_target_for_mode() { echo "gui/502/test.bridge"; }
launchctl() { echo "launchctl:$*"; }
sleep() { :; }
run_status() { echo status; }
run_restart`,
    {},
  );

  assert.match(output, /^normalize:agent$/m);
  assert.match(output, /^launchctl:kickstart -k gui\/502\/test\.bridge$/m);
  assert.match(output, /^status$/m);
  assert.doesNotMatch(output, /^unexpected-stop$/m);
  assert.doesNotMatch(output, /^unexpected-start$/m);
  assert.doesNotMatch(output, /^launchctl:bootout /m);
  assert.doesNotMatch(output, /^launchctl:bootstrap /m);
});

test('macos bridge restart bootstraps unloaded launchd services before kickstart', async () => {
  const output = await runBash(
    `source "${scriptPath}"
detect_installed_service_mode() { echo agent; }
has_multiple_installed_service_modes() { return 1; }
service_mode_label() { echo LaunchAgent; }
normalize_service_plist_permissions() { echo "normalize:$1"; }
service_is_bootstrapped() { return 1; }
service_domain_for_mode() { echo "gui/502"; }
service_plist_path_for_mode() { echo "/tmp/test.bridge.plist"; }
service_target_for_mode() { echo "gui/502/test.bridge"; }
launchctl() { echo "launchctl:$*"; }
sleep() { :; }
run_status() { echo status; }
run_start_manual() { echo unexpected-manual; return 99; }
run_restart`,
    {},
  );

  assert.match(output, /^normalize:agent$/m);
  assert.match(output, /^launchctl:bootstrap gui\/502 \/tmp\/test\.bridge\.plist$/m);
  assert.match(output, /^launchctl:kickstart -k gui\/502\/test\.bridge$/m);
  assert.match(output, /^status$/m);
  assert.doesNotMatch(output, /^unexpected-manual$/m);
});

test('macos bridge restart keeps stop-then-start behavior when no launchd service is installed', async () => {
  const output = await runBash(
    `source "${scriptPath}"
detect_installed_service_mode() { return 1; }
run_stop() { echo stop; }
run_start() { echo start; }
run_restart`,
    {},
  );

  assert.match(output, /^stop$/m);
  assert.match(output, /^start$/m);
});
