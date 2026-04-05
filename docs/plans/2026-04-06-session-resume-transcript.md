# Session Resume and Transcript Sync Implementation Plan

> **Execution:** REQUIRED SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a full Resume ID to `!status`, introduce bridge-aware local session CLI commands, and keep a complete Discord transcript for both Discord and local-resume turns.

**Architecture:** Keep lightweight session pointers in `state.json`, persist full transcript events as append-only JSONL files per conversation, expose a new bridge-side session control layer through the local Web API, and route local resume/send turns through the running bridge so Discord stays in sync.

**Tech Stack:** TypeScript, Node.js built-in test runner, existing Discord bridge runtime/store/web server, local HTTP API, JSONL transcript files

---

### Task 1: Record the approved design and planning artifacts

**Files:**
- Create: `docs/plans/2026-04-06-session-resume-transcript-design.md`
- Create: `docs/plans/2026-04-06-session-resume-transcript.md`
- Create: `.codex-plans/session-resume-transcript-sync/plan.md`
- Create: `.codex-plans/session-resume-transcript-sync/findings.md`
- Create: `.codex-plans/session-resume-transcript-sync/progress.md`
- Modify: `.codex-plans/index.md`

**Step 1: Save the approved design**

Write the validated design and implementation plan to the files above.

**Step 2: Verify the plan files exist**

Run: `ls docs/plans | rg '2026-04-06-session-resume-transcript'`
Expected: both new plan files are listed

**Step 3: Commit the planning files**

```bash
git add docs/plans/2026-04-06-session-resume-transcript-design.md docs/plans/2026-04-06-session-resume-transcript.md
git commit -m "docs: plan session resume transcript sync"
```

### Task 2: Write failing tests for the Resume surface

**Files:**
- Modify: `test/discordBridge.e2e.test.ts`
- Modify: `test/commandParser.test.ts` if parser coverage is needed
- Modify: `test/helpers/bridgeSetup.ts`

**Step 1: Write a failing `!status` test**

Add a test that proves `!status` includes:

- the full `codexThreadId`
- the ready-to-copy local command `bridgectl session resume <id>`
- the existing status panel details

**Step 2: Write a failing “no session yet” status test**

Add a test that proves `!status` clearly says no Resume ID exists before the first Codex turn.

**Step 3: Run the targeted tests to verify they fail**

Run: `node --import tsx --test test/discordBridge.e2e.test.ts`
Expected: failures for missing Resume section behavior

### Task 3: Implement Resume-aware status formatting and session metadata

**Files:**
- Modify: `src/formatters.ts`
- Modify: `src/types.ts`
- Modify: `src/discordBot.ts`
- Modify: `src/store.ts`

**Step 1: Extend the session metadata**

Add lightweight transcript pointer fields to `ConversationSessionState`.

**Step 2: Update `formatStatus()`**

Render a Resume section above the existing status details with:

- full Resume ID
- local command
- source conversation label

**Step 3: Keep old behavior intact**

Do not remove existing state/queue/activity details.

**Step 4: Run the targeted tests**

Run: `node --import tsx --test test/discordBridge.e2e.test.ts`
Expected: new Resume status tests pass

### Task 4: Write failing transcript persistence tests

**Files:**
- Create: `test/transcriptStore.test.ts` or similar
- Modify: `test/discordBridge.e2e.test.ts`

**Step 1: Write a failing transcript persistence test**

Assert that a successful turn appends user and assistant transcript events to a per-conversation store.

**Step 2: Write a failing Discord transcript sync test**

Assert that full assistant replies are mirrored into a persistent transcript message chain, not only the per-turn reply.

**Step 3: Write a failing local-resume transcript test**

Assert that a locally injected session turn is tagged as `local-resume` and shows up in the same transcript.

**Step 4: Run the targeted tests to verify they fail**

Run: `node --import tsx --test test/discordBridge.e2e.test.ts test/transcriptStore.test.ts`
Expected: failures for missing transcript storage/sync behavior

### Task 5: Implement transcript storage and replay-safe Discord sync

**Files:**
- Create: `src/transcriptStore.ts`
- Modify: `src/types.ts`
- Modify: `src/store.ts`
- Modify: `src/discordBot.ts`
- Modify: `src/formatters.ts` if transcript formatting helpers are useful

