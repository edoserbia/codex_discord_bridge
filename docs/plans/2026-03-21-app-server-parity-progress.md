# App-Server Parity And Progress Implementation Plan

> **Execution:** REQUIRED SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bring Discord app-server execution closer to official Codex CLI behavior for normal QA flows and restore step-based live progress updates.

**Architecture:** Keep the current resilient app-server-first driver, but align app-server startup context with the bound workspace and separate streaming delta state from semantic process events. Preserve existing fallback, attachment, and guidance features while reducing unnecessary divergence in the common text-only path.

**Tech Stack:** TypeScript, Node.js, Discord.js, Node test runner

---

### Task 1: Document active debugging findings and set the execution target

**Files:**
- Modify: `.codex-plans/index.md`
- Modify: `.codex-plans/debug-discord-queue-stall/plan.md`
- Modify: `.codex-plans/debug-discord-queue-stall/findings.md`
- Modify: `.codex-plans/debug-discord-queue-stall/progress.md`

**Step 1: Update planning files**
- Record the new findings:
  - app-server child startup context differs from direct CLI execution
  - app-server delta events are incorrectly treated as semantic progress items

**Step 2: Mark the task as implementation-ready**
- Move the active task from discovery into planning/implementation.

**Step 3: Verify planning docs exist**

Run:
```bash
ls .codex-plans/debug-discord-queue-stall docs/plans
```

Expected:
- The planning task files and new docs plan files are listed.

### Task 2: Write failing tests for app-server startup context parity

**Files:**
- Modify: `test/codexAppServerClient.test.ts`
- Modify: `test/fixtures/fake-codex-app-server.mjs`

**Step 1: Write the failing test**
- Add a test proving app-server startup inherits the bound workspace as its startup `cwd`/`PWD`.
- Extend the fake fixture logging if needed so the test can observe startup context without guessing.

**Step 2: Run the targeted test to verify it fails**

Run:
```bash
node --test test/codexAppServerClient.test.ts
```

Expected:
- The new startup-context assertion fails.

**Step 3: Write the minimal implementation**
- Thread a workspace startup path into `CodexAppServerClient.start()` / transport bootstrapping.
- Start the child with `cwd` and `PWD` aligned to the binding workspace.

**Step 4: Run the targeted test to verify it passes**

Run:
```bash
node --test test/codexAppServerClient.test.ts
```

Expected:
- The new startup-context test passes and no existing client test regresses.

### Task 3: Write failing tests for progress regression and final-message semantics

**Files:**
- Modify: `test/codexAppServerClient.test.ts`
- Modify: `test/discordBridge.e2e.test.ts`
- Modify: `test/fixtures/fake-codex-app-server.mjs`

**Step 1: Write the failing tests**
- Add a client-level test proving repeated `agent.message.delta` updates do not produce multiple semantic final answer entries.
- Add an e2e regression test proving the Discord progress message does not accumulate repeated `💬` timeline items for a single growing app-server message.

**Step 2: Run the targeted tests to verify they fail**

Run:
```bash
node --test test/codexAppServerClient.test.ts test/discordBridge.e2e.test.ts
```

Expected:
- The new regression assertions fail against current behavior.

**Step 3: Write the minimal implementation**
- Separate streaming hooks from semantic final-message/result storage.
- Stop pushing timeline entries for delta-only agent/reasoning updates.
- Keep latest summary/activity refreshed.

**Step 4: Re-run the targeted tests**

Run:
```bash
node --test test/codexAppServerClient.test.ts test/discordBridge.e2e.test.ts
```

Expected:
- The new progress regression tests pass.

### Task 4: Reconcile formatters and runtime updates with the new event model

**Files:**
- Modify: `src/codexAppServerRunner.ts`
- Modify: `src/codexRunner.ts`
- Modify: `src/discordBot.ts`
- Modify: `src/formatters.ts`
- Modify: `src/types.ts` if new state fields are required

**Step 1: Adjust runtime state handling**
- Make sure `latestActivity` and summary sections still reflect active thinking/output.
- Keep `timeline` reserved for semantic process items.
- Ensure final reply still uses the correct completed answer text.

**Step 2: Run the targeted tests again**

Run:
```bash
node --test test/codexAppServerClient.test.ts test/discordBridge.e2e.test.ts
```

Expected:
- Tests stay green after formatter/runtime cleanup.

### Task 5: Full verification

**Files:**
- Modify: `src/codexAppServerClient.ts`
- Modify: `src/codexAppServerRunner.ts`
- Modify: `src/discordBot.ts`
- Modify: tests touched above

**Step 1: Run focused verification**

Run:
```bash
node --test test/codexAppServerClient.test.ts test/discordBridge.e2e.test.ts
```

Expected:
- All targeted app-server and bridge regression tests pass.

**Step 2: Run the broader project verification**

Run:
```bash
npm test
```

Expected:
- Full test suite passes.

**Step 3: Record results**
- Update `.codex-plans/debug-discord-queue-stall/progress.md` with commands and outcomes.

**Step 4: Commit**

```bash
git add docs/plans/2026-03-21-app-server-parity-progress-design.md docs/plans/2026-03-21-app-server-parity-progress.md .codex-plans/debug-discord-queue-stall/plan.md .codex-plans/debug-discord-queue-stall/findings.md .codex-plans/debug-discord-queue-stall/progress.md src/codexAppServerClient.ts src/codexAppServerRunner.ts src/discordBot.ts src/formatters.ts src/types.ts test/codexAppServerClient.test.ts test/discordBridge.e2e.test.ts test/fixtures/fake-codex-app-server.mjs
git commit -m "fix: align app-server parity and progress streaming"
```
