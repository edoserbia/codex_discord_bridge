# Findings & Decisions

## Requirements
- Inspect what changed in the Codex Discord bridge, especially the migration to a Codex Server style backend.
- Check logs and current runtime to explain why Discord channel messages remain queued or blocked.
- Fix the issue so the important bridge process can run normally again.
- Keep the Codex Server form as the actual backend, rather than reverting to an unrelated backend mode.

## Research Findings
- The actual repository is `/Users/mac/work/su/codex-discord-bridge`; the current shell directory `/Users/mac/work/su/codex_tmp` is not a git repo.
- The bridge process is currently running as `node dist/index.js` with PID `89908`.
- Recent commits include `1d98643 Add app-server session parity with legacy fallback`, which is the most likely place where Codex Server style execution behavior changed.
- Runtime logs show several tasks with `exitCode=0` but `turnCompleted=false success=false`, which is consistent with a queue item not being released even though the subprocess itself exited cleanly.
- The log also shows the service is configured with proxy and system CA injection and does connect to Discord successfully, so the primary failure is not initial login.
- A stronger failure mode appears in the newest log tail: some app-server attempts start with `pid=null` and never produce a matching `attempt exit` line, which means `job.done` is hanging rather than merely returning a failed result.
- Source tracing confirms the queue only advances in `processQueue()` after `job.done` settles; a failed-but-settled run still releases the queue, but a hanging `job.done` blocks the whole conversation indefinitely.
- `CodexAppServerClient.start()` has no request timeout around the initial `initialize` handshake, and `ResilientCodexExecutionDriver` only falls back after the primary job returns a result. If initialize hangs forever, fallback never triggers.
- On this machine, real `codex app-server --listen stdio://` never returns a framed `initialize` response within 10 seconds. The probe observed `stdoutBytes=0`, `bufferedBytes=0`, and only one stderr warning about stale temp dir cleanup.
- The same initialize hang reproduces with `@openai/codex` versions `0.113.0`, `0.114.0`, and `0.116.0`, so the immediate root cause is not unique to the currently installed `0.114.0`.
- Generated TypeScript bindings from the local Codex package confirm that the bridge is already using the expected notification names such as `turn/completed`, `turn/plan/updated`, `item/agentMessage/delta`, and `item/reasoning/summaryTextDelta`. The problem is earlier, at app-server startup / initialize.
- The generated protocol also defines a client notification `{ \"method\": \"initialized\" }`, which the current bridge client does not send, but that does not explain this exact symptom because no `initialize` response arrives at all.
- The current app-server parity work still starts the app-server child with `cwd: process.cwd()` and `PWD=process.cwd()` instead of the bound workspace, so the startup environment diverges from running Codex directly in the project directory.
- The bridge passes normal prompts through unchanged, but guidance requests and attachment-bearing requests are intentionally wrapped with bridge-authored text. That means strict byte-for-byte prompt parity is impossible while those features remain enabled.
- The app-server runner emits `onAgentMessage()` and `onReasoning()` for every delta growth step. Discord runtime hooks then append those to `timeline`, which is why progress cards show repeated growing `💬` entries instead of step-level items.
- Final answer selection and live progress updates currently share the same `agentMessages` stream, so the code must separate “streaming preview” from “semantic final answer” carefully to avoid regressing final replies.
- A practical parity improvement is to make app-server client instances workspace-scoped instead of globally shared, so the child startup context can match the bound workspace without cross-project contamination.
- A practical live-progress fix is to keep delta text in streaming buffers and summary fields while reserving `timeline` for semantic steps such as commands, collab actions, fallbacks, retries, and completion.
- App-server command events can arrive out of order in fixtures and likely in real transports, so `command.output.delta` must ignore already-completed command items and avoid double-emitting command-start / command-complete timeline entries.
- The binding command surface already supported `--sandbox`, `--approval`, and `--search`; the remaining mismatch for the user-facing defaults was that `loadConfig()` still defaulted `DEFAULT_CODEX_SEARCH` to `false`.
- The macOS deployment path had two additional default-search overrides outside TypeScript: `scripts/macos-bridge.sh` generated `.env` with `DEFAULT_CODEX_SEARCH=false`, and this machine's checked-in `.env` also explicitly set `DEFAULT_CODEX_SEARCH=false`.
- After updating code, script defaults, and the local `.env`, a direct runtime config load from `dist/config.js` confirms `sandboxMode=danger-full-access`, `approvalPolicy=never`, `search=true`, and `codexDriverMode=app-server`.
- After rebuild and restart, the installed LaunchAgent is running again as `node dist/index.js` with PID `4201`.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Trace `turnCompleted=false` from logs into code before editing anything | That signal likely controls queue release and matches the user-visible symptom |
| Treat Discord API timeout/reset logs as secondary until queue logic is understood | Those errors affect status refresh, but the main symptom is channel messages staying queued |
| Treat app-server initialize hang as the primary blocker | Reproduced directly outside the bridge, and it matches the missing `attempt exit` symptom |
| Patch the bridge with explicit app-server startup/request timeouts and recovery behavior | This is necessary to stop a single hung app-server attempt from wedging the whole Discord conversation queue |
| Align app-server startup context with the binding workspace | This reduces execution-context drift from the official CLI in the common path |
| Stop treating delta text as process items | Timeline should represent semantic steps, not token-stream growth |
| Scope app-server clients by workspace path | This preserves startup-context parity without mixing state across unrelated project bindings |
| Coalesce streaming text by prefix growth | This keeps analysis/message previews stable instead of appending duplicate partial strings |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| Missing skill file for `using-superpowers` | Continued with the available skills and documented the mismatch |
| No `.codex-plans/` existed in this repo | Created a fresh task planning area for this debugging session |
| `codex app-server` initialize probe never returned | Confirmed with multiple probe variants and version checks; will address in bridge-side timeout handling |
| The obvious `using-git-worktrees` workflow is not safe here | Stayed in the current workspace because the target work depends on existing uncommitted app-server changes already present locally |
| Some verification tests require binding `127.0.0.1` in this sandbox | Recorded the resulting `EPERM` failures as environment limitations when they hit websocket and attachment-serving tests |
| Local deployment defaults still forced `DEFAULT_CODEX_SEARCH=false` even after the TypeScript default was fixed | Updated `scripts/macos-bridge.sh`, `.env.example`, and the local `.env` so the running service matches the intended default behavior |

## Resources
- Repository: `/Users/mac/work/su/codex-discord-bridge`
- Main log: `/Users/mac/work/su/codex-discord-bridge/logs/codex-discord-bridge.log`
- Recent commit of interest: `1d98643 Add app-server session parity with legacy fallback`
- Local Codex binary: `/usr/local/bin/codex`
- Generated protocol map: temporary `ServerNotification.ts` from `codex app-server generate-ts --out <tmpdir>`

## Visual/Browser Findings
- No browser artifacts used yet.

---
*Update this file after every 2 view/browser/search operations*
*This prevents visual information from being lost*
