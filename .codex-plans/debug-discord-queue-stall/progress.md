# Progress Log

## Session: 2026-03-21

### Phase 1: Discovery
- **Status:** in_progress
- **Started:** 2026-03-21 15:14
- Actions taken:
  - Verified the current working directory was not the git repository.
  - Located the actual `codex-discord-bridge` repository and inspected recent commits.
  - Checked package scripts, runtime process list, and the main bridge log.
  - Found log evidence of `turnCompleted=false` with `exitCode=0`.
  - Traced queue release logic through `DiscordCodexBridge.processQueue()` and confirmed only unresolved `job.done` can wedge the queue permanently.
  - Inspected `CodexAppServerClient`, `CodexAppServerRunner`, and generated app-server protocol bindings from the local Codex package.
  - Reproduced a real initialize hang against `codex app-server --listen stdio://` with a 10-second probe: no response bytes arrived on stdout.
  - Re-ran the same initialize probe against `@openai/codex@0.113.0` and `@openai/codex@0.116.0`; both showed the same no-response hang.
- Files created/modified:
  - `.codex-plans/index.md` (created)
  - `.codex-plans/debug-discord-queue-stall/plan.md` (created)
  - `.codex-plans/debug-discord-queue-stall/findings.md` (created)
  - `.codex-plans/debug-discord-queue-stall/progress.md` (created)

### Phase 2: Planning and Structure
- **Status:** completed
- Actions taken:
  - Compared app-server and legacy execution paths to identify what still prevents high answer-path parity with the official CLI.
  - Traced the live progress regression from app-server delta notifications through `CodexAppServerRunner` into Discord runtime timeline rendering.
  - Determined that the “one character at a time” progress issue is caused by treating streaming delta updates as semantic process items.
  - Wrote a design doc and implementation plan covering startup-context parity and step-based progress rendering.
- Files created/modified:
  - `docs/plans/2026-03-21-app-server-parity-progress-design.md` (created)
  - `docs/plans/2026-03-21-app-server-parity-progress.md` (created)
  - `.codex-plans/index.md` (updated)
  - `.codex-plans/debug-discord-queue-stall/plan.md` (updated)
  - `.codex-plans/debug-discord-queue-stall/findings.md` (updated)
  - `.codex-plans/debug-discord-queue-stall/progress.md` (updated)

### Phase 3: Implementation
- **Status:** completed
- Actions taken:
  - Added a failing app-server client test proving child startup context was using the wrong directory.
  - Updated app-server startup to accept the binding workspace path and launch the child with workspace-aligned `cwd` / `PWD`.
  - Refactored `CodexAppServerRunner` to keep one `CodexAppServerClient` per workspace path so startup context does not bleed across unrelated project bindings.
  - Added a live progress regression fixture and e2e test for streamed app-server deltas.
  - Removed streamed reasoning/message deltas from the Discord process timeline while keeping final answers and summary fields intact.
  - Added prefix-coalescing for streamed reasoning and agent text previews.
  - Fixed duplicate command-step emission caused by late `command.output.delta` events arriving after command completion.
- Files created/modified:
  - `src/codexAppServerClient.ts` (updated)
  - `src/codexAppServerRunner.ts` (updated)
  - `src/discordBot.ts` (updated)
  - `test/codexAppServerClient.test.ts` (updated)
  - `test/discordBridge.e2e.test.ts` (updated)
  - `test/fixtures/fake-codex-app-server.mjs` (updated)

### Phase 4: Testing and Verification
- **Status:** completed
- Actions taken:
  - Added regression coverage for default local/full-access binding behavior and app-server protocol forwarding of `sandbox` / `approval` / `search`.
  - Ran `node --import tsx --test test/config.test.ts` and confirmed the new default-search assertion fails before the fix, then passes after the fix.
  - Ran `node --import tsx --test test/codexAppServerClient.test.ts` locally and confirmed all 11 client tests pass, including the new `dangerFullAccess` / `web_search` assertions.
  - Ran `node --import tsx --test --test-concurrency=1 test/discordBridge.e2e.test.ts` locally and confirmed all 40 bridge e2e tests pass, including the new default-binding regression and the existing app-server progress/fallback suite.
  - Ran `npm run check`, `npm test`, `npm run build`, and `bash -n scripts/macos-bridge.sh`; all passed on the local machine.
- Files created/modified:
  - `.codex-plans/debug-discord-queue-stall/progress.md` (updated)

### Phase 5: Delivery
- **Status:** completed
- Actions taken:
  - Updated `scripts/macos-bridge.sh`, `.env.example`, and the local `.env` so deployment defaults now keep search enabled by default alongside `danger-full-access` and `approval=never`.
  - Rebuilt `dist/` with `npm run build`.
  - Restarted the installed LaunchAgent with `./scripts/macos-bridge.sh restart`.
  - Verified the launchd service is running again via `./scripts/macos-bridge.sh service-status`.
  - Verified the live runtime config by loading `dist/config.js`, confirming `sandboxMode=danger-full-access`, `approvalPolicy=never`, `search=true`, `driver=app-server`.
