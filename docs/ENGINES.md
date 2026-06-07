# Engine Usage

Codex Discord Bridge supports two local execution engines:

- Codex CLI, selected as `codex`
- Claude CLI, selected as `claude`

Existing bindings that do not specify an engine keep using Codex. New bindings can choose either engine.

## Configuration

The default command names are:

```dotenv
CODEX_COMMAND=codex
CLAUDE_COMMAND=claude
```

If a CLI is installed somewhere else, set the absolute path in `.env`:

```dotenv
CODEX_COMMAND=/opt/homebrew/bin/codex
CLAUDE_COMMAND=/opt/homebrew/bin/claude
```

The macOS management script accepts a machine with only one engine installed, as long as at least one of `CODEX_COMMAND` or `CLAUDE_COMMAND` resolves to an executable command.

## Bind Default Engine

Use `--engine` when binding a Discord text channel:

```text
!bind api "/path/to/workspaces/api" --engine claude --sandbox danger-full-access --approval never --search off
!bind api "/path/to/workspaces/api" --engine codex --sandbox danger-full-access --approval never --search off
```

If `--engine` is omitted, the binding defaults to Codex.

## Per-Request Override

Use a command prefix for a single request:

```text
!claude review the failing test and explain the root cause
!codex implement the patch and run the focused test
```

This does not change the channel binding. The next plain message returns to the binding default engine.

## Context Continuity

Codex and Claude do not share one native session. Codex Discord Bridge preserves continuity with three pieces of state:

- the Codex thread id
- the Claude session id
- the shared Discord transcript

When a conversation switches engines, Codex Discord Bridge injects a compact recent transcript into the new engine prompt. For example, after `codex -> claude -> codex`, the final Codex run resumes the original Codex thread and receives recent Claude-side transcript context.

`!reset` clears both native engine session ids for the current Discord channel or thread.

## Local Resume

`!status` returns the Codex Resume ID and the local command:

```text
bridgectl session resume <Resume ID>
```

This local resume path is intentionally Codex-only today. Claude continuity is maintained through the Discord-side Bridge session and Claude CLI resume id.

## Autopilot

Autopilot synthetic tasks inherit the binding default engine. If a project is bound with `--engine claude`, scheduled Autopilot work for that project uses Claude.

Manual user tasks and Autopilot tasks remain isolated in the scheduler.
