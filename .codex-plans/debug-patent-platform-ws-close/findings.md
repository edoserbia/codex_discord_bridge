# Findings and Decisions

## Requirements
- Explain why the `patent_platform` request failed with `app-server websocket transport closed`.
- Determine whether this indicates a bridge logic regression or an external/runtime failure.
- Fix the bridge if it is responsible, otherwise report the live operational cause and limits clearly.

## Research Findings
- The failing `patent_platform` session is conversation `1482209060349673754`, bound to `/Users/mac/work/su/patent-platform` with ordinary defaults: `danger-full-access`, `approvalPolicy=never`, `search=true`, `skipGitRepoCheck=true`, and no custom `extraConfig`.
- The live failure at log line `4574` is `task=829e22fe attempt=1/3 ... stderr=app-server websocket transport closed`.
- The current environment does not pin `CODEX_APP_SERVER_TRANSPORT`, so the bridge uses its internal `auto` logic.
- `src/codexAppServerClient.ts` previously resolved `auto` to `ws` for real commands like `codex`, even though `codex app-server --help` reports `stdio://` as the official default listen transport.
- This means the bridge was diverging from the official Codex CLI behavior and exposing a websocket-only failure mode that official default usage would not take.
- The bridge also discarded all app-server child `stderr` in `spawnAppServer()`, so when a websocket transport closed mid-turn the user only saw a generic transport-close error with no root-cause detail.
- A new focused test reproduced both issues:
  - `resolveAppServerTransport(undefined, 'codex')` returned `ws` instead of the official `stdio`.
  - when a websocket-based fake app-server wrote `simulated websocket app-server crash` to `stderr` and then closed, the client only surfaced `app-server websocket transport closed`.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Default `auto` transport to `stdio` for all commands | Matches official Codex app-server semantics and removes the bridge-specific websocket failure surface from normal runs |
| Keep explicit `ws` support unchanged | Useful for tests and intentional overrides, but it should no longer be the implicit default |
| Buffer recent child `stderr` lines and append them to failure diagnostics | Gives actionable root cause information when the child crashes or the websocket closes unexpectedly |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| The first TDD pass failed at module import time because the transport resolver helper was not exported | Exported the existing helper so transport-default behavior could be tested directly |

## Resources
- Chat transcript supplied by the user for the failing run.
