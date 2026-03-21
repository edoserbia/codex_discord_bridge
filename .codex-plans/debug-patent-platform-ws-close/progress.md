# Progress Log

## Session: 2026-03-21

### Current Status
- **Phase:** 4 - Verification
- **Started:** 2026-03-21

### Actions Taken
- Started a dedicated investigation for the `patent_platform` failure that reported `app-server websocket transport closed`.
- Verified the failing binding/session state from `data/state.json` and confirmed there were no unusual per-project overrides.
- Inspected `src/codexAppServerClient.ts` and confirmed that the bridge previously defaulted `auto` transport to websocket for the real `codex` command.
- Confirmed from `codex app-server --help` that the official CLI default listen transport is `stdio://`.
- Added two focused tests in `test/codexAppServerClient.test.ts`: one for the official default transport expectation, and one for preserving child `stderr` when websocket transport closes.
- Extended `test/fixtures/fake-codex-app-server-ws.mjs` with a controlled websocket-close crash scenario and implemented the corresponding client fixes.

### Test Results
| Test | Expected | Actual | Status |
|------|----------|--------|--------|
| `resolveAppServerTransport(undefined, 'codex')` before fix | Should match official default `stdio` | Returned `ws` | failed |
| Websocket close diagnostic before fix | Should include recent child `stderr` | Only surfaced `app-server websocket transport closed` | failed |
| Focused client tests after fix | Both transport default and websocket-close diagnostics should pass | Passed | passed |
| `npm run check` | TypeScript should compile without emit errors | Passed | passed |
| `npm run build` | Production build should compile cleanly | Passed | passed |
| `npm test` | Full regression suite should pass after the transport/diagnostic fix | `104/104` passed | passed |

### Errors
| Error | Resolution |
|-------|------------|
| Initial targeted test imported a non-exported helper | Exported the existing transport resolver so the behavior could be asserted directly |

### Next Verification Step
- Completed:
  - Restarted the local `codex-discord-bridge` LaunchAgent and verified the new live PID is `71189`.
  - Confirmed the web panel is listening on `*:3769` and responds on `127.0.0.1:3769` with `401 Unauthorized`, which confirms the service is up and auth-protected.
  - Confirmed the latest log tail shows the restarted service instance without a new `app-server websocket transport closed` failure on startup.
