# Findings and Decisions

## Requirements
- Progress should keep advancing in Discord with discrete step-like events similar to Codex CLI.
- "Latest activity" should not update one character at a time.
- Running command visibility should remain available when Codex is actively executing tools.
- Throughput should stay close to direct Codex CLI behavior, especially in app-server mode.

## Research Findings
- User reports the current runtime often stalls on "Codex 正在分析请求" and no longer emits per-step progress items.
- User reports "最新活动" appears to stream character-by-character and feels much slower than Codex CLI.
- The repo currently prefers `app-server` and already contains recent progress and status rendering hardening changes.
- The live service log contains `app-server turn/interrupt timed out after 10000ms` alongside Discord refresh failures such as `Connect Timeout Error` and `ECONNRESET`.
- `src/codexAppServerRunner.ts` awaits every hook callback for `turn.started`, reasoning deltas, agent message deltas, command events, and plan updates.
- The Discord bridge hook implementations in `src/discordBot.ts` await `refreshRuntimeViews(...)` for every activity, reasoning delta, agent message delta, command transition, stderr line, and plan update.
- `refreshRuntimeViews(...)` itself serializes updates and enforces a `MIN_RUNTIME_VIEW_REFRESH_INTERVAL_MS = 1200`, and each flush performs Discord `fetch` plus `edit/send` work for both the status card and the progress card.
- A local reproduction that only slowed Discord message `edit()` by 250ms caused an `[app-rich-stream]` app-server turn to miss the final reply within 15 seconds, confirming that UI refresh latency can throttle the turn pipeline.
- After switching streaming hooks to schedule view refreshes without awaiting them, the same slow-edit reproduction completed in about 3.2 seconds and the progress card recovered command, subagent, and completion entries.
- Coalesced refreshes can skip transient streamed text or very early plan states unless those states are either persisted in dedicated card sections or the refresh cadence is short enough to show intermediate snapshots.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Investigate event buffering/coalescing before changing UI copy | Character-by-character updates usually indicate the wrong event granularity is being forwarded |
| Fix the bridge hook path before changing app-server protocol handling | The evidence shows Discord refresh latency is backpressuring the runner, so the minimal safe fix is to stop awaiting view refreshes in the streaming hook path |
| Add a `回复草稿` section and keep `分析摘要` as the place for streamed text | Lets the bridge preserve streamed visibility without making `最新活动` degrade into a character stream |
| Expand the progress-card timeline window from 6 to 8 items | Keeps early activity like `Codex 正在分析请求` visible in final cards for plan-heavy runs |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| Need a fresh local reproduction after recent hardening changes | Inspect the live service logs and run focused tests before assuming a regression source |
| Local `node --test --test-name-pattern` invocations still executed unrelated tests | Use a direct reproduction script to confirm the failure mode while keeping the new regression test in the suite |

## Resources
- `.codex-plans/harden-app-server-discord-parity/findings.md`
