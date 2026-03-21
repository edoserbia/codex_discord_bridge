# Findings and Decisions

## Requirements
- Interrupted tasks should recover without requiring the user to resend the prompt.
- Discord must show that recovery was triggered and what the bridge is doing next.
- `!cancel` must still stop the current task, including a recovery attempt.
- Queued prompts should remain ordered normally, but recovery work for the interrupted task should run before ordinary queued prompts.
- There should be a queue command that can take an already queued prompt and insert it into the currently running task flow.

## Initial Findings
- `runtime.queue` and `runtime.activeRun` only live in memory inside `DiscordCodexBridge`, so bridge restarts currently lose all pending and in-flight work.
- The persistent store keeps bindings, sessions, and autopilot state, but not runtime queues or active run snapshots.
- Existing retry logic already gives the current interrupted task priority over later queued prompts, but it is implemented as an internal while-loop and is not persisted across restart.
- Existing `!queue` is read-only; there is no command to reorder or inject a queued prompt into the current run.
- Existing guidance insertion logic already knows how to interrupt a running task and enqueue a guidance item at the front, which can be reused for queue insertion semantics.

## Implemented Findings
- Runtime snapshots are now persisted in `state.json` under `runtimes`, including queued prompt tasks and the currently active run.
- Bridge startup now rehydrates persisted runtimes, converts any recoverable in-flight run into a recovery task, posts a Discord recovery notice, and resumes queue processing automatically.
- Recovery prompt generation now distinguishes between transport-only interruptions and material progress. Stderr-only failures retry the original prompt; command/todo/reasoning/subagent evidence triggers a continue-from-state recovery prompt.
- `!queue insert <n>` now turns the selected queued item into the next guidance-style task for the active run.
- Guidance and queue insertion now use task-scoped waits so they cannot accidentally cancel the next run while the current run is still attaching.

## Residual Risks
- Recovery still depends on the persisted runtime snapshot being writable; if the bridge loses access to its data directory entirely, restart recovery cannot be reconstructed.
- If a run is interrupted before a Codex thread id exists, the follow-up recovery/guidance step may need to start a fresh Codex session instead of reusing a prior one.
