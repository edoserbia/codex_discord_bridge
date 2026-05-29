import test from 'node:test';
import assert from 'node:assert/strict';

import type { TranscriptEvent } from '../src/types.js';

import { buildEngineContextPrompt, shouldInjectEngineContext } from '../src/engineContext.js';

function event(role: TranscriptEvent['role'], content: string, index: number): TranscriptEvent {
  return {
    id: `event-${index}`,
    conversationId: 'conversation-1',
    role,
    source: role === 'system' ? 'bridge' : 'discord',
    content,
    createdAt: `2026-05-28T00:00:0${index}.000Z`,
  };
}

test('engine context prompt includes bounded recent transcript when switching engines', () => {
  const prompt = buildEngineContextPrompt({
    currentPrompt: 'continue the implementation',
    previousEngine: 'codex',
    currentEngine: 'claude',
    events: [
      event('user', 'first request that should be omitted by event bound', 1),
      event('assistant', 'first answer that should be omitted by event bound', 2),
      event('user', 'recent user request', 3),
      event('assistant', 'recent assistant answer', 4),
    ],
    maxEvents: 2,
    maxCharacters: 500,
  });

  assert.match(prompt, /Bridge cross-engine context/);
  assert.match(prompt, /Previous engine: codex/);
  assert.match(prompt, /Current engine: claude/);
  assert.match(prompt, /- user: recent user request/);
  assert.match(prompt, /- assistant: recent assistant answer/);
  assert.doesNotMatch(prompt, /first request/);
  assert.match(prompt, /\[Current user request\]\ncontinue the implementation/);
});

test('engine context prompt trims transcript by character budget', () => {
  const prompt = buildEngineContextPrompt({
    currentPrompt: 'finish',
    previousEngine: 'claude',
    currentEngine: 'codex',
    events: [
      event('assistant', 'x'.repeat(200), 1),
      event('user', 'keep this important tail', 2),
    ],
    maxEvents: 4,
    maxCharacters: 120,
  });

  assert.doesNotMatch(prompt, /x{80}/);
  assert.match(prompt, /keep this important tail/);
  assert.match(prompt, /\[Current user request\]\nfinish/);
});

test('engine context injection is only needed for engine switches with transcript', () => {
  assert.equal(shouldInjectEngineContext({
    currentEngine: 'claude',
    lastEngine: 'codex',
    hasNativeSession: false,
    transcriptEventCount: 2,
  }), true);

  assert.equal(shouldInjectEngineContext({
    currentEngine: 'claude',
    lastEngine: 'claude',
    hasNativeSession: false,
    transcriptEventCount: 2,
  }), false);

  assert.equal(shouldInjectEngineContext({
    currentEngine: 'claude',
    lastEngine: 'claude',
    hasNativeSession: true,
    transcriptEventCount: 2,
  }), false);

  assert.equal(shouldInjectEngineContext({
    currentEngine: 'codex',
    lastEngine: undefined,
    hasNativeSession: false,
    transcriptEventCount: 0,
  }), false);
});
