# Task: Debug patent_platform app-server websocket transport closed failure

## Goal
Determine why the `patent_platform` request failed with `app-server websocket transport closed`, identify whether the root cause is bridge logic, app-server transport handling, or Codex child-process/runtime failure, and implement a fix if the bridge is responsible.

## Current Phase
Completed

## Phases

### Phase 1: Requirements and Discovery
- [x] Collect logs and runtime evidence for the failing request
- [x] Inspect transport mode, binding options, and relevant code paths
- [x] Record a root-cause hypothesis
- **Status:** completed

### Phase 2: TDD Design
- [x] Add or identify a failing reproduction if the bridge is at fault
- [x] Confirm the failure mechanism
- [x] Decide the minimal safe fix
- **Status:** completed

### Phase 3: Implementation
- [x] Implement the root-cause fix if needed
- [x] Preserve app-server-first behavior and existing guide/progress semantics
- [x] Validate incrementally
- **Status:** completed

### Phase 4: Verification
- [x] Run targeted and full verification
- [x] Confirm the live service behavior after restart if code changes are made
- [x] Document residual limits if the issue is external to the bridge
- **Status:** completed

### Phase 5: Delivery
- [x] Commit and push if code changes are required
- [x] Report root cause, impact, and next steps
- **Status:** completed

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Diagnose from logs and current runtime configuration before attempting reproduction changes | The failure may be in the live Codex child/runtime rather than the bridge, so evidence needs to come first |
| Align `auto` transport with the official Codex app-server default of `stdio://` | The bridge should not introduce a websocket-only failure mode when the official CLI default is stdio |
| Preserve recent app-server child `stderr` in failure messages | Generic websocket-close diagnostics are insufficient for production debugging |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
|       | 1       |            |
