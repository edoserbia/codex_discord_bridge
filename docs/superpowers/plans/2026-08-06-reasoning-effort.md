# Configurable Codex Reasoning Effort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `!effort` commands for global and per-project Codex reasoning effort, resolve inheritance on every turn, and pass the selected value through both Codex execution drivers.

**Architecture:** Extend the existing `!model` command and binding patterns. Keep the global setting in root-level Codex TOML, keep project overrides in Bridge state, resolve one effective value at the Discord/execution boundary, and pass it only to Codex drivers.

**Tech Stack:** TypeScript, Node.js built-in test runner, JSON Bridge state, comment-preserving TOML line helpers, Codex app-server JSON-RPC, Codex legacy CLI.

---

### Task 1: Define and parse the reasoning-effort contract

**Files:**
- Modify: `src/types.ts`
- Modify: `src/commandParser.ts`
- Modify: `test/commandParser.test.ts`

- [ ] **Step 1: Write parser tests for all valid command forms**

Cover bare/global status, global set/clear, project status/set/clear, and case normalization for all five values.

- [ ] **Step 2: Run parser tests and verify RED**

Run: `node --import tsx --test --test-concurrency=1 test/commandParser.test.ts`
Expected: new assertions fail because `!effort` is unknown.

- [ ] **Step 3: Add the shared type and parser branch**

Add `ReasoningEffort`, optional binding/source fields, and strict command-shape validation.

- [ ] **Step 4: Re-run parser tests and verify GREEN**

Run the same targeted command and require zero failures.

### Task 2: Add safe root-level TOML reads, updates, and removal

**Files:**
- Modify: `src/codexConfig.ts`
- Create: `test/codexConfig.test.ts`

- [ ] **Step 1: Write failing unit tests for TOML behavior**

Cover double/single quotes, root-only matching, comment-preserving replacement, insertion before sections, removal, empty content, missing files, and preservation of unrelated content.

- [ ] **Step 2: Run the TOML tests and verify RED**

Run: `node --import tsx --test --test-concurrency=1 test/codexConfig.test.ts`
Expected: imports or assertions fail because effort helpers do not exist.

- [ ] **Step 3: Implement generic root string-key helpers and public effort functions**

Reuse the generic helper for the existing model functions where doing so keeps current behavior unchanged. Write files atomically enough for the current single-process command path and always retain a final newline.

- [ ] **Step 4: Re-run TOML and existing model-switching tests**

Run: `node --import tsx --test --test-concurrency=1 test/codexConfig.test.ts test/modelSwitching.test.ts`
Expected: all pass.

### Task 3: Load the fallback and resolve effective effort

**Files:**
- Modify: `src/config.ts`
- Modify: `src/types.ts`
- Modify: `src/discordBot.ts`
- Modify: `test/config.test.ts`
- Modify: `test/modelSwitching.test.ts`

- [ ] **Step 1: Write failing configuration and inheritance tests**

Assert validation of `DEFAULT_CODEX_REASONING_EFFORT` and precedence across project override, TOML global, environment fallback, and absence.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --import tsx --test --test-concurrency=1 test/config.test.ts test/modelSwitching.test.ts`

- [ ] **Step 3: Implement validated config loading and effective-value resolution**

Ensure binding creation inherits model behavior as before but does not copy a global effort into a fake project override.

- [ ] **Step 4: Re-run focused tests and verify GREEN**

Require zero failures in the same files.

### Task 4: Pass effort to both Codex execution drivers

**Files:**
- Modify: `src/codexAppServerClient.ts`
- Modify: `src/codexRunner.ts`
- Modify: `test/codexAppServerClient.test.ts`
- Modify: `test/codexRunner.test.ts`

- [ ] **Step 1: Write failing app-server request assertions**

Assert that every new and resumed `turn/start` contains the effective `effort` value and omits it when unresolved.

- [ ] **Step 2: Write failing legacy argv assertions**

Assert `-c model_reasoning_effort=\"...\"` on both new and resumed invocations, with no argument when unresolved.

- [ ] **Step 3: Run both test files and verify RED**

Run: `node --import tsx --test --test-concurrency=1 test/codexAppServerClient.test.ts test/codexRunner.test.ts`

- [ ] **Step 4: Add the minimal request and argv fields**

Do not change thread creation settings, model selection, Claude CLI, or fallback behavior.

- [ ] **Step 5: Re-run both files and verify GREEN**

Require zero failures.

### Task 5: Implement Discord global/project commands and status output

**Files:**
- Modify: `src/discordBot.ts`
- Modify: `src/formatters.ts`
- Modify: `test/modelSwitching.test.ts`
- Modify: `test/formatters.test.ts`
- Modify: `test/discordBridge.e2e.test.ts`

- [ ] **Step 1: Write failing command-flow and formatter tests**

Cover status, admin-only global mutations, project mutation, clear/inheritance, preservation of project overrides after global changes, general status output, and next-turn application without active-turn cancellation.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --import tsx --test --test-concurrency=1 test/modelSwitching.test.ts test/formatters.test.ts test/discordBridge.e2e.test.ts`

- [ ] **Step 3: Implement command handlers and formatting**

Use Codex TOML helpers for global mutations and `BridgeStore.upsertBinding` for project mutations. Do not reset or cancel sessions when only effort changes.

- [ ] **Step 4: Re-run focused tests and verify GREEN**

Require zero failures.

### Task 6: Update documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/QUICKSTART.md`
- Modify: `docs/ENGINES.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Document commands and precedence**

Describe valid values, global/project storage, next-turn semantics, driver behavior, environment fallback, unsupported-model errors, and Claude non-impact.

- [ ] **Step 2: Check documentation references**

Run focused `rg` searches to confirm command spelling and value lists are consistent.

### Task 7: Full verification and independent delivery

**Files:**
- Review all changed files only.

- [ ] **Step 1: Run focused reasoning-effort tests**

Run every modified test file with test concurrency 1.

- [ ] **Step 2: Run static verification and build**

Run: `npm run check && npm run build`
Expected: both exit zero.

- [ ] **Step 3: Run the full test suite from a fresh built worktree**

Run: `npm test`
Expected: zero failures.

- [ ] **Step 4: Review scope and secrets**

Inspect `git status`, `git diff --check`, the complete diff, staged paths, and staged diff. Confirm the dirty main worktree remains untouched.

- [ ] **Step 5: Create focused commits**

Commit implementation/tests and documentation with explicit path staging. Do not stage generated outputs or unrelated files.

- [ ] **Step 6: Synchronize and push the feature branch**

Fetch the configured GitHub remote, compare the feature base with its upstream branch, then push `feature/reasoning-effort` without force.
