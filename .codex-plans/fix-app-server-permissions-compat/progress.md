# Progress Log

## Session: 2026-03-21

### Phase 1: Root Cause Confirmation
- **Status:** completed
- Actions taken:
  - Re-read the relevant app-server client, runner, resilient fallback, tests, and deployment docs.
  - Confirmed the production `patent_platform` binding already uses `danger-full-access`, `approvalPolicy=never`, and does not set a legacy permission profile.
  - Verified the local CLI version is `codex-cli 0.116.0`.
  - Reproduced the exact `Permissions profile \`full\` does not define any recognized filesystem entries` stderr with a temporary `CODEX_HOME` that contains `default_permissions = "full"`.
  - Verified the same temporary config starts cleanly once the obsolete `default_permissions/full` stanza is removed while keeping `sandbox_mode = "danger-full-access"` and `approval_policy = "never"`.
- Files created/modified:
  - `.codex-plans/index.md` (updated)
  - `.codex-plans/fix-app-server-permissions-compat/plan.md` (created)
  - `.codex-plans/fix-app-server-permissions-compat/findings.md` (created)
  - `.codex-plans/fix-app-server-permissions-compat/progress.md` (created)

### Phase 2: TDD and Implementation
- **Status:** completed
- Actions taken:
  - Added a regression test for diagnostics that rewrite the obsolete `default_permissions="full"` / `[permissions.full]` fault into actionable guidance.
  - Added an e2e bridge regression test proving Discord fallback notices now show the actionable compatibility hint and no ANSI escape noise.
  - Normalized Codex diagnostic lines in the shared diagnostics helper and reused that normalization across legacy runner, app-server runner, and app-server client stderr handling.
  - Updated `README.md`, `docs/DEPLOYMENT.md`, and `docs/MACOS-deploy.md` with the validated `codex-cli 0.116.0` compatibility note and the correct full-access config shape.
- Files created/modified:
  - `src/codexDiagnostics.ts` (updated)
  - `src/codexRunner.ts` (updated)
  - `src/codexAppServerRunner.ts` (updated)
  - `src/codexAppServerClient.ts` (updated)
  - `test/codexDiagnostics.test.ts` (updated)
  - `test/fixtures/fake-codex-app-server-fallback.mjs` (updated)
  - `test/discordBridge.e2e.test.ts` (updated)
  - `README.md` (updated)
  - `docs/DEPLOYMENT.md` (updated)
  - `docs/MACOS-deploy.md` (updated)

### Phase 3: Operational Remediation
- **Status:** completed
- Actions taken:
  - Updated `/Users/mac/.codex/config.toml` to keep top-level `danger-full-access` / `never` settings while removing the obsolete `default_permissions/full` profile.
  - Verified `codex app-server --listen stdio://` no longer emits the permissions-profile incompatibility, both in the bridge repo and in `/Users/mac/work/su/patent-platform`.
  - Restarted the installed LaunchAgent with `./scripts/macos-bridge.sh restart`.
  - Verified launchd reports the service as loaded and running with PID `24877`.
  - Verified the token-protected web dashboard responds at `http://127.0.0.1:3769/api/dashboard`.
- Files created/modified:
  - `/Users/mac/.codex/config.toml` (updated locally, not in repo)

### Phase 4: Verification and Delivery
- **Status:** in_progress
- Verification evidence:
  - `node --import tsx --test test/codexDiagnostics.test.ts` → pass
  - `node --import tsx --test --test-concurrency=1 test/discordBridge.e2e.test.ts` → pass (`49/49`)
  - `npm run check` → pass
  - `npm run build` → pass
  - `npm test` → pass (`111/111`)
  - `./scripts/macos-bridge.sh service-status` → launchd loaded, PID `24877`
  - `./scripts/macos-bridge.sh web-url` → returned loopback and LAN tokenized links
  - `curl -fsS -H "Authorization: Bearer <token>" http://127.0.0.1:3769/api/dashboard` → HTTP success, response size `11840` bytes
