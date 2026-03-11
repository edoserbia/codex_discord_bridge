import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ChannelBinding, ConversationSessionState, PersistedState } from './types.js';

export class JsonStateStore {
  private state: PersistedState = { bindings: {}, sessions: {} };

  constructor(private readonly stateFilePath: string) {}

  async load(): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.stateFilePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedState;
      this.state = {
        bindings: parsed.bindings ?? {},
        sessions: parsed.sessions ?? {},
      };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;

      if (nodeError.code !== 'ENOENT') {
        throw error;
      }

      await this.save();
    }
  }

  getBinding(channelId: string): ChannelBinding | undefined {
    const binding = this.state.bindings[channelId];
    return binding ? structuredClone(binding) : undefined;
  }

  listBindings(guildId?: string): ChannelBinding[] {
    return Object.values(this.state.bindings)
      .filter((binding) => !guildId || binding.guildId === guildId)
      .sort((left, right) => left.projectName.localeCompare(right.projectName))
      .map((binding) => structuredClone(binding));
  }

  async upsertBinding(binding: ChannelBinding): Promise<ChannelBinding> {
    this.state.bindings[binding.channelId] = structuredClone(binding);
    await this.save();
    return structuredClone(binding);
  }

  async removeBinding(channelId: string): Promise<ChannelBinding | undefined> {
    const existing = this.state.bindings[channelId];

    if (!existing) {
      return undefined;
    }

    delete this.state.bindings[channelId];

    for (const [conversationId, session] of Object.entries(this.state.sessions)) {
      if (session.bindingChannelId === channelId) {
        delete this.state.sessions[conversationId];
      }
    }

    await this.save();
    return structuredClone(existing);
  }

  getSession(conversationId: string): ConversationSessionState | undefined {
    const session = this.state.sessions[conversationId];
    return session ? structuredClone(session) : undefined;
  }

  listSessions(bindingChannelId?: string): ConversationSessionState[] {
    return Object.values(this.state.sessions)
      .filter((session) => !bindingChannelId || session.bindingChannelId === bindingChannelId)
      .sort((left, right) => left.conversationId.localeCompare(right.conversationId))
      .map((session) => structuredClone(session));
  }

  async ensureSession(bindingChannelId: string, conversationId: string): Promise<ConversationSessionState> {
    const existing = this.state.sessions[conversationId];

    if (existing) {
      return structuredClone(existing);
    }

    const created: ConversationSessionState = {
      conversationId,
      bindingChannelId,
      updatedAt: new Date().toISOString(),
    };

    this.state.sessions[conversationId] = created;
    await this.save();
    return structuredClone(created);
  }

  async updateSession(
    conversationId: string,
    patch: Partial<Omit<ConversationSessionState, 'conversationId' | 'bindingChannelId' | 'updatedAt'>>,
    bindingChannelId?: string,
  ): Promise<ConversationSessionState> {
    const existing = this.state.sessions[conversationId] ?? {
      conversationId,
      bindingChannelId: bindingChannelId ?? conversationId,
      updatedAt: new Date().toISOString(),
    } satisfies ConversationSessionState;

    const next: ConversationSessionState = {
      ...existing,
      updatedAt: new Date().toISOString(),
    };

    for (const [key, value] of Object.entries(patch) as Array<[
      keyof Omit<ConversationSessionState, 'conversationId' | 'bindingChannelId' | 'updatedAt'>,
      string | undefined,
    ]>) {
      if (value === undefined) {
        delete next[key];
      } else {
        next[key] = value;
      }
    }

    if (bindingChannelId) {
      next.bindingChannelId = bindingChannelId;
    }

    this.state.sessions[conversationId] = next;
    await this.save();
    return structuredClone(next);
  }

  async removeSession(conversationId: string): Promise<void> {
    delete this.state.sessions[conversationId];
    await this.save();
  }

  private async save(): Promise<void> {
    const tempFilePath = `${this.stateFilePath}.tmp`;
    await fs.writeFile(tempFilePath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    await fs.rename(tempFilePath, this.stateFilePath);
  }
}
