import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { TranscriptEvent, TranscriptEventRole, TranscriptEventSource } from './types.js';

export class TranscriptStore {
  private readonly transcriptsDir: string;

  constructor(dataDir: string) {
    this.transcriptsDir = path.join(dataDir, 'transcripts');
  }

  async appendEvent(
    conversationId: string,
    event: {
      codexThreadId?: string | undefined;
      role: TranscriptEventRole;
      source: TranscriptEventSource;
      content: string;
      createdAt?: string | undefined;
    },
  ): Promise<TranscriptEvent> {
    const nextEvent: TranscriptEvent = {
      id: randomUUID(),
      conversationId,
      codexThreadId: event.codexThreadId,
      role: event.role,
      source: event.source,
      content: event.content,
      createdAt: event.createdAt ?? new Date().toISOString(),
    };

    await fs.mkdir(this.transcriptsDir, { recursive: true });
    await fs.appendFile(this.getTranscriptPath(conversationId), `${JSON.stringify(nextEvent)}\n`, 'utf8');
    return nextEvent;
  }

  async listEvents(conversationId: string): Promise<TranscriptEvent[]> {
    const transcriptPath = this.getTranscriptPath(conversationId);

    try {
      const raw = await fs.readFile(transcriptPath, 'utf8');
      return raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TranscriptEvent);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  getTranscriptPath(conversationId: string): string {
    return path.join(this.transcriptsDir, `${conversationId}.jsonl`);
  }
}
