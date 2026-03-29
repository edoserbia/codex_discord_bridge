# Autopilot CLI Design

**Date:** 2026-03-28

**Goal:** Add a local CLI for all Autopilot commands that targets a specific bound project, reuses the running bridge service as the single source of truth, and does not regress existing Discord workflows or service restart reliability.

## Problem

Today, all Autopilot control flows are exposed through Discord commands inside a bound project channel or Autopilot thread. That works well remotely, but it is awkward for local operators who want to:

- manage Autopilot from a terminal
- script project-level Autopilot operations
- let each project keep its own cadence and prompt without manually editing files
- use the same Autopilot control surface whether they are at the desktop or on mobile

The bridge already has the right runtime model, state store, and Autopilot scheduling behavior. What is missing is a local control surface that can address the same live bridge process without creating a second source of truth.

## Constraints

- Do not directly mutate `data/state.json` from the CLI.
- Do not create a separate Autopilot runtime outside the running bridge process.
- Preserve all existing Discord command behavior.
- Preserve current service start/restart behavior on macOS.
- Allow project targeting by:
  - explicit `--channel <channel-id>`
  - explicit `--project <project-name>`
  - current working directory fallback when the target is uniquely inferable
- Document the new local CLI comprehensively, and also backfill missing documentation for previously shipped features.

## Approaches Considered

### Approach A: Local CLI talks to the running bridge Web API

Add a new authenticated Autopilot API to the existing local admin web server and build a CLI that calls it.

Pros:

- Keeps the running bridge as the only control plane
- Shares the same state, scheduler, and validation logic as Discord
- Avoids direct file mutation races
- Easy to support structured responses and future automation

Cons:

- Requires extending the web server surface
- Requires a local auth and config-loading story for the CLI

### Approach B: Local CLI synthesizes Discord-like messages

Build a CLI that feeds fake Discord command messages into the current Discord command handler.

Pros:

- Reuses more of the current code path directly

Cons:

- Couples the CLI to Discord-only concepts like message objects and reply behavior
- Makes project targeting awkward
- Harder to return structured output
- Dirtier long-term architecture

### Approach C: Local CLI edits persisted Autopilot state directly

Let the CLI rewrite `data/state.json` and project board files itself.

Pros:

- No bridge API changes required

Cons:

- Creates race conditions with the running bridge
- Can drift from live in-memory scheduling state
- Most likely to break service behavior

## Recommendation

Use **Approach A**.

The bridge process should remain the only actor that mutates live Autopilot state. The CLI should be a thin local client over a new authenticated control API.

## Command Shape

Use a CLI shape that mirrors Discord as closely as possible:

```bash
bridgectl autopilot status
bridgectl autopilot server on
bridgectl autopilot server concurrency 3
bridgectl autopilot project on --project api
bridgectl autopilot project interval 30m --project api
bridgectl autopilot project prompt "优先补测试和稳定性，不要做大功能" --project api
bridgectl autopilot project run --project api
```

Project targeting rules:

1. `--channel <channel-id>` wins
2. `--project <project-name>` next
3. Otherwise use the current working directory
4. If zero or multiple matches remain, fail with candidates instead of guessing

## Architecture

### 1. Extract an internal Autopilot control layer

The current Autopilot command behavior lives inside Discord message handling. That is the wrong abstraction boundary for a local CLI.

Introduce a reusable bridge-side control layer that:

- resolves the target project
- executes Autopilot service-level actions
- executes Autopilot project-level actions
- returns structured results plus human-readable text

Discord commands and the new local Web API should both call this shared layer.

### 2. Extend the local admin Web API

Add an authenticated endpoint such as:

- `POST /api/autopilot/command`

Request payload should include:

- `argv`: the Autopilot command tokens after `bridgectl`
- optional `projectName`
- optional `channelId`
- optional `cwd`

Response payload should include:

- `ok`
- `message`
- `resolvedTarget`
- optional `data`
- optional `candidates` when the target cannot be resolved uniquely

### 3. Add a local CLI entrypoint

The CLI should:

- parse the local command line
- discover bridge origin and auth token from the package root `.env`, external secrets, and explicit env overrides
- call the local bridge API
- print the returned message
- support a future `--json` extension without changing the API shape

The CLI should not require the operator to be in the bridge repo root. It should resolve its sibling package root from its own installed script path.

## Target Resolution

Target resolution must be deterministic and safe.

Rules:

- `--channel` resolves by exact bound channel id
- `--project` resolves by exact bound project name
- `cwd` resolution matches bound workspaces where:
  - `cwd === workspacePath`, or
  - `cwd` is inside `workspacePath`
- if multiple workspace matches exist, prefer the longest matching workspace path
- if ambiguity still remains, return a clear error with candidates

## Output Model

For interactive use, the CLI should print the same style of human-readable text that Discord users already see. That means it should reuse the existing Autopilot formatter helpers where possible.

For automation, the control layer and Web API should also return structured metadata so the CLI can later support machine-readable output.

## Config and Auth

The CLI should resolve connection settings in this order:

1. explicit CLI / environment overrides
2. package-root `.env`
3. external secrets file at `~/.codex-tunning/secrets.env`
4. defaults:
   - origin `http://127.0.0.1:3769`
   - no auth token

If the bridge requires `WEB_AUTH_TOKEN`, the CLI should send a Bearer token.

## Testing Strategy

Use TDD across four layers:

1. control-layer target resolution tests
2. web-server API tests for authenticated Autopilot control
3. CLI tests for argv handling and API invocation
4. full regression verification with existing build and test suites

Critical scenarios:

- service status commands
- service mutations
- project mutations by `--project`
- project mutations by `--channel`
- project mutations by `cwd`
- ambiguous target failure
- missing target failure
- auth failure

## Restart and Service Safety

Do not modify the `launchd` management model or the restart shell flow for this feature.

The new behavior should stay within:

- bridge control layer
- web server
- CLI entrypoint
- docs

Ship only after:

- `npm run build`
- `npm test`
- `./scripts/macos-bridge.sh restart`
- `./scripts/macos-bridge.sh status`

all confirm healthy behavior.

## Documentation Scope

Update at least:

- `README.md`
- `docs/AUTOPILOT.md`
- `docs/QUICKSTART.md`
- `docs/MACOS-deploy.md`

Document:

- local CLI installation / usage
- project targeting rules
- mapping between CLI and Discord commands
- how Autopilot cadence and prompt are adjusted per project
- previous shipped features that are still missing or under-documented
