import { randomUUID } from 'node:crypto';

export class FakePermissions {
  constructor(private readonly admin: boolean) {}

  has(): boolean {
    return this.admin;
  }
}

export class FakeChannel {
  public readonly sent: FakeMessage[] = [];
  public typingCount = 0;
  public archived = false;
  private readonly store = new Map<string, FakeMessage>();
  private registry?: Map<string, FakeChannel>;

  public readonly messages = {
    fetch: async (messageId: string): Promise<any> => {
      const message = this.store.get(messageId);

      if (!message) {
        throw new Error(`Message ${messageId} not found`);
      }

      return message as any;
    },
  };

  public readonly threads = {
    create: async (options: { name: string }): Promise<any> => {
      const channel = new FakeChannel(
        `thread-${randomUUID().slice(0, 8)}`,
        this.guildId,
        this.id,
        true,
        this.registry,
      );
      this.registry?.set(channel.id, channel);
      return channel as any;
    },
  };

  constructor(
    public readonly id: string,
    public readonly guildId: string,
    public readonly parentId?: string,
    private readonly thread = false,
  ) {}

  isThread(): boolean {
    return this.thread;
  }

  async send(content: string): Promise<any> {
    const message = new FakeMessage({
      id: randomUUID(),
      content,
      channel: this,
      guildId: this.guildId,
      author: { id: 'bot', username: 'bot', bot: true },
      admin: true,
    });
    this.store.set(message.id, message);
    this.sent.push(message);
    return message as any;
  }

  async sendTyping(): Promise<void> {
    this.typingCount += 1;
  }

  async setArchived(archived: boolean): Promise<void> {
    this.archived = archived;
  }

  attachRegistry(registry: Map<string, FakeChannel>): void {
    this.registry = registry;
  }

  getMessage(id: string): FakeMessage | undefined {
    return this.store.get(id);
  }

  addExistingMessage(message: FakeMessage): void {
    this.store.set(message.id, message);
  }
}

interface FakeMessageInit {
  id?: string;
  content: string;
  channel: FakeChannel;
  guildId: string;
  author: { id: string; username: string; bot: boolean };
  admin: boolean;
  attachments?: Map<string, any>;
}

export class FakeMessage {
  public readonly id: string;
  public content: string;
  public readonly channel: FakeChannel;
  public readonly guild = { id: 'guild-1' };
  public readonly guildId: string;
  public readonly channelId: string;
  public readonly author: { id: string; username: string; bot: boolean };
  public readonly member: { permissions: FakePermissions };
  public readonly attachments: Map<string, any>;
  public readonly reactions: string[] = [];
  public pinned = false;

  constructor(init: FakeMessageInit) {
    this.id = init.id ?? randomUUID();
    this.content = init.content;
    this.channel = init.channel;
    this.guildId = init.guildId;
    this.channelId = init.channel.id;
    this.author = init.author;
    this.member = { permissions: new FakePermissions(init.admin) };
    this.attachments = init.attachments ?? new Map();
    init.channel.addExistingMessage(this);
  }

  async reply(content: string): Promise<any> {
    return this.channel.send(content);
  }

  async react(emoji: string): Promise<void> {
    this.reactions.push(emoji);
  }

  async edit(content: string): Promise<any> {
    this.content = content;
    return this as any;
  }

  async pin(): Promise<any> {
    this.pinned = true;
    return this as any;
  }
}

export function createUserMessage(
  channel: FakeChannel,
  content: string,
  options: {
    userId?: string;
    username?: string;
    admin?: boolean;
    attachments?: Map<string, any>;
  } = {},
): FakeMessage {
  return new FakeMessage({
    content,
    channel,
    guildId: channel.guildId,
    author: {
      id: options.userId ?? 'user-1',
      username: options.username ?? 'alice',
      bot: false,
    },
    admin: options.admin ?? true,
    attachments: options.attachments,
  });
}
