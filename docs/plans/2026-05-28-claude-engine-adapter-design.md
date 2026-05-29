# Claude Engine Adapter Design

## Goal
Add Claude CLI as a selectable execution engine beside Codex, while preserving the current Codex default path and avoiding any change to the live Bridge service during grey testing.

## Approved Behavior
Use Bridge-managed continuity. Each Discord conversation keeps separate native engine sessions:

- Codex keeps its existing Codex thread id.
- Claude keeps a Claude session id.
- Bridge keeps the shared transcript for the conversation.
- When a request switches engines, Bridge injects a compact recent transcript into the target engine prompt so the new engine can continue the same work.

This does not pretend that Codex and Claude share one native session. The continuity boundary is the Bridge transcript plus each engine's own resume id.

## User Controls
Binding sets the default engine:

```text
!bind api /path/to/project --engine claude
!bind api /path/to/project --engine codex
```

Single requests can override the default engine:

```text
!claude check the failing test
!codex implement the patch
```

Plain messages continue to use the binding default engine. Existing projects without an engine setting default to Codex.

## Architecture
Add a small engine layer without replacing the existing Codex implementation.

- Keep `CodexRunner`, `CodexAppServerRunner`, and `ResilientCodexExecutionDriver` as the Codex implementation.
- Add `ClaudeRunner` for Claude CLI.
- Add a composite execution driver that routes each task by `input.engine`.
- Extend session state with `claudeSessionId`, `lastEngine`, and per-engine native ids.
- Extend active run formatting to display engine and driver.
- Use transcript events to build a bounded cross-engine continuation prefix.

The current `codexThreadId` field remains for backward compatibility with `bridgectl session resume` and existing web APIs. Claude receives a separate `claudeSessionId`.

## Claude CLI Contract
Claude runs through:

```text
claude -p --input-format text --output-format stream-json [--resume SESSION] [--model MODEL] [--permission-mode MODE]
```

The runner parses line-delimited JSON, accepting these common shapes:

- `system/init` events with `session_id`
- `assistant` messages with text content
- `result` events with `session_id` and `result`

For tests, `test/fixtures/fake-claude.mjs` simulates these events and records args.

## Context Handoff
Before starting a task, Bridge checks:

- selected engine
- previous session `lastEngine`
- recent transcript events

If the selected engine differs from `lastEngine` and transcript exists, Bridge wraps the prompt:

```text
[Bridge cross-engine context]
This is the same Discord project conversation. Continue from the recent transcript.
Previous engine: codex
Current engine: claude
Recent transcript:
- user: ...
- assistant: ...

[Current user request]
...
```

The transcript excerpt is bounded by event count and character count to keep prompts predictable. Same-engine runs do not receive this wrapper; they rely on the native engine session when available, and reset/new-session semantics stay clean.

## Grey Testing
All work happens in `.worktrees/claude-engine-adapter` on branch `feature/claude-engine-adapter`. Tests use fake Claude/Codex CLIs and temp data directories. The running local Bridge service in the repository root is not restarted or modified.