- Files created/modified:
  - `scripts/macos-bridge.sh` (updated)
  - `.env.example` (updated)
  - `.env` (updated locally)
  - `.codex-plans/debug-discord-queue-stall/progress.md` (updated)

## Test Results
| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| Runtime process check | `ps aux | rg 'codex-discord-bridge|node .*dist/index|discord'` | Confirm whether bridge is running | `node dist/index.js` PID `89908` is running | ✓ |
| Recent log inspection | `tail -n 200 logs/codex-discord-bridge.log` | Identify explicit failure signal for stuck queue | Found multiple `turnCompleted=false success=false` records despite `exitCode=0` | ✓ |
| Real app-server initialize probe | custom Node probe against `/usr/local/bin/codex app-server --listen stdio://` | Receive initialize response or at least some stdout frames | Timed out after 10s with `stdoutBytes=0` | ✓ |
| Cross-version initialize probe | custom Node probe against `npx -y @openai/codex@0.113.0` and `0.116.0` | Determine whether hang is unique to `0.114.0` | Both versions timed out with `stdoutBytes=0` | ✓ |
| Config defaults regression | `node --import tsx --test test/config.test.ts` | Default search should be enabled together with `danger-full-access` / `never` | Failed before the fix on `search=false`, then passed after the fix | ✓ |
| App-server client suite | `node --import tsx --test test/codexAppServerClient.test.ts` | Startup-context and local/full-access protocol regressions pass | 11/11 pass locally | ✓ |
| Bridge e2e suite | `node --import tsx --test --test-concurrency=1 test/discordBridge.e2e.test.ts` | Default-binding, app-server progress, fallback, and attachment flows stay green | 40/40 pass locally | ✓ |
| Type check | `npm run check` | TypeScript clean | exit 0 | ✓ |
| Full test suite | `npm test` | Entire project passes on local machine | 95/95 pass locally | ✓ |
| Build | `npm run build` | Fresh `dist/` generated successfully | exit 0 | ✓ |
| Launch script syntax | `bash -n scripts/macos-bridge.sh` | Shell script stays syntactically valid | exit 0 | ✓ |
| Runtime default config | `node --input-type=module -e "import('./dist/config.js')..."` | Running config resolves to local/full-access/search-on app-server defaults | `sandboxMode=danger-full-access`, `approvalPolicy=never`, `search=true`, `driver=app-server` | ✓ |
| LaunchAgent status | `./scripts/macos-bridge.sh service-status` | Local service is back on the updated build | running with `PID=4201` | ✓ |

## Error Log
| Timestamp | Error | Attempt | Resolution |
|-----------|-------|---------|------------|
| 2026-03-21 15:08 | `using-superpowers` skill path missing | 1 | Recorded and continued with available skills |
| 2026-03-21 15:09 | `fatal: not a git repository` in `/Users/mac/work/su/codex_tmp` | 1 | Located `/Users/mac/work/su/codex-discord-bridge` and switched context |
| 2026-03-21 15:43 | Incorrect `npm test` invocation treated `--test-name-pattern=...` as a file path | 1 | Will rerun targeted tests with explicit file arguments or direct `node --test` invocation |
| 2026-03-21 18:01 | New worktree would drop the in-flight uncommitted app-server edits that this task builds on | 1 | Intentionally stayed in the current working tree and documented the decision |
| 2026-03-21 18:35 | `listen EPERM: operation not permitted 127.0.0.1` in websocket transport test | 1 | Treated as sandbox limitation; noted that the startup-context regression and app-server progress tests still pass |
| 2026-03-21 18:44 | `listen EPERM: operation not permitted 127.0.0.1` in attachment-serving e2e test | 1 | Treated as sandbox limitation; relevant app-server/progress tests remain green |
| 2026-03-21 21:08 | `DEFAULT_CODEX_SEARCH` still resolved to `false` in the real deployment path | 1 | Fixed both the TypeScript fallback and the macOS/.env defaults, then re-verified via runtime config load |

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | Delivery is complete; code, tests, build, and local LaunchAgent deployment are verified |
| Where am I going? | Hand the updated status and behavior summary back to the user |
| What's the goal? | Keep app-server as the preferred backend while making answers closer to official CLI behavior and restoring step-based live progress |
| What have I learned? | The remaining mismatch after the protocol fixes was not command parsing, but default-search overrides in config/bootstrap files |
| What have I done? | Implemented workspace-scoped app-server startup parity, semantic progress rendering, local/full-access default binding behavior, and deployed the updated LaunchAgent locally |

---
*Update after completing each phase or encountering errors*
