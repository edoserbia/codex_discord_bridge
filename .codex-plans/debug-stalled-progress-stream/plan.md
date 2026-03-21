# Task: Debug stalled progress stream and slow character-by-character activity updates

## Goal
Restore Codex CLI-like progress rendering in Discord by identifying and fixing why progress stalls on the analysis state, why latest activity streams one character at a time, and why command/activity throughput is slower than direct CLI usage.

## Current Phase
Completed

## Phases

### Phase 1: Requirements and Discovery
- [x] Reproduce the stalled-progress behavior locally
- [x] Inspect progress/event pipeline across app-server, runner, and Discord rendering
- [x] Record findings and a root-cause hypothesis
- **Status:** completed

### Phase 2: TDD Design
- [x] Add failing coverage for stalled and character-streamed progress behavior
- [x] Confirm the tests fail for the right reason
- [x] Decide the minimal fix
- **Status:** completed

### Phase 3: Implementation
- [x] Implement the root-cause fix
- [x] Preserve existing guide, plan, subagent, and mode behavior
- [x] Validate incrementally
- **Status:** completed

### Phase 4: Verification
- [x] Run targeted tests
- [x] Run full verification and, if needed, restart the local service
- [x] Confirm the runtime behavior matches expectations
- **Status:** completed

### Phase 5: Delivery
- [x] Commit and push any new changes
- [x] Report outcome and remaining limits
- **Status:** completed

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Debug from reproduction and event tracing before changing rendering code | The symptom spans multiple layers and a cosmetic fix could hide a protocol or buffering bug |
| Keep runtime state mutation synchronous but make Discord refresh scheduling non-blocking | We need to preserve event order while removing UI/network backpressure from the app-server event path |
| Keep streamed reasoning/answer text visible in dedicated card sections instead of `最新活动` | Restores useful visibility without going back to character-by-character latest-activity updates |
| Reduce the runtime refresh throttle to 300ms and keep more timeline items in the progress card | Preserves intermediate plan/activity states while remaining rate-limited and materially closer to Codex CLI cadence |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| `node --test --test-name-pattern=...` still executed unrelated tests in this environment | 1 | Use a direct local reproduction script plus a committed regression test to validate the failure mode before the production fix |
