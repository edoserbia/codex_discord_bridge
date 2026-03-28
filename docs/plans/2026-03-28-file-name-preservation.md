# File Name Preservation Implementation Plan

> **Execution:** REQUIRED SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Preserve original file names for inbound and outbound bridge file transfers, adding a random suffix before the extension only when a destination collision exists.

**Architecture:** Keep the current attachment and sendfile flows, but tighten the shared filename handling rules. Uploads will use a collision-safe allocator that preserves the base name where possible, and outbound sends will continue to use the resolved file basename with regression coverage to lock that behavior in.

**Tech Stack:** TypeScript, Node.js built-in test runner, existing attachment/file-transfer helpers

---

### Task 1: Add failing tests for collision-safe naming

**Files:**
- Modify: `test/fileTransfer.test.ts`
- Create: `test/attachments.test.ts`
- Test: `test/discordBridge.e2e.test.ts`

**Step 1: Write the failing tests**

- Add a unit test proving `allocateInboxFilePath()` keeps `report.pdf` when free and returns `report-<random>.pdf` when `report.pdf` already exists.
- Add an attachment test proving uploads preserve names like `Quarterly Report 终稿.pdf` and only add a random suffix when a collision exists in the cache or `inbox/`.
- Add an e2e assertion proving outbound Discord file sends use the selected file basename as the attachment name.

**Step 2: Run tests to verify they fail**

Run:

```bash
node --import tsx --test test/fileTransfer.test.ts test/attachments.test.ts test/discordBridge.e2e.test.ts
```

Expected: FAIL because current naming either numeric-suffixes collisions or over-sanitizes upload names.

### Task 2: Implement minimal naming changes

**Files:**
- Modify: `src/fileTransfer.ts`
- Modify: `src/attachments.ts`
- Modify: `src/utils.ts`

**Step 1: Update shared filename handling**

- Replace the current numeric collision allocator with a random-suffix-before-extension allocator.
- Keep the first available file at the original name.

**Step 2: Reduce filename sanitization**

- Preserve spaces and Unicode.
- Strip or replace only unsafe filesystem characters and traversal/control sequences.

**Step 3: Apply the allocator to inbound uploads**

- Use the same collision-safe allocator in the bridge cache directory and workspace `inbox/`.

### Task 3: Verify and regressions

**Files:**
- Test: `test/fileTransfer.test.ts`
- Test: `test/attachments.test.ts`
- Test: `test/discordBridge.e2e.test.ts`

**Step 1: Run targeted tests**

```bash
node --import tsx --test test/fileTransfer.test.ts test/attachments.test.ts test/discordBridge.e2e.test.ts
```

Expected: PASS

**Step 2: Run full verification**

```bash
npm run check
npm test
```

Expected: PASS
