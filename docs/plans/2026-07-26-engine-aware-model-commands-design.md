# Engine-aware model commands and Claude live progress

## Goal

Make model management follow the engine selected for the current bound project, keep Codex and Claude global/project configuration separate, and expose Claude's intermediate text and tool execution in the existing Discord progress card before the final answer.

## Command surface

`!model` remains the primary command family. In a bound project, an omitted engine resolves to that binding's `engine` (`codex` by default for legacy bindings). The existing `!model status`, `!model set <model>`, and `!model project ...` commands therefore operate on the current engine rather than always operating on Codex.

For unambiguous administration from any channel, add an optional engine selector before the existing scope/action:

```text
!model codex status
!model codex set <model>
!model codex project status|set <model>|clear
!model claude status
!model claude set <model>
!model claude project status|set <model>|clear
```

When no binding context exists, the omitted-engine form keeps the historical Codex behavior for compatibility; the reply/help text points operators to explicit selectors for the other engine. Project-scoped operations still require a resolved binding. `!claude-model ...` remains a compatibility alias for the Claude branch.

The handler layer resolves a single `effectiveEngine` before reading or mutating configuration. Codex operations use `~/.codex/config.toml` and the existing binding-level model synchronization, filtered to `binding.engine !== 'claude'`. Claude operations use global `~/.claude/settings.json` and project `<workspace>/.claude/settings.json`; Claude never uses `binding.codex.model` as its model source. Status panels and command replies use the same engine-aware resolution so a Claude project no longer displays a GPT model.

## Claude stream normalization

`ClaudeRunner` continues to invoke the installed official CLI with `-p --verbose --input-format text --output-format stream-json`, adding `--include-partial-messages` to request chunks as they arrive. The runner normalizes both full Claude CLI events and nested partial stream events into the existing `CodexRunHooks`:

- `system`/turn-start signals emit an analysis activity;
- text deltas are accumulated into a cumulative draft and sent through `onAgentMessage`;
- `assistant` tool-use blocks create a tracked command/tool invocation and call `onCommandStarted` for shell commands;
- `user` tool-result blocks and Claude tool-result payloads complete the tracked command with output and an exit status when available;
- permission requests remain diagnostics and preserve the existing approval flow;
- terminal success/error events emit completion activity and populate the existing result fields.

The adapter maintains per-run tool IDs and text buffers so duplicate full snapshots do not duplicate timeline entries and incremental deltas do not replace the visible draft with only the latest chunk. Non-shell tools are shown as activity text; shell/Bash tools populate the current-command and output-preview fields already rendered by `formatProgressMessage`.

## Discord rendering and failure handling

No second progress-message implementation is introduced. Existing runtime hooks update `latestActivity`, draft messages, command state, timelines, and diagnostics; existing refresh throttling continues to coalesce edits. Malformed or unknown stream events are ignored safely, while non-JSON stdout remains a diagnostic line. A missing/unsupported partial-message flag is surfaced as a normal Claude failure rather than silently pretending streaming works.

## Testing

- Parser tests cover omitted-engine routing inputs and explicit Codex/Claude selectors.
- Bridge model tests cover Claude-context `!model project status/set/clear`, explicit global Claude operations, Codex global filtering, and status-panel model output.
- Claude runner tests assert `--include-partial-messages`, cumulative partial text, tool command start/completion, permission behavior, and terminal success.
- Discord integration tests use a delayed fake Claude stream: they assert the progress message contains a draft and command before the delayed final result, then assert the final reply and session persistence.
- Focused tests, TypeScript build/check, full test suite, and a live-safe service status check run before restart. No leaked or untrusted Claude binary is installed.

## Compatibility and migration

Existing `!model` Codex usage and `!claude-model` usage continue to work. Existing persisted bindings and sessions remain valid; switching model settings does not reset active native sessions. Only future turns use the updated model, matching current behavior.
