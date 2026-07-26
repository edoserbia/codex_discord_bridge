# Engine-aware model commands and Claude live progress Implementation Plan

> **Execution:** REQUIRED SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Route model commands by Codex/Claude engine and stream Claude text/tool activity into the existing Discord progress card before task completion.

**Architecture:** Keep one `!model` command family with an optional explicit engine selector and preserve `!claude-model` as a compatibility alias. Resolve the effective engine in the Discord command handler from the explicit selector or current binding, then delegate to the existing Codex TOML and Claude JSON settings helpers. Extend `ClaudeRunner` to request and normalize official Claude CLI partial stream events into the already-wired `CodexRunHooks`; do not create a second Discord rendering path.

**Tech Stack:** TypeScript, Node.js built-in test runner, `discord.js`, official Claude Code CLI `stream-json`, existing fake Discord channels and CLI fixtures.

---

### Task 1: Extend parser types and command syntax with explicit engine selectors

**Files:**
- Modify: `src/commandParser.ts`
- Test: `test/commandParser.test.ts`

**Step 1: Write the failing tests**

Add parser cases for:

- `!model codex status` → `{ kind: 'model', engine: 'codex', scope: 'global', action: 'status' }`
- `!model claude set claude-sonnet-4-6` → `{ kind: 'model', engine: 'claude', scope: 'global', action: 'set', model: 'claude-sonnet-4-6' }`
- `!model claude project status` → `{ kind: 'model', engine: 'claude', scope: 'project', action: 'status' }`
- Existing omitted-engine `!model project status` remains unchanged.

Run: `node --import tsx --test --test-concurrency=1 test/commandParser.test.ts`

Expected: FAIL because the parser currently rejects `codex`/`claude` as model scopes.

**Step 2: Implement the smallest parser change**

Extend the `model` parsed-command union with optional `engine?: EngineName`, parse an engine token before the existing scope/action grammar, and reuse the existing model scope/action validation. Do not add an engine property for omitted-engine commands so existing deep-equality tests stay valid. Keep `!claude-model` parsing unchanged as a compatibility branch.

**Step 3: Run the focused parser tests**

Run: `node --import tsx --test --test-concurrency=1 test/commandParser.test.ts`

Expected: PASS.

**Step 4: Commit**

```bash
git add src/commandParser.ts test/commandParser.test.ts
git commit -m "feat: parse explicit model engine selectors"
```

### Task 2: Add red tests for engine-aware model routing and Codex global isolation

**Files:**
- Modify: `test/modelSwitching.test.ts`
- Modify: `test/discordBridgeClaudeEngine.test.ts` (only if status-panel coverage is kept there)

**Step 1: Write the failing integration tests**

Using the existing `createBridgeTestRig` and fake channels, add tests that:

1. Bind a project with `--engine claude`, write a Claude global and project model, then send `!model project status`; assert the reply is the Claude status and contains the Claude project model, not the Codex binding model.
2. In that same Claude project, send `!model project set claude-project-next` and assert the workspace `.claude/settings.json` changes; send `!model project clear` and assert the project key is removed.
3. From a Claude-bound context, send `!model set claude-global-next` and assert only Claude global settings change.
4. Bind one Codex and one Claude project, send explicit `!model codex set gpt-next`, and assert the Codex binding/config changes while the Claude project settings and binding metadata remain untouched.
5. Assert `!status` for a Claude binding renders Claude's effective model instead of calling it a Codex/GPT model.

Run: `node --import tsx --test --test-concurrency=1 test/modelSwitching.test.ts test/discordBridgeClaudeEngine.test.ts`

Expected: FAIL because the generic handler always enters the Codex branch and status rendering always reads the Codex global model.

**Step 2: Commit the red tests**

```bash
git add test/modelSwitching.test.ts test/discordBridgeClaudeEngine.test.ts
git commit -m "test: cover engine-aware model commands"
```

### Task 3: Implement effective-engine model routing and status rendering

**Files:**
- Modify: `src/discordBot.ts`
- Modify: `src/formatters.ts`
- Modify: `src/types.ts` only if the parser type requires a shared engine field

**Step 1: Add an effective-engine resolver**

In `DiscordCodexBridge`, resolve `command.engine ?? resolved?.binding.engine ?? 'codex'`. For project-scoped commands, reject missing `resolved` before reading either settings file. For omitted-engine global commands without a binding, preserve Codex behavior; explicit `!model claude ...` works from any channel.

**Step 2: Share the existing Codex/Claude command implementations**

Route `kind: 'model'` to the Codex or Claude implementation based on the resolver. Keep the `kind: 'claude-model'` handler as a thin wrapper that forces `engine: 'claude'`. Ensure Codex global synchronization filters to `binding.engine !== 'claude'` and reports the filtered count. Ensure Claude project status/set/clear uses `claudeSettings.ts` and never reads `binding.codex.model`.

**Step 3: Make status panels engine-aware**

Update `refreshStatusPanel`/`handleStatusCommand` to compute the model summary for the binding's engine. Extend `formatStatus` with a minimal optional preformatted model summary (or equivalent typed data) while preserving existing Codex call sites and tests. Claude status should show its effective project/global model and source.

**Step 4: Run the red tests again**

Run: `node --import tsx --test --test-concurrency=1 test/modelSwitching.test.ts test/discordBridgeClaudeEngine.test.ts`

Expected: PASS, with the existing model-switch and Claude tests also remaining green.

**Step 5: Commit**

```bash
git add src/discordBot.ts src/formatters.ts src/types.ts
git commit -m "fix: route model commands by engine"
```

### Task 4: Add failing Claude runner stream tests and delayed fixture events

**Files:**
- Modify: `test/claudeRunner.test.ts`
- Modify: `test/fixtures/fake-claude.mjs`

