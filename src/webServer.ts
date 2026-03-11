import http, { type IncomingMessage, type ServerResponse } from 'node:http';

import type { AppConfig } from './config.js';
import type { BindCommandOptions } from './commandParser.js';

import { DiscordCodexBridge } from './discordBot.js';
import { formatDashboardHtml } from './formatters.js';

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
      void this.handleRequest(request, response);
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
    if (!this.server) {
      return `http://${this.config.web.bind}:${this.config.web.port}`;
    }

    const address = this.server.address();

    if (!address || typeof address === 'string') {
      return `http://${this.config.web.bind}:${this.config.web.port}`;
    }

    return `http://${address.address}:${address.port}`;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!this.isAuthorized(request)) {
        response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Unauthorized');
        return;
      }

      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

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

  private isAuthorized(request: IncomingMessage): boolean {
    if (!this.config.web.authToken) {
      return true;
    }

    const header = request.headers.authorization;
    return header === `Bearer ${this.config.web.authToken}`;
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
