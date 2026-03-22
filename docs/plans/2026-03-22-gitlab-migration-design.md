# GitLab Migration Design

**Date:** 2026-03-22

**Goal:** Migrate all Git repositories managed by `codex-discord-bridge` and all current OpenClaw agent-managed projects from legacy or inconsistent remotes to the user's self-hosted GitLab, while also updating stable OpenClaw task and memory sources so future agent behavior consistently uses GitLab.

## Scope

This design covers two related but different migration surfaces.

### 1. Managed Git repositories

The migration must update Git remotes for:

- All projects bound in `codex-discord-bridge` state at `data/state.json`
- `/Users/mac/.openclaw` itself, because it is both a managed project and an OpenClaw state root
- Any additional current project roots discoverable from stable OpenClaw task and memory sources

The migration must normalize these repositories to the user's self-hosted GitLab using environment-provided configuration.

### 2. Stable OpenClaw guidance and task sources

The migration must update stable, still-effective OpenClaw sources that influence future agent behavior:

- `~/.openclaw/cron/jobs.json`
- `~/.openclaw/workspace*/TOOLS.md`
- `~/.openclaw/workspace*/MEMORY.md`
- `~/.openclaw/workspace*/HEARTBEAT.md`
- `~/.openclaw/workspace*/WORKFLOW_AUTO.md`
- `~/.openclaw/workspace*/todo.db`
- `~/.openclaw/memory/*.sqlite`

The migration must not rewrite historical session archives or deleted/reset/backup transcript files.

## Explicit Non-Goals

The migration will not:

- Rewrite `~/.openclaw/agents/*/sessions/*`
- Rewrite deleted/reset/backup conversation archives
- Rewrite general historical artifacts unless they contain still-effective operational guidance
- Automatically push local working tree content unless later requested

## Current Baseline

At design time, the repository inspection found:

- `codex-discord-bridge` has 13 bound workspaces in `data/state.json`
- Most bound repositories already point at the self-hosted GitLab host `38.76.206.9`
- There are still inconsistent cases:
  - `/Users/mac/work/su/email_server` uses a GitLab URL but the remote name is `gitee`
  - `/Users/mac/work/su/csq/202509-30w` still points to real Gitee over HTTPS
- Two bound directories are not Git repositories yet:
  - `/Users/mac/work/su/email_account_creator`
  - `/Users/mac/work/su/codex_tmp`
- `/Users/mac/.openclaw` is already a Git repository and must be migrated like any other managed repo
- OpenClaw workspace `TOOLS.md` files are already mostly aligned to the self-hosted GitLab
- OpenClaw vector memory databases currently show no `gitee` hits in `chunks.text`, so they likely need validation more than bulk rewrite

## Configuration Source

GitLab settings must come from existing environment variables loaded from the user's shell environment, including the self-hosted file sourced by `~/.zprofile`.

The migration must consume runtime environment data rather than hardcoding values into the repository.

Expected variables include:

- `GITLAB_URL`
- `GITLAB_API_BASE_URL`
- `GITLAB_TOKEN` or `GITLAB_PRIVATE_TOKEN`
- `SELFHOST_GITLAB_DEFAULT_NAMESPACE`
- `SELFHOST_GITLAB_SSH_CLONE_PREFIX`
- related `GLAB_*` variables if needed for verification

## Discovery Model

The migration needs a single discovery pass that aggregates candidate projects from both bridge state and OpenClaw stable guidance.

### Bridge-managed repositories

Use `data/state.json` as the authority for `codex-discord-bridge` bindings. Each `bindings[*].workspacePath` is a candidate project root.

### OpenClaw-managed repositories

Scan the following stable sources:

- `~/.openclaw/cron/jobs.json`
- workspace `MEMORY.md`
- workspace `HEARTBEAT.md`
- workspace `WORKFLOW_AUTO.md`
- workspace `TOOLS.md`
- workspace `todo.db` rows in active states (`pending`, `in_progress`)

Discovery must extract:

- absolute filesystem paths under `/Users/mac/work` or `/Users/mac/.openclaw`
- repository URLs such as `git@...` or `https://...`

### Project root normalization

Each extracted path must be normalized to an actual repository root:

- if the path is a file, walk upward until the containing Git root is found
- if the path is a directory, prefer that directory; if it is inside a repository, resolve to the repo root
- if no repository exists but the path is clearly a project root, keep it as a non-Git candidate for initialization

