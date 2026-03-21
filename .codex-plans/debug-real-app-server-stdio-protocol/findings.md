# Findings & Decisions

## Root Cause
- The bridge's `CodexAppServerClient` currently writes stdio requests as `Content-Length: ...\r\n\r\n<json>` and parses stdout with the same framing.
- Direct probes against the real `codex app-server --listen stdio://` on `codex-cli 0.116.0` do not return anything for that framing, even after 60 seconds.
- A direct probe that sends one compact JSON message followed by `\n` receives an immediate `initialize` response on stdout:
  - request example: `{"id":1,"method":"initialize",...}\n`
  - response example: `{"id":1,"result":{"userAgent":"probe/0.116.0 ...","platformFamily":"unix","platformOs":"macos"}}\n`
- The real CLI accepts newline-delimited JSON both with and without `jsonrpc: "2.0"`, so the blocking incompatibility is the stdio framing, not the presence of the `jsonrpc` field.

## Implications
- The real stdio transport is newline-delimited JSON, not LSP-style `Content-Length` framing.
- This mismatch fully explains the production symptom:
  - bridge startup times out on `initialize`
  - the request falls back to `legacy-exec`
  - subsequent behavior diverges from official Codex app-server mode

## Follow-up Work
- Add a regression test that fails if stdio messages are framed with `Content-Length`.
- Update the stdio sender/parser to use newline-delimited JSON while preserving websocket behavior and compatibility with the existing content-length fixtures.
- Reproduce real startup in both this repo and `/Users/mac/work/su/patent-platform` after the patch.
