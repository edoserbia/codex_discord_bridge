# Task: Debug real Codex app-server stdio initialize timeout against codex-cli 0.116.0

## Goal
Restore reliable `app-server` mode by matching the real `codex app-server --listen stdio://` transport semantics used by `codex-cli 0.116.0`, then verify the bridge no longer drops into `legacy-exec` for normal startup.

## Current Phase
Completed

## Phases

### Phase 1: Root Cause Confirmation
- [x] Reproduce the timeout with the bridge's `CodexAppServerClient`
- [x] Probe the real `codex app-server` directly outside the bridge
- [x] Confirm the real stdio transport framing that yields an `initialize` response
- **Status:** completed

### Phase 2: TDD and Implementation
- [x] Add failing tests for the real stdio transport framing
- [x] Update the app-server client to speak the real stdio transport while preserving websocket support
- [x] Keep existing progress, plan, subagent, and fallback behavior intact
- **Status:** completed

### Phase 3: Verification
- [x] Re-run targeted tests and full repo verification
- [x] Reproduce successful real `app-server` startup against `codex-cli 0.116.0`
- [x] Restart the installed bridge service and verify it remains on `app-server`
- **Status:** completed

### Phase 4: Delivery
- [x] Commit and push the fix
- [x] Summarize the operational state and any remaining risks
- **Status:** completed

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Debug against the real local `codex-cli 0.116.0` instead of relying on fake fixtures | The fake fixtures already passed while production still timed out |
| Treat the real stdio transport as authoritative and adjust fixtures/tests accordingly | The bridge must match the actual CLI backend behavior the user wants |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| `app-server initialize timed out after 10000ms` even after fixing permissions compatibility | 1 | Root-caused to a transport mismatch: the bridge used `Content-Length` framing while the real CLI responds to newline-delimited JSON on `stdio://` |