**Step 1: Implement append-only transcript storage**

Persist events in `data/transcripts/<conversationId>.jsonl`.

**Step 2: Record transcript events for both sides**

Log:

- user prompts from Discord
- user prompts from local resume/send
- complete assistant replies

**Step 3: Maintain Discord transcript messages**

Ensure the bridge can create, append to, and repair a transcript message chain for each conversation.

**Step 4: Preserve retry behavior**

If Discord writes fail, retry without losing transcript data.

**Step 5: Run the targeted tests**

Run: `node --import tsx --test test/discordBridge.e2e.test.ts test/transcriptStore.test.ts`
Expected: transcript tests turn green

### Task 6: Write failing tests for session Web API and local CLI

**Files:**
- Modify: `test/webServer.test.ts`
- Modify: `test/cli.test.ts`
- Modify: `test/helpers/bridgeSetup.ts`

**Step 1: Write failing Web API tests**

Add tests for:

- `GET /api/sessions/by-codex-thread/<id>`
- `POST /api/sessions/by-codex-thread/<id>/send`
- bearer auth behavior for these routes

**Step 2: Write failing CLI tests**

Add tests for:

- `bridgectl session status <id>`
- `bridgectl session send <id> "hello"`
- `bridgectl session resume <id>` bootstrap/help behavior

**Step 3: Run the targeted tests to verify they fail**

Run: `node --import tsx --test test/webServer.test.ts test/cli.test.ts`
Expected: failures for missing session API/CLI implementation

### Task 7: Implement bridge-side session control, Web API, and CLI

**Files:**
- Modify: `src/discordBot.ts`
- Modify: `src/webServer.ts`
- Modify: `src/cli.ts`
- Modify: `scripts/bridgectl` only if wrapper behavior must expand
- Modify: `src/types.ts`
- Modify: `test/cli.test.ts`
- Modify: `test/webServer.test.ts`

**Step 1: Add bridge-side session lookup by resume ID**

Resolve:

- conversation id
- binding
- workspace
- current Codex thread

from a `codexThreadId`.

**Step 2: Add a bridge-aware session send path**

Allow the bridge to enqueue a user turn into the resolved conversation with `source=local-resume`.

**Step 3: Expose authenticated Web API endpoints**

Add session lookup/send routes on the existing local admin server.

**Step 4: Extend `bridgectl`**

Support:

- `bridgectl session status <id>`
- `bridgectl session send <id> "message"`
- `bridgectl session resume <id>`

For `resume`, start with a minimal interactive loop using stdin/stdout and support `/status` plus `/exit`.

**Step 5: Run the targeted tests**

Run: `node --import tsx --test test/webServer.test.ts test/cli.test.ts test/discordBridge.e2e.test.ts`
Expected: session API/CLI tests pass

### Task 8: Verify the feature end-to-end and document operator usage

**Files:**
- Modify: `README.md`
- Modify: `docs/QUICKSTART.md`
- Modify: `docs/DEPLOYMENT.md` if local operator flow belongs there

**Step 1: Document operator usage**

Explain exactly how to:

1. run `!status`
2. copy the Resume ID or ready-made command
3. use `bridgectl session status/send/resume`
4. understand Discord transcript behavior

**Step 2: Run verification**

Run: `npm run check`
Expected: success

Run: `npm run build`
Expected: success

Run: targeted tests for the modified surfaces
Expected: success

**Step 3: Perform a local smoke test**

Verify on the local machine:

- `bridgectl session status <id>` resolves the session
- `bridgectl session send <id> "hello"` works
- `bridgectl session resume <id>` is usable locally

**Step 4: Commit and push**

```bash
git add src/transcriptStore.ts src/types.ts src/store.ts src/formatters.ts src/discordBot.ts src/webServer.ts src/cli.ts scripts/bridgectl test/transcriptStore.test.ts test/webServer.test.ts test/cli.test.ts test/discordBridge.e2e.test.ts test/helpers/bridgeSetup.ts README.md docs/QUICKSTART.md docs/DEPLOYMENT.md docs/plans/2026-04-06-session-resume-transcript-design.md docs/plans/2026-04-06-session-resume-transcript.md
git commit -m "feat: add session resume and transcript sync"
git push origin main
```
