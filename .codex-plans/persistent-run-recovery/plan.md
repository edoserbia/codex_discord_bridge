# Task: Add persistent interrupted-task recovery with visible Discord recovery flow

## Goal
Persist queued and in-flight Discord Codex tasks so the bridge can automatically recover after process interruption, announce recovery progress in Discord, and keep recovery compatible with `!cancel`, queue ordering, and higher-priority retry attempts for the interrupted task.

## Current Phase
Phase 5

## Phases

### Phase 1: Discovery and Design
- [x] Inspect current runtime, queue, command, and persistence model
- [x] Define recovery task semantics, queue priority rules, and cancel behavior
- [x] Write design and implementation plan docs
- **Status:** completed

### Phase 2: TDD Specification
- [x] Add failing tests for restart recovery, recovery notices, cancel compatibility, and queue insertion
- [x] Verify each new behavior fails for the right reason before implementation
- **Status:** completed

### Phase 3: Implementation
- [x] Persist queued tasks and recoverable active-run snapshots
- [x] Restore recoverable work on startup and announce recovery flow in Discord
- [x] Add queue control for inserting a queued prompt into the currently running task
- [x] Keep retry/recovery higher priority than normal queued prompts without breaking `!cancel`
- **Status:** completed

### Phase 4: Verification
- [x] Run targeted and full verification
- [ ] Restart local service and confirm live runtime behavior
- [x] Document residual edge cases
- **Status:** completed

### Phase 5: Delivery
- [ ] Commit and push the changes
- [ ] Report the recovery model, queue command, and remaining limits
- **Status:** in_progress

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Treat recovery as a first-class queued task with higher priority than normal queued prompts | Recovery must be cancellable and schedulable, not a hidden in-memory side effect |
| Persist enough active-run context to build a recovery prompt after bridge restart | Process restarts currently lose all information about interrupted work |
| Keep `!cancel` authoritative over recovery attempts | User control must override automatic recovery |
| Retry using the original prompt unless the interrupted run shows material progress | Transport-only errors should not pollute the final answer with a recovery wrapper |
| Scope queue/guidance interruption waits to the active task id | Avoid cancelling the next job when the current job is still attaching |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| Retry recovery reused a wrapper prompt after transient/stale-session failures, causing the final answer to echo the recovery instructions in tests | 1 | Ignore stderr-only interruptions when deciding whether to continue from workspace state; keep the original prompt unless commands/reasoning/todos/subagents show real progress |
| `!queue insert` could cancel the newly started follow-up task instead of the interrupted task because it waited on a conversation-wide controllable job | 1 | Wait for a controllable job only while the same task id is still active, and delay the `guidance` cancellation flag until the current task has had a chance to attach |
