# Findings & Decisions

## Root Cause
- The failing `patent_platform` binding does not define `profile=full` or any equivalent legacy permissions override.
- The local machine is running `codex-cli 0.116.0`.
- The global file [config.toml](/Users/mac/.codex/config.toml) contains:
  - `sandbox_mode = "danger-full-access"`
  - `approval_policy = "never"`
  - `default_permissions = "full"`
  - `[permissions.full]`
    - `open_world_enabled = true`
    - `destructive_enabled = true`
- Direct reproduction with a temporary `CODEX_HOME` showed:
  - A config that keeps `sandbox_mode = "danger-full-access"` and `approval_policy = "never"` but removes `default_permissions` starts `codex app-server` without the permissions-profile error.
  - Reintroducing `default_permissions = "full"` and `[permissions.full]` reproduces the exact `Permissions profile \`full\` does not define any recognized filesystem entries` stderr.

## Implications
- The bridge does not need to reduce permissions to make `app-server` work.
- The incompatibility is caused by an obsolete config shape, not by the user's desired full-access policy.
- The safest fix is to keep the current top-level full-access settings and delete the obsolete `default_permissions/full` stanza.

## Follow-up Work
- Add a normalized diagnostic for this specific compatibility fault so Discord shows an actionable reason instead of raw ANSI-heavy stderr.
- Document the validated Codex CLI version (`0.116.0`) and the compatible full-permission config in the project docs.
- Update the machine-local `~/.codex/config.toml` after code/doc changes are ready.
