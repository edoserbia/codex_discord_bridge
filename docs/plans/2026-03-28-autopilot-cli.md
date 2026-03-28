# Autopilot CLI Implementation Plan

> **Execution:** REQUIRED SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a local CLI that can send all existing Autopilot commands to the running bridge service while targeting a specific bound project by explicit id/name or current working directory.

**Architecture:** Extract a reusable Autopilot control layer inside the bridge, expose it through the existing authenticated local web server, and build a thin `bridgectl` client that mirrors Discord command shapes without directly mutating persisted state.

**Tech Stack:** TypeScript, Node.js built-in test runner, local HTTP API, existing bridge Autopilot/store/formatter modules

---

### Task 1: Record the approved design and planning artifacts

**Files:**
- Create: `docs/plans/2026-03-28-autopilot-cli-design.md`
- Create: `docs/plans/2026-03-28-autopilot-cli.md`

**Step 1: Save the approved design**

Write the validated design and this implementation plan to the files above.

**Step 2: Verify the plan files exist**

Run: `ls docs/plans | rg '2026-03-28-autopilot-cli'`
Expected: both new plan files are listed

**Step 3: Commit the planning files**

```bash
git add docs/plans/2026-03-28-autopilot-cli-design.md docs/plans/2026-03-28-autopilot-cli.md
git commit -m "docs: plan local autopilot cli"
```

### Task 2: Write failing tests for target resolution and the new Web API

**Files:**
- Modify: `test/webServer.test.ts`
- Modify: `test/helpers/bridgeSetup.ts`
- Modify: `test/commandParser.test.ts`
- Modify: `test/config.test.ts`
- Modify: `src/types.ts` if test-only exported request/response types are needed

**Step 1: Write failing target-resolution tests**

Add tests that prove:

- `--channel` resolves the exact binding
- `--project` resolves the exact binding
- `cwd` resolves a unique binding
- ambiguous or missing matches fail with helpful candidate info

**Step 2: Write failing Web API tests**

Add tests that prove:

- `POST /api/autopilot/command` enforces bearer auth when configured
- service-level commands succeed and return human-readable text
- project-level commands mutate the right binding via `projectName`, `channelId`, or `cwd`

**Step 3: Run the targeted tests to verify they fail**

Run: `node --import tsx --test test/webServer.test.ts test/commandParser.test.ts test/config.test.ts`
Expected: failures for missing target resolution / API behavior

### Task 3: Implement the bridge-side Autopilot control layer

**Files:**
- Modify: `src/discordBot.ts`
- Modify: `src/types.ts`
- Create: `src/autopilotControl.ts`
- Modify: `src/formatters.ts`

**Step 1: Extract reusable control operations**

Move the non-Discord-specific Autopilot command logic behind a reusable bridge control surface that returns structured results and a final message.

**Step 2: Implement target resolution**

Support:

- explicit `channelId`
- explicit `projectName`
- current working directory fallback

Return deterministic candidate errors instead of guessing.

**Step 3: Keep Discord behavior unchanged**

Update the Discord command handler to use the shared control layer while preserving the current replies and permission rules.

**Step 4: Run the targeted tests to verify they pass**

Run: `node --import tsx --test test/webServer.test.ts test/commandParser.test.ts test/config.test.ts`
Expected: target-resolution and API-adjacent tests turn green once the layer exists

### Task 4: Add the authenticated Web API for local Autopilot control

**Files:**
- Modify: `src/webServer.ts`
- Modify: `test/webServer.test.ts`

**Step 1: Add the new endpoint**

Implement `POST /api/autopilot/command`.

**Step 2: Reuse the existing auth model**

Support the same bearer-token flow the current admin API already uses.

**Step 3: Return structured control results**

Include success status, resolved target info, message text, and optional candidates.

**Step 4: Run the targeted tests**

Run: `node --import tsx --test test/webServer.test.ts`
Expected: new Web API tests pass

### Task 5: Write failing tests for the local CLI

**Files:**
- Create: `test/cli.test.ts`
- Create or modify: CLI test fixtures as needed

**Step 1: Write the failing CLI parsing/invocation tests**

Add tests that prove:

- `bridgectl autopilot status`
- `bridgectl autopilot server on`
- `bridgectl autopilot project on --project api`
- `bridgectl autopilot project status` from a bound workspace directory

all call the Web API correctly and print the returned message.

**Step 2: Write failure-path tests**

Add tests for:

- bridge unreachable
- auth failure
- ambiguous cwd resolution

**Step 3: Run the targeted CLI tests to verify they fail**

Run: `node --import tsx --test test/cli.test.ts`
Expected: failures for missing CLI implementation

### Task 6: Implement the local CLI entrypoint and config discovery

**Files:**
- Create: `src/cli.ts`
- Modify: `src/config.ts`
- Modify: `package.json`
- Modify: `test/cli.test.ts`

**Step 1: Implement CLI argv handling**

Mirror the Discord command style instead of inventing a new flag-heavy interface.

**Step 2: Implement bridge origin and auth discovery**

Load from:

- explicit env overrides
- package-root `.env`
- `~/.codex-tunning/secrets.env`
- defaults

without requiring the operator to run the CLI from the bridge repo root.

**Step 3: Call the Web API and print the returned message**

Surface useful errors directly to the operator.

**Step 4: Add package entrypoints**

Expose the CLI through package scripts and, if appropriate, a `bin` entry.

**Step 5: Run the targeted CLI tests**

Run: `node --import tsx --test test/cli.test.ts`
Expected: green CLI tests

### Task 7: Update documentation comprehensively

**Files:**
- Modify: `README.md`
- Modify: `docs/AUTOPILOT.md`
- Modify: `docs/QUICKSTART.md`
- Modify: `docs/MACOS-deploy.md`
- Modify or create: additional doc pages if the CLI needs a dedicated reference

**Step 1: Document the local CLI**

Explain:

- command shape
- targeting rules
- cwd fallback
- relation to Discord commands

**Step 2: Backfill previously shipped but under-documented behavior**

Ensure the docs clearly cover:

- file upload / download behavior
- file-name preservation and collision handling
- proxy autodetect behavior
- restart expectations and service diagnostics

**Step 3: Verify doc examples**

Check every command example against the implemented CLI and Discord syntax.

### Task 8: Full verification, service restart, and final landing

**Files:**
- Modify: only the files touched above

**Step 1: Run the full verification suite**

Run: `npm run build`
Expected: success

Run: `npm test`
Expected: all tests pass

**Step 2: Restart the bridge service safely**

Run: `./scripts/macos-bridge.sh restart`
Expected: restart completes without leaving the service unloaded

Run: `./scripts/macos-bridge.sh status`
Expected: bridge reports a running PID and healthy web panel

**Step 3: Review the working tree**

Run: `git status --short`
Expected: only intentional tracked files remain

**Step 4: Commit and push**

```bash
git add src/autopilotControl.ts src/cli.ts src/config.ts src/discordBot.ts src/formatters.ts src/types.ts src/webServer.ts package.json test/cli.test.ts test/commandParser.test.ts test/config.test.ts test/helpers/bridgeSetup.ts test/webServer.test.ts README.md docs/AUTOPILOT.md docs/QUICKSTART.md docs/MACOS-deploy.md docs/plans/2026-03-28-autopilot-cli-design.md docs/plans/2026-03-28-autopilot-cli.md
git commit -m "feat: add local autopilot cli"
git push origin main
```