**Step 1: Add runner-level red tests**

Add a test that starts the fake Claude runner with a `[stream-progress]` prompt and asserts:

- the spawned args include `--include-partial-messages`;
- `onActivity` receives Claude analysis/tool/completion activity;
- `onAgentMessage` receives cumulative partial text (not only the final result);
- `onCommandStarted` receives `git status` (or the fixture's shell command);
- `onCommandCompleted` receives the command output and exit code;
- the final result remains successful and includes the final answer.

Run: `node --import tsx --test --test-concurrency=1 test/claudeRunner.test.ts`

Expected: FAIL because the flag is missing and `ClaudeRunner.handleStreamEvent` ignores partial/tool events.

**Step 2: Extend the fake CLI only enough to reproduce the stream**

For `[stream-progress]`, emit `system`, nested `stream_event` message/text deltas, a `tool_use` block carrying a Bash command, a delayed `user` tool result, final text deltas, and a delayed successful `result`. Teach the fixture argument parser to retain `--include-partial-messages`. Keep the normal and permission fixtures unchanged.

**Step 3: Re-run the runner test to verify it still fails for production behavior**

Run: `node --import tsx --test --test-concurrency=1 test/claudeRunner.test.ts`

Expected: FAIL with missing hooks/flag rather than fixture syntax errors.

**Step 4: Commit the red test and fixture**

```bash
git add test/claudeRunner.test.ts test/fixtures/fake-claude.mjs
git commit -m "test: reproduce Claude live stream events"
```

### Task 5: Normalize official Claude partial/tool events into existing hooks

**Files:**
- Modify: `src/claudeRunner.ts`
- Test: `test/claudeRunner.test.ts`

**Step 1: Request partial messages**

Add `--include-partial-messages` next to the existing stream-json flags in `buildArgs`.

**Step 2: Add per-run stream state**

Maintain a cumulative assistant text buffer, a map of tool-use IDs to command/tool metadata, and partial input buffers keyed by content block index or tool ID. Deduplicate full assistant snapshots and tool-use events.

**Step 3: Handle lifecycle and text events**

Handle `system`/turn-start activity, nested `stream_event` text deltas, full `assistant` snapshots, and terminal `result` events. Pass cumulative text to `onAgentMessage`, preserve the final result text, mark completion only for successful terminal results, and emit a completion activity.

**Step 4: Handle tool events**

Parse Bash/shell tool-use blocks into a command string and call `onCommandStarted`. Parse `user` tool results and top-level Claude tool-result payloads into output and optional exit code, append `CommandRecord`, and call `onCommandCompleted`. For non-shell tools, emit a concise `onActivity` message without pretending they are shell commands.

**Step 5: Preserve existing permission/error behavior**

Continue accepting the existing permission event variants, route malformed JSON to diagnostics, and avoid marking error results as successful.

**Step 6: Run runner tests**

Run: `node --import tsx --test --test-concurrency=1 test/claudeRunner.test.ts`

Expected: PASS.

**Step 7: Commit**

```bash
git add src/claudeRunner.ts test/claudeRunner.test.ts
git commit -m "feat: stream Claude partial and tool progress"
```

### Task 6: Prove Discord progress appears before Claude completion

**Files:**
- Modify: `test/discordBridgeClaudeEngine.test.ts`
- Modify: `src/formatters.ts` only if the test exposes a missing Claude label

**Step 1: Add the delayed integration test**

Dispatch a `[stream-progress]` Claude task, wait for the progress message to exist, then assert before the final reply that the same progress message contains the partial draft and `当前命令`. After the delayed result, assert the final reply and session ID. This test must observe an active run, not just inspect the final message history.

**Step 2: Run the integration test**

Run: `node --import tsx --test --test-concurrency=1 test/discordBridgeClaudeEngine.test.ts`

Expected: PASS with live pre-completion assertions.

**Step 3: Commit**

```bash
git add test/discordBridgeClaudeEngine.test.ts src/formatters.ts
git commit -m "test: verify Claude Discord live progress"
```

### Task 7: Update public help/docs and run complete verification

**Files:**
- Modify: `src/formatters.ts`
- Modify: `README.md`
- Modify: `docs/ENGINES.md`
- Modify: `docs/QUICKSTART.md`
- Modify: `docs/MACOS-deploy.md`
- Test: `test/formatters.test.ts`

**Step 1: Update help text and docs**

Document omitted-engine routing, explicit `codex`/`claude` selectors, the compatibility alias, and that Claude progress uses the official CLI stream. Keep examples in Chinese consistent with existing docs.

**Step 2: Run focused verification**

```bash
node --import tsx --test --test-concurrency=1 test/commandParser.test.ts test/modelSwitching.test.ts test/claudeRunner.test.ts test/discordBridgeClaudeEngine.test.ts test/formatters.test.ts
npm run check
```

Expected: all focused tests pass and TypeScript reports no errors.

**Step 3: Run the full suite and build**

```bash
npm test
npm run build
```

Expected: all tests pass and `dist/` builds successfully.

**Step 4: Run completion checks**

Run `~/.codex/skills/planning-with-files/scripts/check-complete.sh` and inspect `git diff --check` plus `git status --short`.

**Step 5: Commit docs and verification changes**

```bash
git add src test README.md docs/ENGINES.md docs/QUICKSTART.md docs/MACOS-deploy.md
git commit -m "docs: explain engine-aware model controls and Claude streaming"
```

**Step 6: Safe service verification/restart**

Run `./scripts/macos-bridge.sh status`, then rebuild/restart only after all tests pass. Verify `./scripts/macos-bridge.sh service-status`, the running PID, the 3769 panel, and the latest log lines. Do not install any leaked or untrusted Claude Code binary.
