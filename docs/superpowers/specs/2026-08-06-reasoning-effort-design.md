# Configurable Codex Reasoning Effort Design

**Date:** 2026-08-06

## Goal

Let Discord administrators inspect and change Codex reasoning effort globally or for one bound project without editing configuration files by hand.

## User Interface

The Bridge exposes one command family:

```text
!effort status
!effort set <minimal|low|medium|high|xhigh|max|ultra>
!effort clear
!effort project status
!effort project set <minimal|low|medium|high|xhigh|max|ultra>
!effort project clear
```

The bare `!effort` command is equivalent to `!effort status`. Values are case-insensitive at the command boundary and persisted in lowercase. Any other value or command shape returns usage text that lists the supported values.

Global commands require the same Discord administrator authorization as global model changes. Project commands require an existing project binding and update only that binding.

## Configuration Sources And Precedence

The effective Codex reasoning effort for a turn is resolved in this order:

```text
project override > global model_reasoning_effort > DEFAULT_CODEX_REASONING_EFFORT > Codex default
```

- A project override is stored in `ChannelBinding.codex.reasoningEffort` with `reasoningEffortScope: 'project'`.
- The global value is the root-level `model_reasoning_effort` key in the configured Codex TOML file, normally `~/.codex/config.toml`.
- `DEFAULT_CODEX_REASONING_EFFORT` is an optional process fallback for installations whose TOML has no root-level value.
- When all three sources are absent, Bridge omits the setting and lets Codex select its own default.

Global changes do not rewrite or remove existing project overrides. Clearing a project override immediately restores inheritance from the current global/fallback value. Clearing the global value removes the root-level TOML key while preserving unrelated TOML content, comments, sections, and project overrides.

## Persistence

Bridge binding state owns project overrides. Project directories and project-local `.codex/config.toml` files are not modified.

Global reads, updates, and removals operate only before the first TOML section header. Quoted strings are decoded using the same rules as the existing global model helper. Updates preserve indentation and trailing comments on an existing key. New keys are inserted before the first section. Removal deletes only the matching root-level line.

## Runtime Behavior

Bridge resolves effective effort immediately before each Codex turn. A command never interrupts a running turn; the new value applies to the next turn submitted after the command completes.

- App-server driver: include `effort` in every `turn/start` request. Thread creation remains unchanged because the turn field is the per-turn source of truth.
- Legacy exec driver: include `-c model_reasoning_effort=\"<value>\"` in both new and resumed executions.
- Claude CLI driver: do not read or pass this setting.

Bridge accepts `xhigh`, `max`, and `ultra` without model-specific filtering. If the selected Codex model rejects an effort value, Bridge surfaces the native Codex error instead of silently downgrading it.

## Status And Help

`!effort status` shows the configured global value, its source (`config.toml`, environment fallback, or Codex default), and the effective value for the current binding when one can be resolved.

`!effort project status` shows the project's explicit override or states that it inherits, then shows the effective value and its source. The general `!status` panel also includes the effective Codex effort so operators can confirm what the next turn will use.

Help and user/operations documentation list the complete command family, valid values, precedence, next-turn semantics, and the fact that Claude is unaffected.

## Compatibility And Migration

Existing persisted bindings do not contain the new optional fields and continue to load without migration. Existing `model_reasoning_effort` values written outside Bridge are recognized. Unsupported or malformed global values are displayed as unconfigured for Bridge execution rather than forwarded as an unvalidated effort.

## Testing

- Parser tests cover every command form, case normalization, missing values, invalid values, and invalid trailing tokens.
- TOML tests cover root-only reads, comment-preserving replacement, insertion, removal, missing files, and unrelated section preservation.
- Configuration and resolution tests cover project/global/environment/Codex-default precedence.
- Discord tests cover status, global set/clear, project set/clear, preserved overrides, authorization, and next-turn behavior.
- App-server tests assert `turn/start.params.effort` for new and resumed threads.
- Legacy tests assert the config override in new and resumed argv.
- Existing Claude tests confirm Codex reasoning effort does not alter Claude invocation.

## Non-Goals

- No model capability probing or automatic effort downgrade.
- No interruption or restart of an active turn.
- No project-local Codex TOML writes.
- No change to Claude reasoning configuration.
- No Discord UI component or web dashboard editor in this iteration.
