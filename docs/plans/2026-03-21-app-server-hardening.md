# App-server Hardening Implementation Plan

> **Execution:** REQUIRED SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep the Discord bridge app-server-first while adding sticky driver visibility, richer subagent visibility, tokenized web links, and LAN web access without regressing guide or live plan behavior.

**Architecture:** Extend the existing app-server-first runtime instead of replacing it. Keep official Codex thread/turn semantics as the source of truth, add only bridge-side rendering and URL helpers, and preserve fallback and queue behavior.

**Tech Stack:** TypeScript, Node.js built-in test runner, Discord bridge runtime, local `codex` CLI app-server protocol

---

### Task 1: Record the approved design and planning state

**Files:**
- Modify: `.codex-plans/index.md`
- Modify: `.codex-plans/harden-app-server-discord-parity/plan.md`
- Modify: `.codex-plans/harden-app-server-discord-parity/findings.md`
- Modify: `.codex-plans/harden-app-server-discord-parity/progress.md`
- Create: `docs/plans/2026-03-21-app-server-hardening-design.md`
- Create: `docs/plans/2026-03-21-app-server-hardening.md`

**Step 1: Save the approved design**

Write the approved design and requirements to the plan files above.

**Step 2: Verify the planning artifacts exist**

Run: `ls .codex-plans/harden-app-server-discord-parity docs/plans`
Expected: the new plan directory and docs are present

**Step 3: Commit the planning artifacts**

```bash
git add .codex-plans/index.md .codex-plans/harden-app-server-discord-parity/plan.md .codex-plans/harden-app-server-discord-parity/findings.md .codex-plans/harden-app-server-discord-parity/progress.md docs/plans/2026-03-21-app-server-hardening-design.md docs/plans/2026-03-21-app-server-hardening.md
git commit -m "docs: plan app-server hardening pass"
```

### Task 2: Write failing tests for subagent nickname visibility and sticky driver mode

**Files:**
- Modify: `test/codexRunner.test.ts`
- Modify: `test/discordBridge.e2e.test.ts`
- Modify: `test/helpers/bridgeSetup.ts`
- Modify: `test/fixtures/fake-codex.mjs`
- Modify: `test/fixtures/fake-codex-app-server.mjs`

**Step 1: Write the failing nickname parsing/rendering tests**

Add tests proving:
- collab tool calls retain official nickname fields when present
- progress/status output includes subagent names and statuses

**Step 2: Write the failing sticky driver tests**

Add tests proving:
- the live progress card shows the active driver mode
- fallback to `legacy-exec` remains visible after subsequent progress refreshes
- fresh bridge test rigs default to `app-server`

**Step 3: Run the targeted tests to verify they fail**

Run: `node --import tsx --test test/codexRunner.test.ts test/discordBridge.e2e.test.ts`
Expected: failures for missing nickname/sticky driver behavior

**Step 4: Commit the failing tests**

```bash
git add test/codexRunner.test.ts test/discordBridge.e2e.test.ts test/helpers/bridgeSetup.ts test/fixtures/fake-codex.mjs test/fixtures/fake-codex-app-server.mjs
git commit -m "test: cover driver mode and subagent visibility"
```

### Task 3: Implement collab nickname support and sticky driver rendering

**Files:**
- Modify: `src/types.ts`
- Modify: `src/codexRunner.ts`
- Modify: `src/codexAppServerRunner.ts`
- Modify: `src/discordBot.ts`
- Modify: `src/formatters.ts`

**Step 1: Implement minimal collab metadata support**

Extend collab types and parsers to retain nickname metadata without breaking existing state parsing.

**Step 2: Implement sticky driver rendering**

Render the active driver mode in both status and progress messages, and keep fallback state visible across refreshes.

**Step 3: Keep stale subagent presentation data bounded**

Prune stale collab presentation records older than 12 hours in the bridge runtime without changing Codex protocol behavior.

**Step 4: Run the targeted tests to verify they pass**

Run: `node --import tsx --test test/codexRunner.test.ts test/discordBridge.e2e.test.ts`
Expected: green targeted tests for nickname and sticky driver coverage

**Step 5: Commit the implementation**

