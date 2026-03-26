# Bridge Proxy Autodetect Design

**Date:** 2026-03-26

**Goal:** Decouple the bridge proxy configuration from OpenClaw naming and make macOS setup/start flows automatically choose direct Discord access or a local `7890` proxy based on real HTTPS reachability.

## Problem

The current macOS bootstrap flow uses `OPENCLAW_DISCORD_PROXY` and `OPENCLAW_DISCORD_CA_CERT` even though `codex-discord-bridge` is an independent project. That naming leaks another product's identity into this repository and makes the proxy model feel more coupled than it really is.

The current flow is also static: if `.env` contains a proxy, start-time injection always uses it. If the machine can directly reach Discord, the bridge still keeps proxy settings until a human manually clears them. If direct access fails, the operator must manually set `http://127.0.0.1:7890`.

## Design

Introduce bridge-specific variables:

- `CODEX_DISCORD_BRIDGE_PROXY`
- `CODEX_DISCORD_BRIDGE_CA_CERT`

Keep backward compatibility for existing deployments by reading legacy values from:

- `OPENCLAW_DISCORD_PROXY`
- `OPENCLAW_DISCORD_CA_CERT`

Legacy keys remain migration inputs, not the preferred public interface.

## Reachability Probe

Use an HTTPS reachability check against `https://discord.com/api/v10/gateway` instead of ICMP ping. This is closer to the bridge's real dependency and avoids false negatives from blocked ICMP.

The algorithm is:

1. Probe Discord with no proxy.
2. If direct access succeeds:
   - clear `CODEX_DISCORD_BRIDGE_PROXY`
   - keep any CA setting unchanged unless it only came from legacy migration
3. If direct access fails:
   - try `http://127.0.0.1:7890`
4. If the `7890` probe succeeds:
   - set `CODEX_DISCORD_BRIDGE_PROXY=http://127.0.0.1:7890`
5. If both fail:
   - leave the bridge proxy empty
   - emit a clear warning so the operator sees that Discord is still unreachable

## When To Run

Run the probe during:

- `.env` preparation / setup
- manual start
- `service-run`
- service installation / reinstallation paths that call setup before bootstrap

This keeps `.env` aligned with actual network conditions instead of treating proxy choice as a one-time manual configuration.

## Testing Strategy

Add script-level tests that source `scripts/macos-bridge.sh` safely and exercise the proxy selection helper without talking to real Discord:

- direct probe succeeds -> proxy key is cleared
- direct probe fails, proxy probe via a local fake proxy succeeds -> proxy key becomes `http://127.0.0.1:7890`
- legacy `OPENCLAW_*` values migrate to new keys

Tests should use a probe URL override and local HTTP fixtures so behavior stays deterministic.
