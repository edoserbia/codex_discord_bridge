# GitLab Migration Implementation Plan

> **Execution:** REQUIRED SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build and run a safe migration flow that discovers all current bridge-managed and OpenClaw-managed projects, migrates their Git remotes to the user's self-hosted GitLab, and rewrites stable OpenClaw guidance so future agent behavior consistently uses GitLab.

**Architecture:** Add a dedicated migration script that reads bridge state and stable OpenClaw sources, normalizes discovered project paths to repository roots, reconciles local and remote freshness, creates or updates GitLab repositories, and rewrites stable guidance files with backups. Keep discovery, GitLab API access, repository reconciliation, stable file rewrites, and verification/reporting as separate units so the migration stays auditable and rerunnable.

**Tech Stack:** Node.js, TypeScript, existing project build/test setup, `git`, `sqlite3`, GitLab HTTP API, JSON/Markdown/SQLite file handling

---

### Task 1: Capture migration entrypoint and config contract

**Files:**
- Create: `src/gitlabMigration.ts`
- Modify: `src/config.ts`
- Modify: `src/types.ts`
- Test: `test/gitlabMigration.test.ts`

**Step 1: Write the failing test**

Add tests that expect config loading to expose the GitLab values needed by the migration layer:

- API base URL
- token
- default namespace
- SSH clone prefix

Also add a failing test that expects migration config validation to reject missing required values.

**Step 2: Run test to verify it fails**

Run: `npm test -- --runInBand test/gitlabMigration.test.ts`

Expected: FAIL because the migration config type and loader do not exist yet.

**Step 3: Write minimal implementation**

- Extend config loading in `src/config.ts`
- Add explicit migration config types in `src/types.ts` or `src/gitlabMigration.ts`
- Parse values from existing environment variables without hardcoding host details

**Step 4: Run test to verify it passes**

Run: `npm test -- --runInBand test/gitlabMigration.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/config.ts src/types.ts src/gitlabMigration.ts test/gitlabMigration.test.ts
git commit -m "feat: add gitlab migration config loading"
```

### Task 2: Discover bridge-managed project roots

**Files:**
- Modify: `src/gitlabMigration.ts`
- Test: `test/gitlabMigration.test.ts`

**Step 1: Write the failing test**

Add a test fixture for `data/state.json`-shaped content and assert that the migration layer extracts all `bindings[*].workspacePath` values as candidate project roots.

**Step 2: Run test to verify it fails**

Run: `npm test -- --runInBand test/gitlabMigration.test.ts`

Expected: FAIL because bridge discovery is not implemented.

**Step 3: Write minimal implementation**

Implement a helper that:

- reads bridge state JSON
- extracts bound workspaces
- records the source as `bridge-binding`

**Step 4: Run test to verify it passes**

Run: `npm test -- --runInBand test/gitlabMigration.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/gitlabMigration.ts test/gitlabMigration.test.ts
git commit -m "feat: discover bridge managed project roots"
```

### Task 3: Discover stable OpenClaw task and memory references

**Files:**
- Modify: `src/gitlabMigration.ts`
- Test: `test/gitlabMigration.test.ts`

**Step 1: Write the failing test**

Add fixtures that simulate:

- `cron/jobs.json`
- `MEMORY.md`
- `HEARTBEAT.md`
- `WORKFLOW_AUTO.md`
- `TOOLS.md`
- `todo.db`

Assert that only stable sources are scanned and that backup/session/archive paths are excluded.

**Step 2: Run test to verify it fails**

Run: `npm test -- --runInBand test/gitlabMigration.test.ts`

Expected: FAIL because OpenClaw source scanning does not exist.

**Step 3: Write minimal implementation**

Implement stable-source discovery that:

- scans the allowed file set
- excludes `sessions`, `*.backup*`, `*.deleted*`, `*.reset*`, and obvious historical directories
- extracts absolute paths and remote URLs from text
- queries `todo.db` active rows (`pending`, `in_progress`)

**Step 4: Run test to verify it passes**

Run: `npm test -- --runInBand test/gitlabMigration.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/gitlabMigration.ts test/gitlabMigration.test.ts
git commit -m "feat: scan stable openclaw project references"
```

### Task 4: Normalize discovered references to repository roots

**Files:**
- Modify: `src/gitlabMigration.ts`
- Test: `test/gitlabMigration.test.ts`

**Step 1: Write the failing test**

Add test cases for:

- file path inside a repository
- nested directory inside a repository
- explicit repository root
- non-Git directory that should remain a project candidate
- duplicate references collapsing into one root

**Step 2: Run test to verify it fails**

Run: `npm test -- --runInBand test/gitlabMigration.test.ts`

Expected: FAIL because path normalization is not implemented.

**Step 3: Write minimal implementation**

Implement root normalization helpers that:

- walk upward to find `.git`
- preserve explicit non-Git roots when they are likely projects
- deduplicate by resolved absolute path

**Step 4: Run test to verify it passes**

Run: `npm test -- --runInBand test/gitlabMigration.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/gitlabMigration.ts test/gitlabMigration.test.ts
git commit -m "feat: normalize migration candidates to repo roots"
```

### Task 5: Add GitLab repository lookup and creation client

**Files:**
- Modify: `src/gitlabMigration.ts`
- Test: `test/gitlabMigration.test.ts`

**Step 1: Write the failing test**

Mock GitLab HTTP responses and add tests for:

- finding an existing project by namespace and name
- creating a missing private project
- surfacing API failures without mutating local repo state

**Step 2: Run test to verify it fails**

Run: `npm test -- --runInBand test/gitlabMigration.test.ts`

Expected: FAIL because the GitLab client does not exist.

**Step 3: Write minimal implementation**

Implement a small GitLab API layer that:

- searches for or resolves the target project
- creates the project if missing
- returns canonical project metadata, especially `path_with_namespace` and SSH URL

**Step 4: Run test to verify it passes**

Run: `npm test -- --runInBand test/gitlabMigration.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/gitlabMigration.ts test/gitlabMigration.test.ts
git commit -m "feat: add gitlab project reconciliation client"
```

### Task 6: Implement remote normalization for existing Git repositories

**Files:**
- Modify: `src/gitlabMigration.ts`
- Test: `test/gitlabMigration.test.ts`

**Step 1: Write the failing test**

Add repository command tests or command-plan tests for these cases:

- `origin` points to non-target host
- only `gitee` exists but already points to GitLab
- both `origin` and `gitee` exist and resolve to the same GitLab repo
- unrelated extra remotes remain untouched

**Step 2: Run test to verify it fails**

Run: `npm test -- --runInBand test/gitlabMigration.test.ts`

Expected: FAIL because remote normalization is not implemented.

**Step 3: Write minimal implementation**

Implement remote normalization logic that:

- prefers `origin`
- renames `gitee` to `origin` when appropriate
- removes redundant `gitee`
- sets `origin` to the canonical GitLab SSH URL

**Step 4: Run test to verify it passes**

Run: `npm test -- --runInBand test/gitlabMigration.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/gitlabMigration.ts test/gitlabMigration.test.ts
git commit -m "feat: normalize git remotes to self hosted gitlab"
```

### Task 7: Implement non-Git project initialization

**Files:**
- Modify: `src/gitlabMigration.ts`
- Test: `test/gitlabMigration.test.ts`

**Step 1: Write the failing test**

Add tests that verify:

- clearly identified project roots are initialized with `git init -b main`
- GitLab project creation happens before adding `origin`
- ambiguous paths are rejected instead of initialized

**Step 2: Run test to verify it fails**

Run: `npm test -- --runInBand test/gitlabMigration.test.ts`

Expected: FAIL because non-Git initialization does not exist.

**Step 3: Write minimal implementation**

Implement guarded non-Git initialization logic with explicit path checks and canonical `origin` setup.

**Step 4: Run test to verify it passes**

Run: `npm test -- --runInBand test/gitlabMigration.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/gitlabMigration.ts test/gitlabMigration.test.ts
git commit -m "feat: initialize managed non-git projects for migration"
```

### Task 8: Implement freshness arbitration and backup-on-divergence

**Files:**
- Modify: `src/gitlabMigration.ts`
- Test: `test/gitlabMigration.test.ts`

**Step 1: Write the failing test**

Add tests for:

- fast-forward local over remote
- fast-forward remote over local
- GitLab target missing branch
- diverged local and remote histories where the newer commit time wins
- creation of a backup branch or tag for the losing side

**Step 2: Run test to verify it fails**

Run: `npm test -- --runInBand test/gitlabMigration.test.ts`

Expected: FAIL because freshness arbitration does not exist.

**Step 3: Write minimal implementation**

Implement comparison logic that:

- uses ancestry first
- falls back to newest commit time for divergence
- writes a safety backup reference before applying the winner

**Step 4: Run test to verify it passes**

Run: `npm test -- --runInBand test/gitlabMigration.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/gitlabMigration.ts test/gitlabMigration.test.ts
git commit -m "feat: arbitrate repo freshness during gitlab migration"
```

### Task 9: Rewrite stable OpenClaw guidance sources with backups

**Files:**
- Modify: `src/gitlabMigration.ts`
- Test: `test/gitlabMigration.test.ts`

**Step 1: Write the failing test**

Add tests that verify:

- `cron/jobs.json` guidance text rewrites old Gitee instructions
- Markdown guidance files rewrite explicit remote instructions only
- `todo.db` active rows update explicit Gitee remote instructions
- backups are created before rewrite
- excluded historical files are untouched

**Step 2: Run test to verify it fails**

Run: `npm test -- --runInBand test/gitlabMigration.test.ts`

Expected: FAIL because stable guidance rewrite does not exist.

**Step 3: Write minimal implementation**

Implement targeted rewrite helpers for JSON, Markdown, and SQLite task rows. Keep the transformations narrow and auditable.

**Step 4: Run test to verify it passes**

Run: `npm test -- --runInBand test/gitlabMigration.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/gitlabMigration.ts test/gitlabMigration.test.ts
git commit -m "feat: rewrite stable openclaw git guidance"
```

### Task 10: Add OpenClaw vector-memory rewrite support

**Files:**
- Modify: `src/gitlabMigration.ts`
- Test: `test/gitlabMigration.test.ts`

**Step 1: Write the failing test**

Add tests that verify:

- `memory/*.sqlite` rows are updated only when they contain explicit stale remote guidance
- FTS content remains queryable after rewrite
- databases with zero hits are left untouched

**Step 2: Run test to verify it fails**

Run: `npm test -- --runInBand test/gitlabMigration.test.ts`

Expected: FAIL because vector-memory rewrite support does not exist.

**Step 3: Write minimal implementation**

Implement SQLite update helpers that:

- update matching `chunks.text`
- refresh associated FTS content
- skip databases with no matches

**Step 4: Run test to verify it passes**

Run: `npm test -- --runInBand test/gitlabMigration.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/gitlabMigration.ts test/gitlabMigration.test.ts
git commit -m "feat: support openclaw memory sqlite git guidance rewrites"
```

### Task 11: Add migration reporting and dry-run support

**Files:**
- Modify: `src/gitlabMigration.ts`
- Modify: `src/index.ts`
- Test: `test/gitlabMigration.test.ts`

**Step 1: Write the failing test**

Add tests that verify:

- dry-run produces a full inventory without mutating repositories or files
- final reports list migrated repositories, initialized repositories, created GitLab projects, rewritten files, and failures

**Step 2: Run test to verify it fails**

Run: `npm test -- --runInBand test/gitlabMigration.test.ts`

Expected: FAIL because reporting and dry-run support do not exist.

**Step 3: Write minimal implementation**

Expose a migration runner that can:

- run discovery only
- run full migration
- emit structured and readable summaries

Decide whether this lives behind a script entrypoint or a temporary CLI command in `src/index.ts`.

**Step 4: Run test to verify it passes**

Run: `npm test -- --runInBand test/gitlabMigration.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/gitlabMigration.ts src/index.ts test/gitlabMigration.test.ts
git commit -m "feat: add gitlab migration reporting and dry run"
```

### Task 12: Verify against the real local inventory

**Files:**
- Modify: `README.md`
- Test: `test/gitlabMigration.test.ts`

**Step 1: Write the failing test**

Add one integration-style test or command-plan test that validates the final verification rules:

- bridge-bound repos have no remaining Gitee URLs
- stable OpenClaw sources have no operational `gitee.com` references
- rewritten JSON and SQLite files are valid after migration

**Step 2: Run test to verify it fails**

Run: `npm test -- --runInBand test/gitlabMigration.test.ts`

Expected: FAIL because the final verification flow is incomplete.

**Step 3: Write minimal implementation**

- add final verification helpers
- document the migration command and verification command in `README.md`

**Step 4: Run test to verify it passes**

Run: `npm test -- --runInBand test/gitlabMigration.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add README.md src/gitlabMigration.ts test/gitlabMigration.test.ts
git commit -m "docs: add gitlab migration verification flow"
```
