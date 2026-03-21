# Task: Fix app-server full-permission config compatibility for codex-cli 0.116.0

## Goal
Keep the user's global Codex configuration fully permissive while restoring reliable `app-server` startup for the Discord bridge and documenting the exact Codex CLI compatibility expectations.

## Current Phase
Phase 4

## Phases

### Phase 1: Root Cause Confirmation
- [x] Reproduce the production failure from Discord logs
- [x] Confirm whether the failure comes from bridge binding state or global Codex config
- [x] Verify the current Codex CLI version and the accepted full-permission config shape
- **Status:** completed

### Phase 2: TDD and Implementation
- [x] Add failing tests for normalized compatibility diagnostics
- [x] Implement the bridge-side diagnostic improvement
- [x] Update docs with the validated Codex CLI version and config caveat
- **Status:** completed

### Phase 3: Operational Remediation
- [x] Update `~/.codex/config.toml` to the compatible full-permission config
- [x] Restart the local bridge service
- [x] Verify `app-server` initializes without falling back
- **Status:** completed

### Phase 4: Verification and Delivery
- [x] Run targeted tests and build/check
- [x] Record verification evidence
- [ ] Commit, push, and summarize the final operational state
- **Status:** in_progress

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Preserve global full permissions instead of downgrading to workspace-write | The user explicitly wants system-wide access, including files outside the bound project |
| Remove obsolete `default_permissions = "full"` usage instead of adding a restrictive bridge sandbox | `codex-cli 0.116.0` already supports full access via `sandbox_mode = "danger-full-access"` and `approval_policy = "never"` |
| Improve fallback diagnostics for this known compatibility fault | Raw stderr currently exposes ANSI noise and does not tell the user what to change |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| `app-server initialize timed out after 10000ms` with `Permissions profile \`full\` does not define any recognized filesystem entries` | 1 | Root-caused to `~/.codex/config.toml`, not the bridge binding; continue with config remediation and clearer diagnostics |
