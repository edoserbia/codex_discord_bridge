# Discord File Transfer Implementation Plan

> **Execution:** REQUIRED SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add workspace inbox syncing for Discord uploads and let users or Codex send files back to bound Discord conversations through natural language or `!sendfile`.

**Architecture:** Extend the existing attachment pipeline so uploads are cached in the bridge data directory and mirrored into `<workspace>/inbox/`. Add a dedicated file-transfer module that owns search, validation, candidate disambiguation, and Discord attachment upload. Keep natural-language routing in the bridge, but let Codex request delivery through a structured marker that the bridge validates before sending.

**Tech Stack:** TypeScript, discord.js, Node.js test runner, existing fake Discord test rig

---

### Task 1: Document the feature contract in tests before implementation

**Files:**
- Create: `test/fileTransfer.test.ts`
- Modify: `test/discordBridge.e2e.test.ts`

**Step 1: Write the failing unit tests**

Add focused tests for:

- workspace inbox path generation
- search ranking that prefers `<workspace>/inbox/`
- multi-match candidate list formatting
- explicit absolute-path admin gate

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test --test-concurrency=1 test/fileTransfer.test.ts`
Expected: FAIL because the module does not exist yet.

**Step 3: Write the failing e2e expectations**

Extend bridge e2e coverage so it expects:

- uploaded files copied into `<workspace>/inbox/`
- natural-language file send returning a Discord attachment
- multi-match returning candidates without upload
- follow-up ordinal selection sending the chosen file

**Step 4: Run test to verify it fails**

Run: `node --import tsx --test --test-concurrency=1 --test-name-pattern="attachments|send file" test/discordBridge.e2e.test.ts`
Expected: FAIL because the behavior does not exist yet.

**Step 5: Commit**

```bash
git add test/fileTransfer.test.ts test/discordBridge.e2e.test.ts
git commit -m "test: specify discord file transfer behavior"
```

### Task 2: Mirror uploaded attachments into the bound workspace inbox

**Files:**
- Modify: `src/attachments.ts`
- Modify: `src/discordBot.ts`
- Modify: `src/types.ts`
- Test: `test/discordBridge.e2e.test.ts`

**Step 1: Write the failing test**

Use the existing attachment e2e to assert that after upload:

- the bridge cache copy still exists
- a second copy exists under `<workspace>/inbox/`

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test --test-concurrency=1 --test-name-pattern="downloads attachments and forwards image files" test/discordBridge.e2e.test.ts`
Expected: FAIL because only `data/attachments/...` exists today.

**Step 3: Write minimal implementation**

Implement:

- inbox copy path generation under `<workspace>/inbox/`
- collision-safe file naming
- return inbox-local metadata alongside existing attachment metadata
- keep image detection and existing prompt wiring intact

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test --test-concurrency=1 --test-name-pattern="downloads attachments and forwards image files" test/discordBridge.e2e.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/attachments.ts src/discordBot.ts src/types.ts test/discordBridge.e2e.test.ts
git commit -m "feat: mirror discord uploads into workspace inbox"
```

### Task 3: Add a dedicated file-transfer module

**Files:**
- Create: `src/fileTransfer.ts`
- Modify: `src/types.ts`
- Test: `test/fileTransfer.test.ts`

**Step 1: Write the failing test**

Cover:

- workspace-local search
- inbox-first ranking
- exact-name and relative-path matching
- candidate list generation
- admin-only absolute path allowance

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test --test-concurrency=1 test/fileTransfer.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

Implement:

- workspace search helpers
- ranking rules
- absolute-path validation
- candidate list model
- local file validation for upload safety

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test --test-concurrency=1 test/fileTransfer.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/fileTransfer.ts src/types.ts test/fileTransfer.test.ts
git commit -m "feat: add bridge file transfer resolver"
```

### Task 4: Add Discord attachment send support and `!sendfile`

**Files:**
- Modify: `src/commandParser.ts`
- Modify: `src/discordBot.ts`
- Modify: `src/formatters.ts`
- Test: `test/commandParser.test.ts`
- Test: `test/discordBridge.e2e.test.ts`

**Step 1: Write the failing test**

Add tests for:

- `!sendfile <path>`
- `!sendfile <number>`
- Discord send path uploading a local file back to the channel

**Step 2: Run test to verify it fails**

Run:

