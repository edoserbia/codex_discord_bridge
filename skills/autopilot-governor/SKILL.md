---
name: autopilot-governor
description: Governance rules for Codex Discord Bridge autopilot runs. Use when an automated project iteration should choose one low-risk task, keep a lightweight task board, respect user direction, and finish with a machine-parseable AUTOPILOT_REPORT JSON block.
---

# Autopilot Governor

Use this skill only for automated project-iteration runs triggered by the bridge.

## Goals

- Make one useful, low-risk improvement per run.
- Respect the project's latest natural-language direction.
- Maintain a lightweight task board across runs through the bundled `boardctl` script.
- Leave a clear next step for the next cycle.

## Hard Rules

- Prefer one coherent task per run. If several tightly related checks or tiny fixes belong to the same chain, they may be grouped as one task.
- Prefer tests, stability, bug fixes, and small cleanup.
- Do not make broad product changes unless the project direction clearly allows it.
- If a change is risky, under-specified, or likely to need product judgment, do not implement it. Put it into the task board instead.
- Run appropriate validation before claiming success.

## Task Selection

Pick the best candidate using this order:

1. Existing `doing` item that should be closed or explicitly blocked
2. A suitable `ready` item
3. If no suitable `ready` item exists, create one based on the current prompt and repo state, then continue executing it in the same run

## Task Board

Keep the board lightweight with these categories:

- `ready`
- `doing`
- `blocked`
- `done`
- `deferred`

Do not flood the board. Prefer short, concrete task titles.

All board mutations must go through `scripts/boardctl.mjs`. Do not fake board updates only in prose or only in the final JSON.

Use these commands:

- `node <boardctl> ensure --json`
- `node <boardctl> status --json`
- `node <boardctl> list --json`
- `node <boardctl> add ready "<task title>" --notes "<optional notes>" --json`
- `node <boardctl> move "<task title or id>" doing --json`
- `node <boardctl> move "<task title or id>" done --json`
- `node <boardctl> move "<task title or id>" blocked --notes "<reason>" --json`
- `node <boardctl> update "<task title or id>" --notes "<new notes>" --json`
- `node <boardctl> remove "<task title or id>"`

The bridge prompt provides the exact absolute `boardctl` path and board file locations. Use those values directly.

## Final Output Contract

Your last model message must include an `AUTOPILOT_REPORT` JSON code block.

Required fields:

```json
{
  "goal": "string",
  "summary": "string",
  "next": "string",
  "board": {
    "ready": ["string"],
    "doing": ["string"],
    "blocked": ["string"],
    "done": ["string"],
    "deferred": ["string"]
  }
}
```

The JSON must be valid.

`goal`, `summary`, and `next` are mandatory.

`board` is optional redundancy. The real board state is the one written by `boardctl` into the project files.