```bash
git add src/types.ts src/codexRunner.ts src/codexAppServerRunner.ts src/discordBot.ts src/formatters.ts test/codexRunner.test.ts test/discordBridge.e2e.test.ts test/helpers/bridgeSetup.ts test/fixtures/fake-codex.mjs test/fixtures/fake-codex-app-server.mjs
git commit -m "feat: surface driver mode and subagent names"
```

### Task 4: Write failing tests for tokenized web links and LAN access

**Files:**
- Modify: `test/webServer.test.ts`
- Modify: `test/discordBridge.e2e.test.ts`
- Modify: `test/config.test.ts`

**Step 1: Write the failing web link tests**

Add tests proving:
- default config binds the web panel for LAN access
- the web server can generate concrete local and LAN URLs
- a Discord `!web` command returns tokenized links when auth is enabled

**Step 2: Run the targeted tests to verify they fail**

Run: `node --import tsx --test test/webServer.test.ts test/discordBridge.e2e.test.ts test/config.test.ts`
Expected: failures for missing URL helper / `!web` behavior / bind defaults

**Step 3: Commit the failing tests**

```bash
git add test/webServer.test.ts test/discordBridge.e2e.test.ts test/config.test.ts
git commit -m "test: cover web links and lan access"
```

### Task 5: Implement the `!web` command and LAN-friendly web URL helpers

**Files:**
- Modify: `src/commandParser.ts`
- Modify: `src/discordBot.ts`
- Modify: `src/webServer.ts`
- Modify: `src/config.ts`
- Modify: `src/formatters.ts`
- Modify: `.env.example`
- Modify: `scripts/macos-bridge.sh`

**Step 1: Implement the command and URL helper**

Add a `!web` command that replies with ready-to-open local and LAN tokenized URLs.

**Step 2: Change LAN-related defaults safely**

Default `WEB_BIND` to `0.0.0.0`, but generate concrete user-facing URLs instead of echoing the listen host back directly.

**Step 3: Run the targeted tests to verify they pass**

Run: `node --import tsx --test test/webServer.test.ts test/discordBridge.e2e.test.ts test/config.test.ts`
Expected: green targeted tests for `!web` and LAN URL generation

**Step 4: Commit the implementation**

```bash
git add src/commandParser.ts src/discordBot.ts src/webServer.ts src/config.ts src/formatters.ts .env.example scripts/macos-bridge.sh test/webServer.test.ts test/discordBridge.e2e.test.ts test/config.test.ts
git commit -m "feat: add tokenized web links and lan access"
```

### Task 6: Full verification, deployment, and push

**Files:**
- Modify: `.codex-plans/harden-app-server-discord-parity/progress.md`

**Step 1: Run targeted and full verification**

Run:
- `node --import tsx --test test/codexRunner.test.ts test/discordBridge.e2e.test.ts test/webServer.test.ts test/config.test.ts`
- `npm run check`
- `npm test`
- `npm run build`
- `bash -n scripts/macos-bridge.sh`

Expected:
- targeted tests pass
- full test suite passes
- build succeeds
- shell script syntax check succeeds

**Step 2: Restart and inspect the local service**

Run:
- `./scripts/macos-bridge.sh restart`
- `./scripts/macos-bridge.sh service-status`

Expected:
- updated LaunchAgent process is running
- web panel URL is available

**Step 3: Update progress evidence**

Record all verification commands and outcomes in `.codex-plans/harden-app-server-discord-parity/progress.md`.

**Step 4: Commit and push**

```bash
git add .codex-plans/harden-app-server-discord-parity/progress.md src/commandParser.ts src/config.ts src/codexRunner.ts src/codexAppServerRunner.ts src/discordBot.ts src/formatters.ts src/types.ts src/webServer.ts .env.example scripts/macos-bridge.sh test/codexRunner.test.ts test/config.test.ts test/discordBridge.e2e.test.ts test/webServer.test.ts test/helpers/bridgeSetup.ts test/fixtures/fake-codex.mjs test/fixtures/fake-codex-app-server.mjs
git commit -m "fix: harden app-server discord bridge runtime"
git push
```