This avoids treating every referenced subdirectory or file as a separate project.

## Remote Migration Rules

For each normalized project root:

### Existing Git repository

1. Inspect all remotes
2. Determine the current default remote:
   - prefer `origin`
   - otherwise detect legacy names such as `gitee`
3. Derive the intended target GitLab repository identity
4. Ensure that repository exists on self-hosted GitLab
5. Normalize remotes:
   - if `origin` exists but points to the wrong host, set it to the GitLab SSH URL
   - if only `gitee` exists and its URL already points to GitLab, rename it to `origin`
   - if both `origin` and `gitee` exist and they resolve to the same GitLab target, remove `gitee`
   - preserve unrelated extra remotes

### Non-Git project root

Only when the path is confidently a project root:

1. `git init -b main`
2. create the target private GitLab repository
3. add `origin`

The migration must not initialize random directories discovered only as historical or incidental references.

## Repository Naming Rules

Repository naming should prefer continuity:

- if a current remote already encodes a repository name, reuse it
- otherwise use the directory basename
- for `/Users/mac/.openclaw`, preserve its existing repository identity if a stable one already exists on GitLab

The migration must not fabricate names from project labels when a repository basename or remote-derived name is already available.

## Freshness Arbitration

Changing the remote URL alone is insufficient. The user explicitly wants the migration to compare local and remote freshness and keep the newer side.

For each project, compare:

- local current branch
- existing remote tracking branch, whether from Gitee or current GitLab
- target GitLab branch, if the target repository already exists

### Preferred rule

Use commit ancestry first:

- if one side is an ancestor of the other, the descendant side wins
- if the target GitLab branch does not yet exist, create it from the winning side

If histories diverge and neither side is ancestor of the other:

- use the most recent commit time as the winner
- before applying the winner, create a safety backup branch or tag for the losing history

This matches the user's instruction to "use the newer one" while avoiding destructive history loss without a backup.

## Stable Guidance Rewrite Rules

The migration must update still-effective OpenClaw guidance so future agents stop referring to Gitee or inconsistent remotes.

### Rewrite targets

- `cron/jobs.json`
- `TOOLS.md`
- `MEMORY.md`
- `HEARTBEAT.md`
- `WORKFLOW_AUTO.md`
- `todo.db` active task rows when they contain explicit remote instructions
- `memory/*.sqlite` only if they contain active remote instructions

### Rewrite style

Only update explicit operational guidance, for example:

- "push to Gitee"
- `https://gitee.com/...`
- `git@gitee.com:...`
- remote naming rules that still require `gitee`

Do not rewrite general project history or narrative content unless that text would still misdirect future agent behavior.

## Safety and Backups

The migration touches repositories and user state, so it needs explicit safeguards.

### Before changes

- generate an inventory report of discovered projects and source files
- back up each stable file before editing:
  - `cron/jobs.json`
  - rewritten `*.md`
  - rewritten `todo.db`
  - rewritten `memory/*.sqlite`

### During changes

- make the migration idempotent
- never point a local repo at a GitLab URL until the destination repository is confirmed to exist
- isolate per-project failures and continue processing others

### On divergence

- create a safety branch or tag for the losing side before updating GitLab from the winning side

## Verification

Successful migration must prove both repository state and guidance state.

### Repository verification

- every managed repository resolves to a GitLab remote on the self-hosted host
- no bridge-managed repository still points to real Gitee
- non-Git managed projects that were approved for initialization now have `origin`

### Guidance verification

- rescanning stable OpenClaw sources should find no `gitee.com` operational references
- `cron/jobs.json` remains valid JSON
- rewritten SQLite databases remain queryable
- rewritten FTS-backed memory databases still return consistent counts and searchable content

## Recommended Implementation Shape

Implement this as a one-shot migration script plus a verification/reporting pass.

Reasons:

- it is easier to audit than embedding migration logic into runtime startup
- it can be rerun safely after environment or repository changes
- it centralizes discovery, reconciliation, rewrite rules, backup creation, and reporting

## Result

After migration:

- `codex-discord-bridge` managed repositories use self-hosted GitLab consistently
- `.openclaw` itself is normalized as a GitLab-backed repository
- agent task and memory sources stop instructing future work against Gitee
- current OpenClaw-managed project repositories are normalized to GitLab as well
- when local and remote histories differ, the newer side wins, with backup protection for the loser
