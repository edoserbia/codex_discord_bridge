# Automatic Retry Recovery Design

**Date:** 2026-03-29

## Goal

Automatically retry any non-user-initiated Codex failure up to three total attempts, and reuse the existing recovery prompt style so retries continue from the current workspace state instead of restarting from scratch whenever there is enough runtime context to do so safely.

## Constraints

- User-initiated interruptions must not auto-retry. This includes `!cancel`, `!reset`, `!unbind`, and guidance-driven interruption.
- The retry limit must remain bounded at three total attempts to avoid infinite loops and repeated side effects.
- Retry behavior should reuse the current recovery prompt and task metadata instead of introducing a second recovery system.
- Existing session-reset rules for stale sessions and repeated transient failures must remain intact.
- The change should be minimal and should not alter queue ordering outside the currently running task.

## Chosen Approach

- Keep the existing retry loop in [discordBot.ts](/path/to/codex_tunning/src/discordBot.ts) as the single retry mechanism.
- Broaden the retry trigger from "diagnosed as retryable" to "failed for any non-user reason and attempts remain".
- Continue using `buildRecoveryTask()` and `buildRecoveryPrompt()` for retry attempts, so retries can select between:
  - `continue-from-state` when the interrupted run has command output, reasoning, plan progress, subagent state, or other evidence that work already happened.
  - `retry-original` when there is no useful interrupted-state context to carry forward.
- Keep `diagnoseCodexFailure()` as the source of retry classification details, but use its kind mainly to decide how the next retry should resume:
  - `stale-session`: immediately drop the saved thread before retrying.
  - `transient`: first retry can continue on the same thread, later retry resets the thread.
  - `diagnostic` and `unexpected-empty-exit`: retry as recovery too, but still stay bounded to three total attempts.

## Behavioral Details

- First failed attempt:
  - If the failure was not user-initiated, convert the active task into a recovery task.
  - Announce the retry as automatic recovery.
  - Prefer `continue-from-state` when interrupted runtime state exists.
- Second failed attempt:
  - Retry one more time, still using recovery-task semantics.
  - If prior diagnostics indicate the session may be poisoned, clear the stored Codex thread before starting the final attempt.
- Third failed attempt:
  - Stop retrying and surface the failure normally.

## Non-Goals

- No infinite retry mode.
- No retry for operator-directed cancellation or intentional workflow interruption.
- No new prompt template family beyond the existing recovery prompt structure.
- No persistence changes beyond what the current recovery-task model already stores.

## Testing

- Add a regression test showing that a generic non-user Codex failure with diagnostic stderr is retried automatically and eventually succeeds.
- Add a regression test showing that retry attempts use recovery semantics instead of resending a plain original prompt when interrupted-state context exists.
- Keep existing tests proving that user-triggered interruption paths do not auto-retry.
- Verify targeted bridge tests plus TypeScript typecheck after the change.
