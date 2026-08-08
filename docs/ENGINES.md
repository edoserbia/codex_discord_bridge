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

## Codex Reasoning Effort

Codex accepts seven reasoning effort values: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`. Discord administrators can manage the global value or a project override:

```text
!effort status
!effort set <minimal|low|medium|high|xhigh|max|ultra>
!effort clear
!effort project status
!effort project set <minimal|low|medium|high|xhigh|max|ultra>
!effort project clear
```

The effective value is resolved for every Codex turn in this order:

1. Project override in Bridge binding state (`reasoningEffortScope: "project"`)
2. Root-level `model_reasoning_effort` in `CODEX_CONFIG_PATH` or `~/.codex/config.toml`
3. `DEFAULT_CODEX_REASONING_EFFORT`
4. Codex's own default

Global edits preserve unrelated TOML content and project overrides. Project edits do not touch project-local Codex configuration. A change never interrupts an active turn; it applies to the next turn. The app-server driver sends `effort` on `turn/start`, while legacy-exec sends `-c model_reasoning_effort="<value>"` for both new and resumed runs. Claude CLI does not read this Codex-only setting.

## Per-Request Override

Use a command prefix for a single request:

```text
!claude review the failing test and explain the root cause
!codex implement the patch and run the focused test
```

This does not change the channel binding. The next plain message returns to the binding default engine.

## Engine-aware Model Selection

The generic command follows the current binding engine:

```text
!model status
!model set <model>
!model project status
!model project set <model>
!model project clear
```

Use an explicit selector to manage either engine from any bound context:

```text
!model codex status
!model codex set gpt-5.5
!model claude status
!model claude set claude-opus-4-6
!model claude project set claude-sonnet-4-6
```

`!claude-model ...` remains a compatibility alias. Claude model switching uses JSON settings files, not Claude CLI interactive model commands.

Resolution order for every Claude run:

1. `<workspace>/.claude/settings.json`
2. `CLAUDE_SETTINGS_PATH`, defaulting to `~/.claude/settings.json`
3. Claude CLI default behavior

Changing a model does not reset the Bridge conversation or the native Claude session id. A running turn keeps the model it already started with; the next Claude turn reads the latest JSON settings.

Claude live progress uses official Claude CLI `stream-json` plus `--include-partial-messages`. The Discord progress card updates with cumulative reply drafts, Bash commands, and tool results before the final result arrives.

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
