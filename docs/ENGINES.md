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

Claude global settings default to:

```text
~/.claude/settings.json
```

Set `CLAUDE_SETTINGS_PATH` if the global settings file lives somewhere else. Project overrides always live directly in the bound workspace:

```text
<workspace>/.claude/settings.json
```

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

## Claude Model Selection

Claude model switching is implemented through JSON settings files, not Claude CLI interactive model commands.

```text
!claude-model status
!claude-model set claude-opus-4-6
!claude-model project status
!claude-model project set claude-sonnet-4-6
!claude-model project clear
```

Resolution order for every Claude run:

1. `<workspace>/.claude/settings.json`
2. `CLAUDE_SETTINGS_PATH`, defaulting to `~/.claude/settings.json`
3. Claude CLI default behavior

Changing a model does not reset the Bridge conversation or the native Claude session id. A running turn keeps the model it already started with; the next Claude turn reads the latest JSON settings.

## Claude Permissions

Bridge asks Claude CLI to avoid interactive terminal prompts where possible. If Claude still emits a tool permission request, Bridge surfaces it in Discord:

```text
Claude 需要权限才能继续执行。
批准：!approve <请求ID>
拒绝：!deny <请求ID>
```

Approving writes the requested tool rule into the current project settings file only:

```json
{
  "permissions": {
    "allow": ["Bash(example:*)"],
    "deny": []
  }
}
```

If the original request had no attachments, Bridge automatically requeues the original task after approval. If the original request had attachments, Bridge asks you to resend the request so it does not reuse cleaned-up temporary files.

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
