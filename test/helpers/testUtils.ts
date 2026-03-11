import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function cleanupDir(targetPath: string): Promise<void> {
  await rm(targetPath, { recursive: true, force: true });
}

export async function createWorkspace(rootDir: string): Promise<string> {
  const workspace = path.join(rootDir, 'workspace');
  await mkdir(workspace, { recursive: true });
  return workspace;
}

export async function waitFor(assertion: () => boolean | Promise<boolean>, timeoutMs = 10_000, intervalMs = 50): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await assertion()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

export async function startStaticServer(files: Record<string, { body: string | Buffer; contentType: string }>): Promise<{
  origin: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const entry = files[url.pathname];

    if (!entry) {
      response.writeHead(404);
      response.end('not found');
      return;
    }

    response.writeHead(200, { 'content-type': entry.contentType });
    response.end(entry.body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('failed to get address');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
