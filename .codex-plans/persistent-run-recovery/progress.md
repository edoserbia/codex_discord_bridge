# Progress Log

## Session: 2026-03-21

### Current Status
- **Phase:** 5 - Delivery
- **Started:** 2026-03-21

### Actions Taken
- Reviewed current queue, cancellation, guidance insertion, retry, and app-server fallback logic in `src/discordBot.ts`.
- Confirmed from `src/store.ts` and `src/types.ts` that bindings and sessions are persisted but active runs and queued prompts are not.
- Confirmed `!cancel` only targets the current in-memory active job.
- Confirmed existing `!queue` command is read-only and currently cannot reprioritize or inject queued prompts.
- Confirmed existing retry behavior already favors the current task over later queue items, but only within a single process lifetime.
- Added persisted runtime snapshot support to `src/store.ts` and `src/types.ts`, plus immediate/debounced runtime snapshot saves from `DiscordCodexBridge`.
- Added startup runtime recovery, recovery notices, recovery task construction, and recovery-aware task summaries/Discord rendering.
- Added `!queue insert <n>` parsing, queue insertion execution, and e2e coverage for queue insertion plus recovery restart/cancel behavior.
- Fixed two regressions discovered during verification: stderr-only retries now keep the original prompt, and task-scoped waits prevent queue/guidance cancellation from killing the next run.

### Test Results
| Test | Expected | Actual | Status |
|------|----------|--------|--------|
| `node --import tsx --test --test-concurrency=1 test/commandParser.test.ts` | Queue insert parser stays green | 15/15 passed | passed |
| `node --import tsx --test --test-concurrency=1 test/store.test.ts` | Runtime snapshot store changes stay green | 2/2 passed | passed |
| `node --import tsx --test --test-concurrency=1 test/discordBridge.e2e.test.ts` | Recovery, cancel, queue insert, and existing bridge flows stay green | 48/48 passed | passed |
| `npm run check` | TypeScript compile without emit succeeds | exited 0 | passed |
| `npm run build` | Production build succeeds | exited 0 | passed |
| `npm test` | Full automated suite stays green | 109/109 passed | passed |

### Next Step
- Commit/push the recovery work, restart the local bridge service, and verify the installed process picked up the new build.
