# App-Server Parity And Progress Design

**Date:** 2026-03-21

## Goal
Make the Discord bridge behave much closer to official Codex CLI app-server execution for normal question-answering, while restoring step-oriented live progress instead of token-by-token timeline spam.

## Problem Statement
The current app-server integration improves protocol alignment, but two gaps still materially hurt user experience and answer fidelity:

1. The bridge does not execute app-server with the same startup context as a direct CLI invocation from the bound workspace.
2. The bridge treats app-server delta text as timeline steps, so Discord progress updates show repeated growing message fragments instead of meaningful process items.

## Non-Goals
- Do not chase byte-for-byte identical model output. That is not realistic even in the official CLI.
- Do not remove bridge features such as attachments, guidance, fallback, or progress cards.
- Do not redesign the overall driver abstraction.

## Root Causes

### 1. Result parity is limited by bridge-side input and execution differences
- `CodexAppServerClient.spawnAppServer()` starts the child with `cwd: process.cwd()` and `PWD=process.cwd()`, not the bound workspace path.
- Guidance requests intentionally wrap the user prompt in a bridge-authored system note.
- Attachment-bearing prompts append a bridge-authored attachment note to the text input.
- The bridge forces `features.multi_agent=true` unless explicitly overridden.
- The resilient driver falls back to legacy mode before engagement in some error cases by design.

### 2. Progress rendering regressed because delta events are modeled as semantic events
- `agent.message.delta` is accumulated and emitted through `onAgentMessage()` on every growth step.
- `reasoning.summary.delta` is emitted through `onReasoning()` on every growth step.
- Discord runtime hooks append both to `timeline`, which is intended for step-level process items.
- Timeline de-duplication only rejects exact duplicates, so growing deltas always produce new entries.

## Desired Behavior

### Result parity
- Normal text questions should run app-server from the bound workspace context.
- The prompt that reaches Codex should stay as close as possible to the user-visible request, except where bridge features require additional structure.
- Guidance and attachments should remain supported, but the bridge should avoid unnecessary divergence in the common path.
- Fallback should remain, but only as an explicit recovery path, not the default experience.

### Live progress
- Timeline should contain process items such as:
  - session established
  - analyzing request
  - plan updated
  - command started
  - command completed
  - subagent activity
  - fallback/retry/failure notices
- Delta text should update summary state, not append new process items.
- The final reply should still use the latest completed agent message.

## Design

### A. Align app-server startup context with the bound workspace
- Extend app-server startup so the child process starts with:
  - `cwd` set to the binding workspace path
  - `PWD` set to the binding workspace path
- Keep per-thread and per-turn `cwd` fields unchanged.
- Preserve the current transport selection logic and timeout handling.

### B. Preserve bridge features while reducing answer-path divergence
- Keep normal prompts unwrapped.
- Keep guidance wrapping because it encodes a real bridge behavior change: “prioritize latest instruction, then resume original task”.
- Keep attachment notes because non-image files otherwise become undiscoverable to Codex.
- Do not change the default multi-agent config in this pass. It affects parity, but changing it now would broaden scope and risk behavior regressions outside the reported issue.

### C. Separate streaming state from process timeline
- In `CodexAppServerRunner`:
  - continue buffering `agent.message.delta` by item id
  - continue buffering `reasoning.summary.delta` by item id
  - emit dedicated hooks for streaming summary/message updates instead of reusing semantic “completed message” hooks
- In `DiscordCodexBridge`:
  - update `latestActivity`, `reasoningSummaries`, and the stored `agentMessages` preview using streaming hooks
  - do not push timeline entries for every delta
  - only push timeline entries for semantic transitions already represented by commands, plans, collab tools, activity, fallback, retry, and completion
- Keep throttled view refreshes so Discord edit volume remains bounded.

### D. Keep final reply behavior stable
- `result.agentMessages.at(-1)` should still resolve to the final complete message that best represents the answer.
- App-server streaming updates should not make the final reply accidentally select an intermediate partial text.

## Test Strategy

### Unit tests
- Verify app-server startup uses the binding workspace for `cwd`/`PWD`.
- Verify agent-message delta streaming does not produce multiple semantic final messages.
- Verify reasoning delta streaming updates summary state without creating repeated process items.

### End-to-end tests
- Add a live progress regression test proving the progress card contains command/plan/subagent/process steps but does not contain repeated `💬` delta spam.
- Preserve existing fallback and timeout tests.

## Risks
- App-server startup currently happens before a thread exists, so startup context must be passed in safely without breaking multi-conversation reuse assumptions.
- Changing message event semantics can silently break final reply selection if the result model is not adjusted carefully.
- Some existing tests assume delta text appears as analysis/progress. Those assertions may need to shift from timeline entries to summary fields.

## Recommendation
Implement this in two tightly scoped TDD tasks:
1. app-server startup context parity
2. streaming-vs-semantic progress separation
