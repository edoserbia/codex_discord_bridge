# Persistent Run Recovery Implementation Plan

> **Execution:** REQUIRED SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persist interrupted Discord Codex work, recover it automatically after bridge restart, show the recovery flow in Discord, and keep recovery compatible with cancel and queue controls.

**Architecture:** Extend persisted state with recoverable runtime snapshots, rehydrate them at bridge startup, and represent recovery attempts as first-class prompt tasks with elevated priority. Reuse existing guidance and retry patterns so user-visible behavior stays consistent while restart survival improves.

**Tech Stack:** TypeScript, Node.js, discord.js test doubles, node:test

---

### Task 1: Define persisted runtime types

**Files:**
- Modify: `src/types.ts`
- Modify: `src/store.ts`
- Test: `test/discordBridge.e2e.test.ts`

**Step 1: Write the failing test**

Add a restart-recovery test that expects a second bridge instance to see a persisted interrupted task and continue it without resending the prompt.

**Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="restart"`  
Expected: FAIL because runtime snapshots are not persisted or restored.

**Step 3: Write minimal implementation**

Add serializable runtime snapshot types and store methods for reading/writing/removing them.

**Step 4: Run test to verify it passes**

Run the same targeted test and confirm the snapshot survives bridge recreation.

**Step 5: Commit**

Commit after the snapshot plumbing is stable.

### Task 2: Restore interrupted work on startup

**Files:**
- Modify: `src/discordBot.ts`
- Test: `test/discordBridge.e2e.test.ts`

**Step 1: Write the failing test**

Add a test that starts a long-running task, recreates the bridge, and expects a Discord recovery notice plus successful completion.

**Step 2: Run test to verify it fails**

Run the targeted test and confirm no recovery occurs.

**Step 3: Write minimal implementation**

Load runtime snapshots during bridge startup, create recovery tasks, send recovery notices, and restart queue processing.

**Step 4: Run test to verify it passes**

Run the targeted recovery test and confirm the task finishes without a second user prompt.

**Step 5: Commit**

Commit the startup recovery behavior.

### Task 3: Add recovery-aware queue priorities and cancel behavior

**Files:**
- Modify: `src/discordBot.ts`
- Modify: `src/formatters.ts`
- Test: `test/discordBridge.e2e.test.ts`

**Step 1: Write the failing test**

Add coverage showing recovery runs before ordinary queued prompts and that `!cancel` stops the recovery attempt.

**Step 2: Run test to verify it fails**

Run the targeted tests and confirm recovery is either lost or not cancellable.

**Step 3: Write minimal implementation**

Represent recovery attempts as higher-priority queued tasks and ensure `!cancel` targets them exactly like ordinary tasks.

**Step 4: Run test to verify it passes**

Run the targeted tests and verify ordering plus cancellation behavior.

**Step 5: Commit**

Commit the scheduling/cancel integration.

### Task 4: Add queue insertion control

**Files:**
- Modify: `src/commandParser.ts`
- Modify: `src/discordBot.ts`
- Modify: `src/formatters.ts`
- Test: `test/discordBridge.e2e.test.ts`

**Step 1: Write the failing test**

Add coverage for a queue subcommand that takes a queued item and inserts it into the current task flow.

**Step 2: Run test to verify it fails**

Run the targeted test and confirm the command is unsupported.

**Step 3: Write minimal implementation**

Extend `!queue` with an insertion subcommand that removes the chosen queued item and requeues it as the next guidance-style task for the current run.

**Step 4: Run test to verify it passes**

Run the targeted test and confirm the queued item is injected ahead of later queued work.

**Step 5: Commit**

Commit the queue control command.

### Task 5: Final verification and rollout

**Files:**
- Modify: `.codex-plans/persistent-run-recovery/*`

**Step 1: Run targeted and full verification**

Run:
- `npm test -- --test-name-pattern="recovery|queue"`
- `npm run check`
- `npm run build`
- `npm test`

**Step 2: Restart the local service**

Run: `./scripts/macos-bridge.sh restart`

**Step 3: Confirm live status**

Run:
- `./scripts/macos-bridge.sh service-status`
- `lsof -nP -iTCP:3769 -sTCP:LISTEN`
- `tail -n 40 logs/codex-discord-bridge.log`

**Step 4: Commit**

Commit the final rollout and push.
