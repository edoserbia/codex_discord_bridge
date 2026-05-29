import type { EngineName, TranscriptEvent } from './types.js';

export interface EngineContextPromptOptions {
  currentPrompt: string;
  previousEngine: EngineName | undefined;
  currentEngine: EngineName;
  events: TranscriptEvent[];
  maxEvents?: number | undefined;
  maxCharacters?: number | undefined;
}

export interface EngineContextDecisionInput {
  currentEngine: EngineName;
  lastEngine: EngineName | undefined;
  hasNativeSession: boolean;
  transcriptEventCount: number;
}

export function shouldInjectEngineContext(input: EngineContextDecisionInput): boolean {
  if (input.transcriptEventCount <= 0) {
    return false;
  }

  return input.lastEngine !== undefined && input.lastEngine !== input.currentEngine;
}

export function buildEngineContextPrompt(options: EngineContextPromptOptions): string {
  const maxEvents = options.maxEvents ?? 12;
  const maxCharacters = options.maxCharacters ?? 6_000;
  const transcriptLines = buildBoundedTranscriptLines(options.events, maxEvents, maxCharacters);

  return [
    '[Bridge cross-engine context]',
    'This is the same Discord project conversation. Continue from the recent transcript.',
    `Previous engine: ${options.previousEngine ?? 'none'}`,
    `Current engine: ${options.currentEngine}`,
    'Recent transcript:',
    transcriptLines.length > 0 ? transcriptLines.join('\n') : '- none',
    '',
    '[Current user request]',
    options.currentPrompt,
  ].join('\n');
}

function buildBoundedTranscriptLines(events: TranscriptEvent[], maxEvents: number, maxCharacters: number): string[] {
  const candidates = events
    .filter((event) => event.content.trim())
    .slice(-Math.max(0, maxEvents))
    .map((event) => `- ${event.role}: ${singleLine(event.content)}`);

  const selected: string[] = [];
  let remaining = Math.max(0, maxCharacters);

  for (const line of candidates.slice().reverse()) {
    if (remaining <= 0) {
      break;
    }

    const next = line.length <= remaining ? line : `${line.slice(0, Math.max(0, remaining - 1)).trimEnd()}…`;
    if (next.trim()) {
      selected.push(next);
      remaining -= next.length + 1;
    }
  }

  return selected.reverse();
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
