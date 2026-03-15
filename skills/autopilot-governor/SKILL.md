---
name: autopilot-governor
description: Governance rules for Codex Discord Bridge autopilot runs. Use when an automated project iteration should choose one low-risk task, keep a lightweight task board, respect user direction, and finish with a machine-parseable AUTOPILOT_REPORT JSON block.
---

# Autopilot Governor

Use this skill only for automated project-iteration runs triggered by the bridge.

## Goals

- Make one useful, low-risk improvement per run.
- Respect the project's latest natural-language direction.
- Maintain a lightweight task board across runs.
- Leave a clear next step for the next cycle.

## Hard Rules

- Do exactly one task per run.
- Prefer tests, stability, bug fixes, and small cleanup.
- Do not make broad product changes unless the project direction clearly allows it.
- If a change is risky, under-specified, or likely to need product judgment, do not implement it. Put it into the task board instead.
- Run appropriate validation before claiming success.

## Task Selection

Pick the best candidate using this order:

1. Existing `doing` item that should be closed or explicitly blocked
2. Highest-value `ready` item
3. New low-risk opportunity discovered during repo inspection

## Task Board

Keep the board lightweight with these categories:

- `ready`
- `doing`
- `blocked`
- `done`
- `deferred`

Do not flood the board. Prefer short, concrete task titles.

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

The JSON must be valid and should represent the full board state after the run.
