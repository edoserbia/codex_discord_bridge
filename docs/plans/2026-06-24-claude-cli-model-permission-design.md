# Claude CLI Model and Permission Integration Design

> **Execution:** REQUIRED SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Codex Discord Bridge drive Claude CLI reliably on this Mac, with global and per-project model settings, Discord-visible permission confirmation for missing allowances, and a test-first rollout that preserves existing Bridge behavior.

**Architecture:** Keep the current Codex execution path intact and add Claude-specific settings management plus a Discord-facing permission confirmation flow. Global Claude defaults come from `~/.claude/settings.json`, project overrides come from `<workspace>/.claude/settings.json`, and Bridge resolves the effective Claude model from those files before launching Claude CLI. When Claude requests a permission that is not already allowed, Bridge pauses the run, surfaces the request in Discord, and resumes or rejects based on an explicit Discord command.

**Tech Stack:** TypeScript, Node.js `child_process`, existing Discord bridge runtime, JSON file IO, current test harness and fake CLI fixtures.

---

### Task 1: Claude settings resolution and persistence

**Files:**
- Create: `src/claudeSettings.ts`
- Modify: `src/config.ts`
- Modify: `src/discordBot.ts`
- Test: `test/claudeSettings.test.ts`
- Test: `test/modelSwitching.test.ts`

**Step 1: Write the failing tests**

```ts
test('resolves effective Claude model from project override then global settings', async () => {
  // project settings should win over global settings
});
```

```ts
test('writes project Claude model to workspace .claude/settings.json', async () => {
  // bridge writes the per-project override file directly
});
```

```ts
test('writes global Claude model to ~/.claude/settings.json', async () => {
  // bridge updates the global Claude settings file without touching the project file
});
```

**Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test test/claudeSettings.test.ts test/modelSwitching.test.ts`

Expected: FAIL until the new settings helper exists.

**Step 3: Write the minimal implementation**

- Add helpers to read and write Claude JSON settings.
- Support a global file and a project-local `.claude/settings.json`.
- Resolve the effective model as project override first, then global fallback.
- Keep the existing Codex model logic unchanged.

**Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test test/claudeSettings.test.ts test/modelSwitching.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/claudeSettings.ts src/config.ts src/discordBot.ts test/claudeSettings.test.ts test/modelSwitching.test.ts docs/plans/2026-06-24-claude-cli-model-permission-design.md
git commit -m "feat: add claude settings resolution"
```

### Task 2: Claude CLI execution compatibility

**Files:**
- Modify: `src/claudeRunner.ts`
- Modify: `test/claudeRunner.test.ts`
- Modify: `test/fixtures/fake-claude.mjs`

**Step 1: Write the failing tests**

- Assert that Claude startup respects the effective model from Claude settings instead of Codex model fields.
- Assert that missing/unsupported permission requests are surfaced as diagnostics instead of silent failures.
- Assert that current stream-json parsing still succeeds with the observed Claude CLI event shapes.

**Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test test/claudeRunner.test.ts`

Expected: FAIL until the runner reads the new settings flow and handles permission events.

**Step 3: Write the minimal implementation**

- Resolve the Claude model before spawn time from the settings helpers.
- Keep `claude -p --input-format text --output-format stream-json` as the execution shape.
- Add parsing for permission-request style events and record them in stderr/hooks.

**Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test test/claudeRunner.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/claudeRunner.ts test/claudeRunner.test.ts test/fixtures/fake-claude.mjs
git commit -m "feat: harden claude cli execution"
```

### Task 3: Discord permission confirmation flow

**Files:**
- Modify: `src/discordBot.ts`
- Modify: `src/commandParser.ts`
- Modify: `src/formatters.ts`
- Modify: `src/types.ts`
- Test: `test/commandParser.test.ts`
- Test: `test/discordBridgeClaudeEngine.test.ts`

**Step 1: Write the failing tests**

- Add a test that a permission request from Claude pauses the run and posts a Discord confirmation prompt.
- Add a test that `!approve <request-id>` resumes the pending Claude run.
- Add a test that `!deny <request-id>` rejects the pending permission request.
- Add parser tests for the new Discord confirmation commands if needed.

**Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test test/commandParser.test.ts test/discordBridgeClaudeEngine.test.ts`

Expected: FAIL until the new command and pending-request flow exists.

**Step 3: Write the minimal implementation**

- Store pending Claude permission requests per conversation.
- Expose the request id and summary in Discord.
- Add `!approve` / `!deny` handling that resumes or aborts the pending request.
- Preserve existing cancel/reset/unbind behavior.

**Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test test/commandParser.test.ts test/discordBridgeClaudeEngine.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/discordBot.ts src/commandParser.ts src/formatters.ts src/types.ts test/commandParser.test.ts test/discordBridgeClaudeEngine.test.ts
git commit -m "feat: add discord approval flow for claude"
```

### Task 4: Full regression and safe rollout checks

**Files:**
- Modify: `docs/ENGINES.md`
- Modify: `docs/MACOS-deploy.md`
- Modify: `README.md`
- Test: `test/discordBridge.e2e.test.ts`
- Test: `test/modelSwitching.test.ts`
- Test: `test/claudeRunner.test.ts`
- Test: `test/discordBridgeClaudeEngine.test.ts`

**Step 1: Add end-to-end coverage**

- Bind a project to Claude and verify it uses the project `.claude/settings.json` model.
- Verify a global model update rewrites `~/.claude/settings.json`.
- Verify switching Codex -> Claude -> Codex preserves existing Codex behavior.
- Verify a Claude permission request can be approved from Discord.
- Verify cancel and restart still behave with no service crash.

**Step 2: Run the regression suite**

Run:
`npm run check`
`npm run build`
`npm test`

Expected: all pass.

**Step 3: Safe rollout**

- Restart the local macOS Bridge service only after the regression suite is green.
- Confirm the service comes back healthy before reporting success.

**Step 4: Commit**

```bash
git add README.md docs/ENGINES.md docs/MACOS-deploy.md test/discordBridge.e2e.test.ts test/modelSwitching.test.ts test/claudeRunner.test.ts test/discordBridgeClaudeEngine.test.ts
git commit -m "docs: document claude model and permission workflow"
```
