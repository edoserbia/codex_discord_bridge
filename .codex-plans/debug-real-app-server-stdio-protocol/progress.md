# Progress Log

## Session: 2026-03-21

### Phase 1: Root Cause Confirmation
- **Status:** completed
- Actions taken:
  - Reproduced the timeout with the bridge's real `CodexAppServerClient` against `codex-cli 0.116.0`.
  - Confirmed removing the obsolete permissions profile fixed one startup fault but did not resolve the handshake timeout.
  - Probed the real `codex app-server --listen stdio://` directly with two message formats:
    - `Content-Length` framing: no `initialize` response
    - newline-delimited JSON: immediate `initialize` response
  - Confirmed the bridge and the real CLI disagree on stdio transport framing.
- Files created/modified:
  - `.codex-plans/index.md` (updated)
  - `.codex-plans/debug-real-app-server-stdio-protocol/plan.md` (created)
  - `.codex-plans/debug-real-app-server-stdio-protocol/findings.md` (created)
  - `.codex-plans/debug-real-app-server-stdio-protocol/progress.md` (created)

### Phase 2: TDD and Implementation
- **Status:** completed
- Actions taken:
  - Added a regression test that requires the real stdio newline-delimited JSON transport semantics.
  - Updated the fake app-server fixtures so tests can simulate strict NDJSON or legacy content-length framing.
  - Switched the bridge stdio sender to newline-delimited JSON and taught the stdout parser to accept both NDJSON and content-length responses.
- Files created/modified:
  - `test/codexAppServerClient.test.ts` (updated)
  - `test/fixtures/fake-codex-app-server.mjs` (updated)
  - `test/fixtures/fake-codex-app-server-turn-fallback.mjs` (updated)
  - `src/codexAppServerClient.ts` (updated)

### Phase 3: Verification
- **Status:** completed
- Verification evidence:
  - `node --import tsx --test test/codexAppServerClient.test.ts --test-name-pattern "newline-delimited JSON transport"` → failed before the client patch, then passed after the patch
  - `node --import tsx - <<'EOF' ... client.start()/ensureThread() ... EOF` against `/Users/mac/work/su/codex-discord-bridge` → pass, `elapsed_ms=189`
  - `node --import tsx - <<'EOF' ... client.start()/ensureThread() ... EOF` against `/Users/mac/work/su/patent-platform` → pass, `elapsed_ms=189`
  - `node --import tsx - <<'EOF' ... startTurn("Run pwd once ...") ... EOF` against `/Users/mac/work/su/codex-discord-bridge` → pass with real `turn.started`, `item.started/completed`, and `agent.message.delta` events
  - `npm run check` → pass
  - `npm test` → pass (`112/112`)
  - `npm run build` → pass
  - `./scripts/macos-bridge.sh restart` → pass, new PID `42056`
  - `./scripts/macos-bridge.sh service-status` → launchd loaded, running, Web panel on `http://127.0.0.1:3769`
  - `./scripts/macos-bridge.sh web-url` → returned local and LAN tokenized URLs
