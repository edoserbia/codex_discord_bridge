# Bridge Proxy Autodetect Implementation Plan

> **Execution:** REQUIRED SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rename the bridge proxy configuration to project-specific variables and make setup/start flows automatically choose direct Discord access or the local `7890` proxy using HTTPS reachability checks.

**Architecture:** Extend `scripts/macos-bridge.sh` with a small proxy configuration layer: migrate legacy env keys, probe Discord reachability without proxy, retry through `7890` if needed, and persist the selected bridge-specific proxy setting back into `.env`. Keep runtime injection logic centralized so service startup paths share the same behavior.

**Tech Stack:** Bash, Node.js test runner, local HTTP fixtures, existing macOS management script

---

### Task 1: Add failing script-level tests for proxy auto-selection

**Files:**
- Create: `test/macosBridgeProxy.test.ts`
- Modify: `scripts/macos-bridge.sh`

**Step 1: Write the failing test**

Add tests that source `scripts/macos-bridge.sh` and expect:

- direct HTTPS probe success clears the bridge proxy variable
- direct failure plus proxy success writes `CODEX_DISCORD_BRIDGE_PROXY=http://127.0.0.1:7890`
- legacy `OPENCLAW_*` variables migrate to new bridge-specific keys

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test --test-concurrency=1 test/macosBridgeProxy.test.ts`

Expected: FAIL because the script cannot yet be safely sourced for testing and the new proxy logic does not exist.

**Step 3: Write minimal implementation**

Add the smallest safe script changes needed to support sourcing and the new helper entrypoints.

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test --test-concurrency=1 test/macosBridgeProxy.test.ts`

Expected: PASS

### Task 2: Implement bridge-specific proxy selection and env migration

**Files:**
- Modify: `scripts/macos-bridge.sh`
- Modify: `.env.example`

**Step 1: Write the failing test**

Extend the new test file to assert that setup/start-time helpers read and write:

- `CODEX_DISCORD_BRIDGE_PROXY`
- `CODEX_DISCORD_BRIDGE_CA_CERT`

while still accepting legacy `OPENCLAW_*` inputs.

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test --test-concurrency=1 test/macosBridgeProxy.test.ts`

Expected: FAIL because the script still uses only the legacy names.

**Step 3: Write minimal implementation**

Implement:

- env-key migration from legacy names to bridge names
- HTTPS probe helper
- `7890` fallback helper
- env persistence logic
- runtime injection based on bridge-specific variables

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test --test-concurrency=1 test/macosBridgeProxy.test.ts`

Expected: PASS

### Task 3: Update operator-facing docs and verify end-to-end behavior

**Files:**
- Modify: `README.md`
- Modify: `docs/QUICKSTART.md`
- Modify: `docs/MACOS-deploy.md`
- Modify: `docs/DEPLOYMENT.md`

**Step 1: Update docs**

Replace the public-facing `OPENCLAW_*` proxy naming with the bridge-specific variables and document the auto-detect behavior.

**Step 2: Run focused verification**

Run:

- `node --import tsx --test --test-concurrency=1 test/macosBridgeProxy.test.ts`
- `npm run check`

Expected: PASS

**Step 3: Run full verification**

Run: `npm test`

Expected: PASS