- `node --import tsx --test --test-concurrency=1 test/commandParser.test.ts`
- `node --import tsx --test --test-concurrency=1 --test-name-pattern="send file" test/discordBridge.e2e.test.ts`

Expected: FAIL

**Step 3: Write minimal implementation**

Implement:

- parser support for `!sendfile`
- a Discord attachment-send helper in the bot
- candidate selection by ordinal
- user-facing success and error replies

**Step 4: Run test to verify it passes**

Run:

- `node --import tsx --test --test-concurrency=1 test/commandParser.test.ts`
- `node --import tsx --test --test-concurrency=1 --test-name-pattern="send file" test/discordBridge.e2e.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/commandParser.ts src/discordBot.ts src/formatters.ts test/commandParser.test.ts test/discordBridge.e2e.test.ts
git commit -m "feat: add discord sendfile command"
```

### Task 5: Add natural-language file-send routing and candidate follow-up

**Files:**
- Modify: `src/discordBot.ts`
- Modify: `src/types.ts`
- Test: `test/discordBridge.e2e.test.ts`

**Step 1: Write the failing test**

Cover:

- single-match natural-language request sends the file
- multi-match request lists candidates and does not upload
- follow-up “发第 2 个” resolves the pending candidate list
- explicit absolute path is rejected for non-admins

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test --test-concurrency=1 --test-name-pattern="send file|candidate" test/discordBridge.e2e.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

Implement:

- lightweight natural-language intent detection
- per-conversation pending candidate state with TTL
- admin gate for explicit absolute paths
- channel/thread-scoped follow-up resolution

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test --test-concurrency=1 --test-name-pattern="send file|candidate" test/discordBridge.e2e.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/discordBot.ts src/types.ts test/discordBridge.e2e.test.ts
git commit -m "feat: support natural-language discord file sending"
```

### Task 6: Let Codex request file delivery through a structured bridge marker

**Files:**
- Modify: `src/discordBot.ts`
- Modify: `src/formatters.ts`
- Possibly create: `src/bridgeFileSendProtocol.ts`
- Test: `test/discordBridge.e2e.test.ts`

**Step 1: Write the failing test**

Add a fake Codex turn that emits a final answer containing the structured file-send request and assert that the bridge uploads the target file.

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test --test-concurrency=1 --test-name-pattern="Codex.*file" test/discordBridge.e2e.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

Implement:

- a parseable structured marker format
- bridge-side validation and execution
- graceful fallback when the request is ambiguous or invalid

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test --test-concurrency=1 --test-name-pattern="Codex.*file" test/discordBridge.e2e.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/discordBot.ts src/formatters.ts src/bridgeFileSendProtocol.ts test/discordBridge.e2e.test.ts
git commit -m "feat: let codex request discord file delivery"
```

### Task 7: Update help text and all user-facing docs

**Files:**
- Modify: `README.md`
- Modify: `docs/QUICKSTART.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/MACOS-deploy.md`
- Modify: `src/formatters.ts`

**Step 1: Update docs**

Document:

- uploads land in `<workspace>/inbox/`
- natural-language file send examples
- `!sendfile` fallback command
- candidate-list behavior
- explicit absolute paths are admin-only
- Codex can send generated files back through the bridge

**Step 2: Run focused verification**

Run:

- `node --import tsx --test --test-concurrency=1 test/commandParser.test.ts`
- `node --import tsx --test --test-concurrency=1 --test-name-pattern="attachments|send file|Codex.*file" test/discordBridge.e2e.test.ts`

Expected: PASS

**Step 3: Commit**

```bash
git add README.md docs/QUICKSTART.md docs/DEPLOYMENT.md docs/MACOS-deploy.md src/formatters.ts
git commit -m "docs: document discord file transfer flows"
```

### Task 8: Run full verification and smoke the live restart-safe service behavior

**Files:**
- No new files

**Step 1: Run typecheck**

Run: `npm run check`
Expected: PASS

**Step 2: Run full test suite**

Run: `npm test`
Expected: PASS

**Step 3: Verify service path still behaves correctly**

Run:

- `./scripts/macos-bridge.sh restart`
- `./scripts/macos-bridge.sh service-status`

Expected:

- restart completes without leaving launchd unloaded
- service status reports `launchctl：已加载`
- process is running

**Step 4: Commit final stabilization changes if needed**

```bash
git add <any remaining tracked changes>
git commit -m "chore: finalize discord file transfer rollout"
```
