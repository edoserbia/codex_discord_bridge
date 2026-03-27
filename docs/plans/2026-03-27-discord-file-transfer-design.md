# Discord File Transfer Design

**Date:** 2026-03-27

**Goal:** Let bound Discord channels and threads accept uploaded files into the bound workspace inbox and let both users and Codex send files back to Discord through natural language or an explicit fallback command.

## Problem

The bridge already downloads Discord attachments, but it stores them under the bridge data directory instead of the bound workspace. That makes them readable by Codex during the current task, but not naturally part of the project tree the user expects to work in.

The bridge also cannot send a local file back to Discord as an attachment. The current reply path is text-only, so even if Codex generates a useful artifact, the user still has to retrieve it manually.

The user wants both directions:

- Discord uploads should land in the bound project under a stable inbox directory.
- Users should be able to say natural-language requests such as “把 report.pdf 发给我”.
- Codex should have a bridge-specific way to ask the bridge to send a file, without requiring the user to type a command.
- `!help` and the docs must clearly explain the natural-language flow and the fallback command.

## Final UX

### 1. Discord -> Workspace inbox

When a user uploads a file or image in a bound root channel or one of its threads:

- the bridge keeps the existing cached copy under `data/attachments/<conversation>/<task>/`
- the bridge also copies the uploaded file into `<workspace>/inbox/`
- filenames stay recognizable, but collisions are resolved deterministically so files are never overwritten
- images continue to be passed to Codex as image inputs
- all uploaded files remain available to Codex through the existing prompt note and allowed directory wiring

### 2. Natural-language file sending

In a bound root channel or one of its threads, users can say things like:

- `把 report.pdf 发给我`
- `把最新的截图发到这个线程`
- `把 inbox 里的 pdf 发给我`

The bridge will:

1. detect that the message is a file-send request
2. search for matching files in the bound workspace by default
3. send the file directly if there is one unambiguous match
4. reply with a numbered candidate list if there are multiple plausible matches
5. accept a follow-up choice such as `发第 2 个` or `!sendfile 2`

### 3. Explicit fallback command

Add a command fallback for deterministic operation:

- `!sendfile <name-or-relative-path>`
- `!sendfile /absolute/path/to/file`
- `!sendfile 2`

This exists for help text clarity, debugging, and cases where natural language should not be relied on.

### 4. Codex-triggered file sending

Codex should be able to ask the bridge to send a file back to Discord when the user request implies delivery, for example:

- “生成完 PDF 后发给我”
- “导出图之后直接发回这个线程”

To keep this robust, the bridge should not rely on vague free-form phrasing in the final answer. Instead, Codex gets a bridge-specific instruction surface:

- a bridge-managed skill or protocol snippet that explains how to request file delivery
- a structured output block that the bridge can parse safely

The bridge then validates the request and performs the actual Discord attachment upload.

## Search and path rules

### Default lookup

Default lookup is scoped to the bound workspace:

- search the workspace tree
- prefer files under `<workspace>/inbox/`
- then consider the rest of the bound workspace

Within the same priority tier, prefer:

1. exact filename match
2. suffix / relative-path match
3. newest modified file

### Explicit absolute paths

If the user explicitly includes an absolute path, the bridge may use it.

However, this must be restricted more tightly than workspace-local search. The approved rule is:

- workspace-scoped search requests are available to everyone in a bound channel
- explicit absolute-path sending is allowed only for admins

This preserves the requested flexibility without turning the bridge into an unrestricted file exfiltration endpoint for every channel participant.

### Multi-match behavior

If a request matches more than one file:

- do not auto-send
- reply with a numbered candidate list
- store that candidate set in short-lived conversation-local state
- let the user select by ordinal in a follow-up message or `!sendfile <number>`

Candidate rows should include:

- index
- file name
- relative workspace path when applicable
- last modified time
- file size

The shortlist should expire automatically after a short TTL, such as 10 minutes.

## Discord send behavior

The bridge needs a dedicated attachment-send path that can:

- send a single local file back to the current channel or thread
- reply to the triggering message when possible
- include a small text preface when useful
- surface clear errors for missing files, directories, oversized files, or permission-denied cases

This is separate from the existing plain-text `replyToOriginalMessage()` flow.

## Codex integration design

The bridge should expose a bridge-specific file-send instruction surface to Codex.

Recommended model:

- add a bridge-owned skill or instruction snippet injected into the Codex prompt context for bound sessions
- document that Codex can request file delivery using a structured bridge marker
- the marker contains enough information for the bridge to validate intent:
  - requested path or lookup expression
  - optional human-facing caption

The bridge parses this marker only from trusted Codex output for the active turn, validates the file request with the same rules used for user-triggered sends, and uploads the attachment.

If the structured request is ambiguous, the bridge should not guess. It should instead reply with a clarification or candidate list.

## Data model changes

The current persisted task model does not need a large schema change for inbox copies. Inbox placement can be derived at download time from:

- binding workspace path
- conversation id
- task id
- attachment name

Add only the minimal runtime state needed for file-send disambiguation:

- latest file-send candidate list per conversation
- timestamp for expiry
- metadata sufficient to resolve `send #2`

This state can stay runtime-only unless experience proves it needs persistence across bridge restarts.

## Configuration

Start simple and avoid unnecessary configurability in v1:

- default inbox path: `<workspace>/inbox/`
- default max send size: use Discord attachment limits conservatively, with a bridge-side guard and clear error message

Optional future config can be added later if needed:

- custom inbox subdirectory
- disable natural-language file-send detection
- max send size override

## Testing strategy

Add coverage for both directions and the new decision logic:

1. attachment ingestion copies files into `<workspace>/inbox/`
2. images still flow into `codex -i`
3. natural-language send request with one match uploads the file
4. multi-match request returns candidates without sending
5. selecting a candidate sends the chosen file
6. `!sendfile` command works for path and ordinal forms
7. explicit absolute path is rejected for non-admins and allowed for admins
8. Codex structured file-send request triggers bridge upload
9. `!help` includes natural-language and command usage
10. docs reflect the new inbox and send-file behaviors

## Documentation scope

The user explicitly asked for all docs to be kept in sync. Update all user-facing entry points:

- `README.md`
- `docs/QUICKSTART.md`
- `docs/DEPLOYMENT.md`
- `docs/MACOS-deploy.md`
- `!help` output

Each should explain:

- uploaded files land in `<workspace>/inbox/`
- images vs ordinary files behavior
- natural-language examples
- `!sendfile` fallback examples
- multi-match candidate behavior
- the admin-only rule for explicit absolute paths

## Recommendation

Implement this as a mixed bridge + Codex design:

- bridge owns storage, search, validation, disambiguation, and Discord upload
- Codex gets a structured way to request file delivery

This yields the best balance of predictability, safety, and natural interaction.
