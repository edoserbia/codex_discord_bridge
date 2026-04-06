# Session Resume and Transcript Sync Design

**Date:** 2026-04-06

**Goal:** Let operators recover the active Codex conversation from `!status`, continue it locally through the bridge, and keep Discord as a complete transcript for both Discord-originated and local-resume turns.

## Problem

Today the bridge exposes only a status-oriented view of the current Codex session:

- `!status` shows a shortened session identifier
- the local CLI cannot resume normal Codex conversations
- the Web API has no session control surface
- Discord replies are posted turn-by-turn, but there is no transcript layer that guarantees a complete conversation log

That leaves three gaps:

1. the user cannot reliably recover a live session from Discord and continue it locally
2. local continuation would be invisible to Discord if it bypassed the bridge
3. Discord does not currently preserve a complete, durable conversation history for the session

## Approved Requirements

- `!status` must show the full native `codexThreadId` as the canonical Resume ID.
- `!status` must also show a ready-to-run local command.
- Local continuation must run through the bridge so the bridge can keep Discord in sync.
- Discord must store complete assistant replies, even if user prompts are slightly simplified.
- The final operator experience must be usable directly from the current machine through `bridgectl`.

## Constraints

- Do not break the existing Discord request flow.
- Do not replace the existing per-turn reply behavior; transcript sync should be additive.
- Do not move full transcript bodies into `data/state.json`.
- Preserve current session semantics across root channels and Discord thread conversations.
- Preserve bridge restart/recovery behavior so transcript pointers survive service restarts.

## Approaches Considered

### Approach A: Status-only resume ID plus local direct Codex usage

Expose the full `codexThreadId` in `!status`, but leave local continuation to the operator calling Codex directly.

Pros:

- very small bridge change
- easy to ship

Cons:

- bridge cannot see local turns
- Discord cannot stay complete
- fails the main product goal

### Approach B: Bridge-aware local resume plus transcript layer

Expose the full `codexThreadId` in `!status`, add `bridgectl session ...` commands that route through the bridge, and add a transcript persistence/sync layer.

Pros:

- matches the desired operator workflow
- keeps bridge as the only conversation control plane
- makes Discord transcript completeness feasible

Cons:

- adds new state, API, and CLI surfaces
- moderate implementation size

### Approach C: Full event-bus redesign for all bridge interactions

Rebuild all conversation flows around a single event-sourced transport shared across Discord, Web, and CLI.

Pros:

- architecturally clean long-term

Cons:

- too large for the current need
- unnecessary delay to ship a focused solution

## Recommendation

Use **Approach B**.

The bridge should remain the sole mediator for all session continuation. `!status` becomes the recovery entrypoint, `bridgectl session ...` becomes the local operator surface, and a new transcript layer makes Discord the durable external record.

## User-Facing Design

### 1. `!status`

Add a top Resume section ahead of the existing status details:

```text
🔐 Resume
Codex Resume ID: `00000000-0000-0000-0000-000000000000`
本机继续：`bridgectl session resume 00000000-0000-0000-0000-000000000000`
来源会话：`channel-root`
```

Rules:

- show the full `codexThreadId`, not a shortened preview
- if no Codex thread exists yet, explicitly say so and tell the user to send a normal message first
- preserve the existing operational status panel below the Resume section

### 2. Local CLI

Extend `bridgectl` with:

```bash
bridgectl session status <codex-thread-id>
bridgectl session send <codex-thread-id> "message"
bridgectl session resume <codex-thread-id>
```

Behavior:

- `status` resolves the live bridge session, binding, conversation, and workspace for a resume ID
- `send` submits one bridge-aware user turn into the existing conversation
- `resume` starts a local interactive loop that sends subsequent turns through the bridge

The bridge, not the local CLI, owns the actual Codex continuation.

### 3. Discord Transcript

Keep the existing per-turn reply flow for immediacy, but add a separate transcript chain per conversation.

Transcript entries must contain:

- timestamp
- role (`user`, `assistant`, `system`)
- source (`discord`, `local-resume`, `bridge`)
- content
- associated `codexThreadId`

Rules:

- user prompts may be slightly condensed if needed
- assistant replies must be stored and mirrored completely
- long content is split across multiple Discord messages while preserving order

## Architecture

### A. Lightweight session state stays in `state.json`

Extend `ConversationSessionState` with transcript pointers, for example:

- `transcriptHeaderMessageId`
- `transcriptMessageIds`
- `lastTranscriptEventAt`

These fields are just pointers/metadata, not the full transcript itself.

### B. Full transcript persists as append-only JSONL

Store transcript events in:

```text
data/transcripts/<conversationId>.jsonl
```

Each line contains one event such as:

```json
{
  "id": "evt_123",
  "conversationId": "1489127511278358668",
  "codexThreadId": "00000000-0000-0000-0000-000000000000",
  "role": "assistant",
  "source": "local-resume",
  "content": "完整回复内容",
  "createdAt": "2026-04-06T12:34:56.000Z"
}
```

Benefits:

- append-friendly
- restart-safe
- does not bloat `state.json`

### C. New bridge session control layer

Add bridge methods that operate by `codexThreadId`:

- resolve session metadata by resume ID
- enqueue a bridge-aware user turn into the existing conversation
- bootstrap local interactive resume

This layer should be shared by the Web API and CLI.

### D. New authenticated Web API

Add session control endpoints to the existing local admin server, for example:

- `GET /api/sessions/by-codex-thread/<id>`
- `POST /api/sessions/by-codex-thread/<id>/send`
- optionally a lighter interactive bootstrap route if needed

The existing bearer-token auth model should be reused.

### E. Transcript writer

Add a bridge-side transcript writer that:

- appends JSONL events locally
- ensures/repairs the Discord transcript message chain
- posts full assistant replies to that chain
- survives Discord write failures through retry and replay

## Compatibility Strategy

- Existing sessions remain valid.
- Existing `codexThreadId` values remain the recovery key.
- Do not attempt to backfill full transcript history for past turns.
- Start transcript logging from the first new turn after deployment.
- If transcript Discord messages are missing, regenerate the visible chain from the stored transcript file.

## Testing Strategy

Use TDD across these layers:

1. `!status` formatter and command tests
2. bridge session lookup and send tests
3. Web API tests for session endpoints and auth
4. CLI tests for `session status`, `session send`, and `session resume` bootstrap behavior
5. end-to-end bridge tests proving:
   - the Resume ID appears in `!status`
   - a local-resume turn reuses the same `codexThreadId`
   - Discord transcript receives full assistant output from both Discord and local-resume turns

## Verification Requirements

Before calling the feature done:

- `npm run build`
- targeted tests for formatter, CLI, Web API, and Discord transcript sync
- full `npm run check`
- a local smoke test that confirms:
  - `bridgectl session status <id>` works
  - `bridgectl session send <id> "hello"` works
  - `bridgectl session resume <id>` starts locally and the resulting assistant reply appears in Discord transcript
