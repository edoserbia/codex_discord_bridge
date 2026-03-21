# Task: Harden app-server Discord parity, subagent visibility, and web access

## Goal
Keep Codex app-server as the preferred bridge backend while improving Discord-visible parity, sticky mode visibility, subagent visibility, and token-protected LAN web access without regressing guide or live plan behavior.

## Current Phase
Phase 3

## Phases

### Phase 1: Requirements and Discovery
- [x] Confirm new user requirements
- [x] Inspect existing app-server, guide, subagent, and web code paths
- [x] Record findings and constraints
- **Status:** completed

### Phase 2: Design and Planning
- [x] Present design and get approval
- [x] Write design doc
- [x] Write implementation plan
- **Status:** completed

### Phase 3: TDD Implementation
- [ ] Add failing tests
- [ ] Implement minimal fixes
- [ ] Validate incrementally
- **Status:** in_progress

### Phase 4: Verification and Deployment
- [ ] Run targeted and full verification
- [ ] Restart the local service
- [ ] Confirm runtime behavior
- **Status:** pending

### Phase 5: Delivery
- [ ] Commit and push the final changes
- [ ] Report outcomes and any remaining limits
- **Status:** pending

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Keep app-server as the preferred driver | Matches the user's goal of staying close to official Codex CLI behavior |
| Add sticky driver rendering to status and progress cards | The existing fallback notice can be refreshed out of view; cards must retain current mode information |
| Surface official subagent nickname fields when present | The local protocol schema shows official nickname support, so the bridge should render it instead of inventing names |
| Preserve existing `!guide` steer behavior | It already maps cleanly to official app-server `turn/steer` semantics and must not disrupt current tasks |
| Add a bridge command for tokenized web links instead of relying only on shell scripts | The user wants the link directly from Discord and via `!` commands |
| Prefer LAN-accessible web defaults while keeping token auth | Satisfies the user's access requirement without removing protection |
| Keep subagent lifecycle control aligned with official Codex behavior where possible | No stable local evidence yet of a public CLI config for forced subagent reuse/TTL; bridge should avoid fabricating incompatible protocol knobs |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| No confirmed stable Codex CLI config key for forced subagent reuse or 12-hour cleanup found locally | 1 | Treat this as an implementation limit, prefer official thread/session reuse, and keep bridge-side cleanup limited to presentation/runtime caches |
