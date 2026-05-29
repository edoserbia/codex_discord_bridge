# Claude Engine Adapter Implementation Plan

> **Execution:** REQUIRED SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Claude CLI as a selectable Bridge engine beside Codex with per-binding defaults, per-request overrides, and Bridge-managed cross-engine context handoff.

**Architecture:** Keep existing Codex runners intact and add a Claude runner plus a composite engine router. Persist separate native session ids for Codex and Claude, and use transcript-based continuation prompts when switching engines.

**Tech Stack:** TypeScript, Node child_process, existing Discord bridge e2e test harness, fake CLI fixtures.

---

### Task 1: Types and Parser

**Files:**
- Modify: `src/types.ts`
- Modify: `src/commandParser.ts`
- Test: `test/commandParser.test.ts`

**Steps:**
1. Add `EngineName = 'codex' | 'claude'`.
2. Add `ExecutionDriverMode = CodexDriverMode | 'claude-cli'`.
3. Add optional `engine` to `ChannelBinding` and `PromptTask`.
4. Add `claudeSessionId` and `lastEngine` to `ConversationSessionState`.
5. Parse `!bind ... --engine codex|claude`.
6. Parse `!claude <prompt>` and `!codex <prompt>` as prompt commands.
7. Run parser tests and verify new tests fail before implementation, then pass.

### Task 2: Claude Runner

**Files:**
- Create: `src/claudeRunner.ts`
- Create: `test/fixtures/fake-claude.mjs`
- Create: `test/claudeRunner.test.ts`
- Modify: `src/config.ts`
- Modify: `test/helpers/bridgeSetup.ts`

**Steps:**
1. Add config `claudeCommand`, defaulting to `claude`.
2. Write failing runner tests for new Claude session, resume, model/add-dir/permission args, and stream-json result parsing.
3. Implement `ClaudeRunner` using `claude -p --input-format text --output-format stream-json`.
4. Map binding permission settings to Claude permission modes conservatively.
5. Run `test/claudeRunner.test.ts` until green.

### Task 3: Composite Engine Driver

**Files:**
- Modify: `src/createCodexExecutionDriver.ts`
- Create: `src/engineExecutionDriver.ts`
- Modify: `src/codexRunner.ts`
- Modify: `src/codexAppServerRunner.ts`
- Modify: `src/resilientCodexExecutionDriver.ts`

**Steps:**
1. Add `engine` to run input.
2. Route `engine=codex` to the existing resilient Codex driver.
3. Route `engine=claude` to `ClaudeRunner`.
4. Ensure job metadata reports `engine` and `driverMode`.
5. Preserve existing Codex behavior when `engine` is missing.

### Task 4: Bridge Session Routing

**Files:**
- Modify: `src/discordBot.ts`
- Modify: `src/store.ts`
- Modify: `src/formatters.ts`
- Test: `test/discordBridge.e2e.test.ts`
- Test: `test/store.test.ts`

**Steps:**
1. Choose task engine from per-task override, binding default, then Codex fallback.
2. Use `codexThreadId` for Codex resume and `claudeSessionId` for Claude resume.
3. Update the matching session id after `onThreadStarted` and after run completion.
4. Set `lastEngine` after successful or attempted runs.
5. Keep reset/unbind clearing both native session ids.
6. Update status/progress labels to show engine and native session id.

### Task 5: Cross-Engine Context Handoff

**Files:**
- Create: `src/engineContext.ts`
- Create: `test/engineContext.test.ts`
- Modify: `src/discordBot.ts`
- Modify: `src/transcriptStore.ts` if needed

**Steps:**
1. Write tests for bounded transcript formatting.
2. Inject transcript context when switching engines and transcript exists.
3. Verify normal same-engine runs, including new sessions after reset, do not get context bloat.

### Task 6: Grey Verification

**Files:**
- Test: `test/discordBridge.e2e.test.ts`

**Steps:**
1. Add e2e test for binding default Claude.
2. Add e2e test for `!claude` override on a Codex-bound project.
3. Add e2e test for Codex -> Claude -> Codex continuity preserving both native ids.
4. Run focused tests.
5. Run `npm run check`, `npm run build`, and `npm test` in the worktree.
6. Do not restart the root Bridge service.
