import { promises as fs } from 'node:fs';
import path from 'node:path';

import { getAutopilotDefaultIntervalMs, normalizeAutopilotParallelism } from './autopilot.js';
import type {
  AutopilotProjectState,
  AutopilotServiceState,
  ChannelRuntime,
  ChannelBinding,
  ConversationSessionState,
  PersistedState,
} from './types.js';

export class JsonStateStore {
  private state: PersistedState = {
    bindings: {},
    sessions: {},
    runtimes: {},
    autopilotServices: {},
    autopilotProjects: {},
  };
  private saveChain: Promise<void> = Promise.resolve();

  constructor(private readonly stateFilePath: string) {}

  async load(): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.stateFilePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedState;
      const defaultIntervalMs = getAutopilotDefaultIntervalMs();
      this.state = {
        bindings: parsed.bindings ?? {},
        sessions: Object.fromEntries(
          Object.entries(parsed.sessions ?? {}).map(([conversationId, session]) => [
            conversationId,
            {
              ...session,
              driver: session.driver ?? (session.codexThreadId ? 'legacy-exec' : undefined),
            } satisfies ConversationSessionState,
          ]),
        ),
        runtimes: Object.fromEntries(
          Object.entries(parsed.runtimes ?? {}).map(([conversationId, runtime]) => [
            conversationId,
            {
              conversationId,
              queue: Array.isArray(runtime.queue) ? runtime.queue : [],
              activeRun: runtime.activeRun ?? undefined,
            } satisfies ChannelRuntime,
          ]),
        ),
        autopilotServices: Object.fromEntries(
          Object.entries(parsed.autopilotServices ?? {}).map(([guildId, service]) => [
            guildId,
            {
              ...service,
              parallelism: normalizeAutopilotParallelism(service.parallelism),
            } satisfies AutopilotServiceState,
          ]),
        ),
        autopilotProjects: Object.fromEntries(
          Object.entries(parsed.autopilotProjects ?? {}).map(([bindingChannelId, project]) => [
            bindingChannelId,
            {
              ...project,
              enabled: project.enabled ?? false,
              intervalMs: Number.isFinite(project.intervalMs) && project.intervalMs > 0
                ? project.intervalMs
                : defaultIntervalMs,
            } satisfies AutopilotProjectState,
          ]),
        ),
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
    delete this.state.autopilotProjects[channelId];

    for (const [conversationId, session] of Object.entries(this.state.sessions)) {
      if (session.bindingChannelId === channelId) {
        delete this.state.sessions[conversationId];
        delete this.state.runtimes[conversationId];
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
      ConversationSessionState[keyof Omit<ConversationSessionState, 'conversationId' | 'bindingChannelId' | 'updatedAt'>] | undefined,
    ]>) {
      if (value === undefined) {
        delete next[key];
      } else {
        next[key] = value as never;
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
    delete this.state.runtimes[conversationId];
    await this.save();
  }

  getRuntimeState(conversationId: string): ChannelRuntime | undefined {
    const runtime = this.state.runtimes[conversationId];
    return runtime ? structuredClone(runtime) : undefined;
  }

  listRuntimeStates(bindingChannelId?: string): ChannelRuntime[] {
    return Object.entries(this.state.runtimes)
      .filter(([conversationId, runtime]) => {
        if (!bindingChannelId) {
          return true;
        }

        return this.getRuntimeBindingChannelId(conversationId, runtime) === bindingChannelId;
      })
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, runtime]) => structuredClone(runtime));
  }

  async upsertRuntimeState(runtime: ChannelRuntime): Promise<ChannelRuntime> {
    this.state.runtimes[runtime.conversationId] = structuredClone(runtime);
    await this.save();
    return structuredClone(runtime);
  }

  async removeRuntimeState(conversationId: string): Promise<void> {
    delete this.state.runtimes[conversationId];
    await this.save();
  }

  getAutopilotService(guildId: string): AutopilotServiceState | undefined {
    const service = this.state.autopilotServices[guildId];
    return service ? structuredClone(service) : undefined;
  }

  listAutopilotServices(): AutopilotServiceState[] {
    return Object.values(this.state.autopilotServices)
      .sort((left, right) => left.guildId.localeCompare(right.guildId))
      .map((service) => structuredClone(service));
  }

  async upsertAutopilotService(service: AutopilotServiceState): Promise<AutopilotServiceState> {
    this.state.autopilotServices[service.guildId] = structuredClone(service);
    await this.save();
    return structuredClone(service);
  }

  getAutopilotProject(bindingChannelId: string): AutopilotProjectState | undefined {
    const project = this.state.autopilotProjects[bindingChannelId];
    return project ? structuredClone(project) : undefined;
  }

  listAutopilotProjects(guildId?: string): AutopilotProjectState[] {
    return Object.values(this.state.autopilotProjects)
      .filter((project) => !guildId || project.guildId === guildId)
      .sort((left, right) => left.bindingChannelId.localeCompare(right.bindingChannelId))
      .map((project) => structuredClone(project));
  }

  async upsertAutopilotProject(project: AutopilotProjectState): Promise<AutopilotProjectState> {
    this.state.autopilotProjects[project.bindingChannelId] = structuredClone(project);
    await this.save();
    return structuredClone(project);
  }

  async clearAutopilotGuild(guildId: string): Promise<void> {
    for (const [bindingChannelId, project] of Object.entries(this.state.autopilotProjects)) {
      if (project.guildId !== guildId) {
        continue;
      }

      this.state.autopilotProjects[bindingChannelId] = this.buildClearedAutopilotProject(project);
    }

    await this.save();
  }

  async clearAutopilotProject(bindingChannelId: string): Promise<AutopilotProjectState | undefined> {
    const project = this.state.autopilotProjects[bindingChannelId];

    if (!project) {
      return undefined;
    }

    const nextProject = this.buildClearedAutopilotProject(project);
    this.state.autopilotProjects[bindingChannelId] = nextProject;
    await this.save();
    return structuredClone(nextProject);
  }

  async clearAutopilotAll(): Promise<void> {
    for (const [bindingChannelId, project] of Object.entries(this.state.autopilotProjects)) {
      this.state.autopilotProjects[bindingChannelId] = this.buildClearedAutopilotProject(project);
    }

    await this.save();
  }

  private buildClearedAutopilotProject(project: AutopilotProjectState): AutopilotProjectState {
    const serviceEnabled = this.state.autopilotServices[project.guildId]?.enabled ?? false;

    return {
      ...project,
      board: [],
      status: project.status === 'running'
        ? 'running'
        : serviceEnabled && project.enabled
          ? 'idle'
          : 'paused',
      currentGoal: undefined,
      currentRunStartedAt: undefined,
      lastActivityAt: undefined,
      lastActivityText: undefined,
      lastResultStatus: undefined,
      lastGoal: undefined,
      lastSummary: undefined,
      nextSuggestedWork: undefined,
    };
  }

  private getRuntimeBindingChannelId(conversationId: string, runtime: ChannelRuntime): string | undefined {
    return runtime.activeRun?.task.bindingChannelId
      ?? runtime.queue.at(0)?.bindingChannelId
      ?? this.state.sessions[conversationId]?.bindingChannelId;
  }

  private async save(): Promise<void> {
    const payload = `${JSON.stringify(this.state, null, 2)}\n`;
    const runSave = async (): Promise<void> => {
      const tempFilePath = `${this.stateFilePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });
      await fs.writeFile(tempFilePath, payload, 'utf8');
      await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });
      await fs.rename(tempFilePath, this.stateFilePath);
    };

    const nextSave = this.saveChain.then(runSave, runSave);
    this.saveChain = nextSave.then(() => undefined, () => undefined);
    await nextSave;
  }
}
