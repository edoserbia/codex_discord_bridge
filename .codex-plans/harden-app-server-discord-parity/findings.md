# Findings & Decisions

## Requirements
- Preserve app-server-first execution and continue using the local `codex` CLI as the backend.
- Keep `!guide`, real-time plan updates, and subagent status visibility working.
- Show subagent names in Discord when available.
- Prefer reusing subagents instead of constantly creating them, but stay aligned with official Codex behavior.
- Clean up unused subagent records after 12 hours by default.
- Make fallback to `legacy-exec` clearly visible and sticky in Discord.
- Restore and expose the web panel over LAN, still protected by token auth.
- Provide a `!` command that returns a tokenized web access URL, and keep a terminal-side way to get the same link.

## Research Findings
- `src/discordBot.ts` still routes `!guide` through a native `steer` path when a controllable active job exists, so this feature should be preserved rather than redesigned.
- Real-time plan updates still flow through `onTodoListChanged` in both legacy and app-server runners and render through `formatStatus()` / `formatProgressMessage()`.
- `parseCollabToolCall()` currently preserves subagent thread ids and status, but not nickname metadata.
- Local Codex protocol/schema inspection previously confirmed official fields such as `agent_nickname`, `receiver_agent_nickname`, and `new_agent_nickname`, so showing subagent names is protocol-aligned.
- Legacy execution already defaults `features.multi_agent=true` unless explicitly overridden; app-server config generation also resolves config entries through the same helper.
- The current progress/status cards only show the driver line in the status panel, not prominently in the live progress card, which explains why fallback mode feels non-sticky during refreshes.
- `WEB_BIND` still defaults to `127.0.0.1`, so the web panel is loopback-only by default.
- `AdminWebServer.getOrigin()` currently reflects the bound listen address directly, which produces unusable URLs such as `0.0.0.0` if LAN binding is enabled without extra handling.
- Token bootstrap already exists via `/?token=...` plus cookie auth, but no Discord command exposes a ready-to-open tokenized URL.
- No stable public CLI flag or documented local config key for forced subagent reuse/TTL has been confirmed from `codex --help`, `codex app-server --help`, `codex features list`, or local package/source inspection.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Represent driver mode in both progress and status cards | Keeps the active mode visible across message refreshes and fallback transitions |
| Preserve a one-time channel notice when falling back to legacy | Gives a durable audit trail in Discord beyond the refreshed progress card |
| Extend collab types to carry optional agent nicknames | Needed for Discord rendering and protocol fidelity |
| Add a `!web` command that generates tokenized loopback and LAN URLs | Satisfies the user's direct access requirement without removing auth |
| Default web bind to `0.0.0.0` while generating display URLs from concrete host candidates | Makes LAN access work without showing unusable listen addresses |
| Limit 12-hour cleanup to bridge-side cached subagent presentation state unless an official Codex knob is found | Avoids inventing unofficial runtime behavior inside Codex itself |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| Existing verified app-server parity work is still uncommitted in this workspace | Continue from the current state and fold the new hardening pass into the next commits rather than resetting the tree |
