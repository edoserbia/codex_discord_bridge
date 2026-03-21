# App-server Hardening Design

## Goal
Keep Discord interactions as close as practical to direct Codex CLI app-server behavior while fixing three remaining UX gaps: sticky driver visibility, richer subagent visibility, and secure LAN-accessible web control.

## Scope
- Preserve `app-server` as the preferred execution path.
- Keep `!guide` working against the active run without destroying the current task context.
- Keep real-time plan rendering and existing queue/task behavior intact.
- Show subagent names and statuses in Discord when official protocol fields are present.
- Expose tokenized web URLs through Discord and the local service script.
- Make the web panel reachable over LAN while keeping token auth.

## Non-goals
- Do not rewrite the bridge into a raw protocol proxy.
- Do not remove fallback to `legacy-exec`; only make it more visible and easier to audit.
- Do not invent private Codex protocol fields for subagent reuse if the local CLI does not expose them.

## Constraints
- The user's machine only needs the `codex` CLI; no separate Codex desktop app install is required for the bridge backend.
- Some bridge features necessarily add wrapper behavior around raw Codex usage, such as Discord command routing, attachment staging, and queue management.
- Local investigation has not confirmed a stable official CLI knob for forced subagent reuse or a 12-hour child-agent TTL.

## Approaches Considered

### 1. UI-only patch
Patch Discord rendering and web bind defaults without touching the runtime model.

This is fast, but it does not improve parity with Codex CLI semantics and leaves subagent naming incomplete.

### 2. App-server-first semantic alignment
Treat app-server as the source of truth, preserve official thread/turn behavior, and only add bridge-side rendering and convenience layers where needed.

This keeps the bridge closest to official Codex behavior while fixing the user-visible gaps. This is the recommended approach.

### 3. Custom bridge-managed orchestration
Build custom driver/session semantics on top of app-server and legacy paths.

This offers maximum control, but it drifts away from official Codex behavior and increases regression risk across guide, plan, and queue flows.

## Recommended Design

### Driver visibility
- Keep the existing one-time Discord notice when app-server falls back to legacy.
- Add a sticky driver line to both the status panel and the live progress card.
- Persist the currently active driver mode in runtime/session state so refreshed cards continue to show the real mode.
- If app-server recovers on a later run, keep the recovery notice and update the sticky driver line back to `app-server`.

### Subagent visibility
- Extend collab tool parsing to retain optional agent nicknames from both legacy and app-server protocol payloads.
- Render those nicknames in progress and status summaries instead of showing only thread ids and aggregate counts.
- Keep the existing collab activity timeline model so subagent status changes remain step-based.
- Add bridge-side pruning for stale subagent presentation records older than 12 hours so long-running channels do not accumulate unbounded historical state.

### Reuse policy
- Continue preferring official thread/session reuse across runs.
- Preserve `features.multi_agent=true` default behavior unless the binding explicitly overrides it.
- If the local Codex CLI does not expose a stable forced-reuse or TTL setting for child agents, do not inject an unofficial knob. Instead, document the limitation and keep cleanup confined to bridge-side cached metadata.

### `!guide` and plan status
- Keep `!guide` on the native `turn/steer` path for controllable app-server runs.
- Do not alter queue semantics or synthesize new wrapper prompts on the app-server steer path.
- Leave `onTodoListChanged` wiring intact and add regression tests to confirm live plan updates still render correctly after the hardening changes.

### Web panel
- Change the default bind host from `127.0.0.1` to `0.0.0.0`.
- Keep bearer and cookie auth exactly as they work today.
- Add a helper that returns concrete access URLs:
  - loopback URL for local access
  - LAN URL(s) built from active non-internal IPv4 addresses
  - tokenized variants when `WEB_AUTH_TOKEN` is configured
- Add a `!web` command that posts the ready-to-open URL list in Discord.
- Align the shell script output/open behavior with the same URL-building logic so terminal and Discord surfaces match.

## Testing Strategy
- Add failing tests first for:
  - sticky driver rendering in progress/status cards
  - subagent nickname parsing and rendering
  - `!web` command output and tokenized URL generation
  - LAN-friendly web origin/link generation
  - no regression in `!guide` and live plan updates
- Keep targeted suites for app-server client, runner, bridge e2e, web server, and config behavior.
- Finish with full verification, then restart and inspect the local service.

## Risks
- Some app-server event payloads may omit nickname fields, so rendering must degrade gracefully.
- LAN bind defaults can expose the panel more broadly; token auth must remain enabled and clearly surfaced.
- There may still be no official subagent reuse/TTL control exposed by Codex CLI. In that case, the bridge can only preserve session reuse and clean its own stale presentation state.
