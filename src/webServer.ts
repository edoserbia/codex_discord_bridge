import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { AppConfig } from './config.js';
import type { BindCommandOptions } from './commandParser.js';

import { DiscordCodexBridge } from './discordBot.js';
import { formatDashboardHtml } from './formatters.js';
import { buildWebAccessUrls } from './webAccess.js';

const AUTH_COOKIE_NAME = 'codex_bridge_auth';

export class AdminWebServer {
  private server: http.Server | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly bridge: DiscordCodexBridge,
  ) {}

  async start(): Promise<void> {
    if (!this.config.web.enabled) {
      return;
    }

    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[web-server] unhandled request error: ${message}`);
        if (!response.headersSent) {
          this.sendText(response, 500, message);
        } else {
          response.end();
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.web.port, this.config.web.bind, () => resolve());
    });

    console.log(`Web admin panel listening at ${this.getOrigin()}`);
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server!.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = undefined;
  }

  getOrigin(): string {
    return this.getOriginCandidates()[0]?.origin ?? `http://127.0.0.1:${this.config.web.port}`;
  }

  getAccessUrls(): ReturnType<typeof buildWebAccessUrls> {
    return buildWebAccessUrls(this.config.web, this.getServerAddress());
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

      if (this.handleBrowserAuthBootstrap(url, response)) {
        return;
      }

      if (!this.isAuthorized(request)) {
        response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Unauthorized');
        return;
      }

      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(formatDashboardHtml(this.bridge.getDashboardData()));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/dashboard') {
        this.sendJson(response, 200, this.bridge.getDashboardData());
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/bindings') {
        const payload = await this.readJsonBody(request) as {
          channelId?: string;
          guildId?: string;
          projectName?: string;
          workspacePath?: string;
          options?: BindCommandOptions;
        };

        if (!payload.channelId || !payload.projectName || !payload.workspacePath) {
          this.sendText(response, 400, 'channelId, projectName, workspacePath 都是必填项。');
          return;
        }

        const binding = await this.bridge.bindChannel({
          channelId: payload.channelId,
          guildId: payload.guildId,
          projectName: payload.projectName,
          workspacePath: payload.workspacePath,
          options: payload.options,
        });

        this.sendJson(response, 200, binding);
        return;
      }

      const bindingDeleteMatch = request.method === 'DELETE'
        ? url.pathname.match(/^\/api\/bindings\/([^/]+)$/)
        : null;

      if (bindingDeleteMatch) {
        const binding = await this.bridge.unbindChannel(decodeURIComponent(bindingDeleteMatch[1]!));

        if (!binding) {
          this.sendText(response, 404, 'Binding not found');
          return;
        }

        this.sendJson(response, 200, binding);
        return;
      }

      const resetMatch = request.method === 'POST'
        ? url.pathname.match(/^\/api\/conversations\/([^/]+)\/reset$/)
        : null;

      if (resetMatch) {
        const session = await this.bridge.resetConversation(decodeURIComponent(resetMatch[1]!));
        this.sendJson(response, 200, session);
        return;
      }

      this.sendText(response, 404, 'Not Found');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendText(response, 500, message);
    }
  }

  private handleBrowserAuthBootstrap(url: URL, response: ServerResponse): boolean {
    if (!this.config.web.authToken || !url.searchParams.has('token')) {
      return false;
    }

    if (url.searchParams.get('token') !== this.config.web.authToken) {
      response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Unauthorized');
      return true;
    }

    const redirectUrl = new URL(url.pathname || '/', url);
    for (const [key, value] of url.searchParams.entries()) {
      if (key !== 'token') {
        redirectUrl.searchParams.append(key, value);
      }
    }

    response.writeHead(302, {
      location: `${redirectUrl.pathname}${redirectUrl.search}`,
      'set-cookie': this.buildAuthCookie(this.config.web.authToken),
    });
    response.end();
    return true;
  }

  private isAuthorized(request: IncomingMessage): boolean {
    if (!this.config.web.authToken) {
      return true;
    }

    const header = request.headers.authorization;
    if (header === `Bearer ${this.config.web.authToken}`) {
      return true;
    }

    const cookie = this.parseCookies(request.headers.cookie).get(AUTH_COOKIE_NAME);
    return cookie === this.config.web.authToken;
  }

  private parseCookies(headerValue: string | undefined): Map<string, string> {
    const cookies = new Map<string, string>();

    if (!headerValue) {
      return cookies;
    }

    for (const part of headerValue.split(';')) {
      const [rawName, ...rawValue] = part.trim().split('=');
      if (!rawName) {
        continue;
      }

      cookies.set(rawName, rawValue.join('='));
    }

    return cookies;
  }

  private buildAuthCookie(token: string): string {
    return `${AUTH_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
  }

  private getOriginCandidates(): Array<{ origin: string }> {
    return buildWebAccessUrls({
      ...this.config.web,
      authToken: undefined,
    }, this.getServerAddress());
  }

  private getServerAddress(): AddressInfo | undefined {
    if (!this.server) {
      return {
        address: this.config.web.bind,
        family: 'IPv4',
        port: this.config.web.port,
      } as AddressInfo;
    }

    const address = this.server.address();
    if (!address || typeof address === 'string') {
      return undefined;
    }

    return address;
  }

  private async readJsonBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const raw = Buffer.concat(chunks).toString('utf8').trim();
    return raw ? JSON.parse(raw) : {};
  }

  private sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
    response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
    response.end(`${JSON.stringify(payload, null, 2)}\n`);
  }

  private sendText(response: ServerResponse, statusCode: number, body: string): void {
    response.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(body);
  }
}

export { buildWebAccessUrls };
