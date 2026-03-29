# Automatic Retry Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically retry any non-user-initiated Codex failure up to three total attempts, reusing the existing recovery prompt so retries continue from interrupted state when possible.

**Architecture:** Extend the existing retry loop in `src/discordBot.ts` instead of adding a second recovery path. Keep `diagnoseCodexFailure()` for retry kind classification, but introduce a broader retry-eligibility check for non-user failures so ordinary diagnostic failures also convert into recovery tasks.

**Tech Stack:** TypeScript, Node.js built-in test runner, existing fake Codex fixtures.

---

### Task 1: Add failing regression coverage for generic failure recovery

**Files:**
- Modify: `test/fixtures/fake-codex.mjs`
- Modify: `test/discordBridge.e2e.test.ts`

- [ ] **Step 1: Write the failing fixture scenario**

Add a new fake Codex scenario that fails once after emitting command/reasoning progress, then succeeds on the next invocation.

- [ ] **Step 2: Write the failing bridge test**

Add an e2e test asserting:
- the first diagnostic failure does not reply with final failure immediately,
- bridge retries automatically,
- the second invocation prompt contains the existing recovery prompt language,
- the task eventually succeeds.

- [ ] **Step 3: Run the targeted test to verify RED**

Run: `node --import tsx --test --test-concurrency=1 test/discordBridge.e2e.test.ts`
Expected: the new test fails because generic diagnostic failures are not retried yet.

### Task 2: Broaden retry eligibility without changing user-cancel semantics

**Files:**
- Modify: `src/discordBot.ts`
- Test: `test/discordBridge.e2e.test.ts`

- [ ] **Step 1: Add minimal retry-eligibility logic**

Introduce a helper in `src/discordBot.ts` that returns true for failed runs when cancellation reason is absent and the failure was not caused by `guidance`, `binding_reset`, `reset`, `unbind`, or `user_cancel`.

- [ ] **Step 2: Switch the main retry loop to use the broader eligibility check**

Keep the existing `describeRetry()` flow and recovery-task creation, but gate retries on the new broader helper instead of only `failureDiagnosis.retryable`.

- [ ] **Step 3: Preserve session-reset behavior by retry kind**

Continue using `failureDiagnosis.kind` to decide whether the next retry should drop the stored Codex thread before retrying.

- [ ] **Step 4: Run the targeted test to verify GREEN**

Run: `node --import tsx --test --test-concurrency=1 test/discordBridge.e2e.test.ts`
Expected: the new recovery test passes and existing retry tests still pass.

### Task 3: Tighten retry messaging for generic diagnostic failures

**Files:**
- Modify: `src/discordBot.ts`
- Test: `test/discordBridge.e2e.test.ts`

- [ ] **Step 1: Add a dedicated retry description branch for `diagnostic` failures**

Use recovery-focused text instead of connection-focused text so user-visible notices match the new behavior.

- [ ] **Step 2: Re-run targeted bridge tests**

Run: `node --import tsx --test --test-concurrency=1 test/discordBridge.e2e.test.ts`
Expected: all retry and recovery assertions remain green.

### Task 4: Verify type safety and focused regression suite

**Files:**
- Modify: `src/discordBot.ts`
- Modify: `test/fixtures/fake-codex.mjs`
- Modify: `test/discordBridge.e2e.test.ts`

- [ ] **Step 1: Run focused bridge regressions**

Run: `node --import tsx --test --test-concurrency=1 test/discordBridge.e2e.test.ts`
Expected: pass.

- [ ] **Step 2: Run relevant lower-level regression tests**

Run: `node --import tsx --test --test-concurrency=1 test/codexDiagnostics.test.ts test/codexAppServerClient.test.ts test/codexAppServerRunner.test.ts`
Expected: pass.

- [ ] **Step 3: Run typecheck**

Run: `npm run check`
Expected: pass.
