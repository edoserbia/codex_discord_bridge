# Persistent Run Recovery Design

## Goal
Allow Discord Codex tasks to survive bridge restarts and interrupted transport failures by restoring recoverable work automatically, while making recovery visible to the user and preserving manual control through `!cancel` and queue commands.

## Recommended Approach
Persist two pieces of runtime state per conversation: queued prompt tasks and a recoverable snapshot of the currently running task. On startup, rebuild in-memory runtimes from those persisted snapshots. If a task was interrupted mid-run, convert it into a recovery task placed ahead of the normal queue and announce the recovery plan in Discord before resuming execution.

This keeps the bridge aligned with user expectations:
- normal queued prompts remain FIFO
- recovery work for the interrupted task runs first
- `!cancel` still cancels the currently running work, whether normal or recovery
- the recovery path is visible in Discord rather than silent

## Recovery Semantics
- If interruption happened before meaningful task engagement, rerun the original effective prompt.
- If interruption happened after reasoning, plan updates, command execution, or other evidence of material progress, generate a recovery prompt that instructs Codex to continue from the current workspace state without repeating completed steps.
- Recovery attempts remain tied to the original message and conversation, so the final answer still lands in the same Discord context.

## Queue Semantics
- Queued user prompts remain ordinary queue items.
- Recovery attempts are explicit prompt tasks with elevated priority over ordinary queue items.
- A new queue control command should allow an admin to take a queued item and insert it into the currently running task flow by turning it into the next guidance-style item.

## Discord Visibility
- When automatic recovery is triggered, send a timestamped notice describing why recovery started.
- Update the live progress card and timeline with concrete stages such as:
  - detected interruption
  - preparing recovery task
  - continuing from current workspace state
  - reusing session or starting a new one
- Keep these notices even if the run later succeeds, so the user can tell recovery occurred.

## Testing Strategy
- Add restart-recovery e2e coverage using a persisted state file and a second bridge instance.
- Add tests for recovery notices and recovery priority over normal queue items.
- Add tests that `!cancel` cancels a recovery run and does not let it silently continue.
- Add tests for the new queue insertion command.
