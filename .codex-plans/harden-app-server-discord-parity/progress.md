# Progress Log

## Session: 2026-03-21

### Phase 1: Requirements and Discovery
- **Status:** completed
- Actions taken:
  - Reconnected to the existing app-server parity worktree and verified the current dirty state.
  - Confirmed the user wants app-server-first execution, sticky fallback visibility, LAN web access, tokenized URLs via Discord, and preservation of `!guide`, plan updates, and subagent visibility.
  - Re-inspected `discordBot`, `formatters`, `commandParser`, `webServer`, `codexRunner`, `codexAppServerRunner`, and relevant tests.
  - Confirmed local Codex CLI is the only required backend and that `codex app-server` is the backend mode being used by the bridge.
  - Confirmed the unresolved area is not subagent support itself, but whether official Codex exposes a stable reuse/TTL configuration knob.
- Files created/modified:
  - `.codex-plans/index.md` (updated)
  - `.codex-plans/harden-app-server-discord-parity/plan.md` (created)
  - `.codex-plans/harden-app-server-discord-parity/findings.md` (created)
  - `.codex-plans/harden-app-server-discord-parity/progress.md` (created)

### Phase 2: Design and Planning
- **Status:** completed
- Actions taken:
  - Presented the recommended app-server-first hardening design to the user and got approval.
  - Wrote the design document and implementation plan under `docs/plans/`.
  - Verified the new planning artifacts exist on disk.
- Files created/modified:
  - `docs/plans/2026-03-21-app-server-hardening-design.md` (created)
  - `docs/plans/2026-03-21-app-server-hardening.md` (created)
  - `.codex-plans/harden-app-server-discord-parity/plan.md` (updated)
  - `.codex-plans/harden-app-server-discord-parity/progress.md` (updated)

### Phase 3: TDD Implementation
- **Status:** completed
- Actions taken:
  - Added failing tests for subagent nickname parsing, sticky driver rendering in progress cards, `!web` command output, LAN URL generation, and default `WEB_BIND`.
  - Verified the new tests failed for the intended missing behaviors.
  - Implemented collab nickname parsing and rendering for both legacy and app-server subagent updates.
  - Added sticky driver lines to the live progress and status surfaces.
  - Added `!web` command support plus local/LAN tokenized web URL formatting.
  - Added a shared web access URL helper and updated the web server to avoid exposing `0.0.0.0` as the user-facing origin.
  - Updated shell tooling with `web-url`, LAN-oriented defaults, and launchd-aware service status detection.
  - Re-ran targeted tests and confirmed the new regressions pass.
- Files created/modified:
  - `src/webAccess.ts` (created)
  - `src/codexRunner.ts` (updated)
  - `src/commandParser.ts` (updated)
  - `src/config.ts` (updated)
  - `src/discordBot.ts` (updated)
  - `src/formatters.ts` (updated)
  - `src/types.ts` (updated)
  - `src/webServer.ts` (updated)
  - `.env.example` (updated)
  - `scripts/macos-bridge.sh` (updated)
  - `test/codexRunner.test.ts` (updated)
  - `test/config.test.ts` (updated)
  - `test/discordBridge.e2e.test.ts` (updated)
  - `test/fixtures/fake-codex.mjs` (updated)
  - `test/fixtures/fake-codex-app-server.mjs` (updated)
  - `test/helpers/bridgeSetup.ts` (updated)
  - `test/webServer.test.ts` (updated)
  - `.codex-plans/harden-app-server-discord-parity/progress.md` (updated)

### Phase 4: Verification and Deployment
- **Status:** completed
- Actions taken:
  - Ran targeted green verification for `test/codexRunner.test.ts`, `test/config.test.ts`, `test/webServer.test.ts`, and the new Discord bridge e2e coverage.
  - Ran `npm run check`; passed.
  - Ran `npm test`; passed with `101/101`.
  - Ran `npm run build`; passed.
  - Ran `bash -n scripts/macos-bridge.sh`; passed.
  - Updated the local `.env` to `WEB_BIND=0.0.0.0`.
  - Ran `./scripts/macos-bridge.sh web-url` and confirmed loopback plus LAN tokenized URLs are printed.
  - Restarted the installed LaunchAgent, verified the service is listening on `*:3769`, and fixed the script-side false negative in `service-status`.
  - Verified `GET /api/dashboard` returns HTTP `200` with the configured bearer token.
- Files created/modified:
  - `.env` (updated locally)
  - `.codex-plans/harden-app-server-discord-parity/plan.md` (updated)
  - `.codex-plans/harden-app-server-discord-parity/findings.md` (updated)
  - `.codex-plans/harden-app-server-discord-parity/progress.md` (updated)
