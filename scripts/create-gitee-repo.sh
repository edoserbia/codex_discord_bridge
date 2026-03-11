#!/usr/bin/env bash
set -euo pipefail

REPO_NAME="${1:-codex-discord-bridge}"
DESCRIPTION="${DESCRIPTION:-Codex Discord bridge with attachments, thread sessions, and web admin panel}"
PRIVATE_FLAG="${PRIVATE:-true}"
OWNER="${GITEE_OWNER:-}"
TOKEN="${GITEE_TOKEN:-}"
REMOTE_NAME="${REMOTE_NAME:-gitee}"

if [[ -z "$TOKEN" ]]; then
  echo "GITEE_TOKEN is required to create a repository via Gitee OpenAPI." >&2
  exit 1
fi

RESPONSE="$(curl -fsS -X POST 'https://gitee.com/api/v5/user/repos' \
  --data-urlencode "access_token=${TOKEN}" \
  --data-urlencode "name=${REPO_NAME}" \
  --data-urlencode "private=${PRIVATE_FLAG}" \
  --data-urlencode "description=${DESCRIPTION}")"

SSH_URL="$(printf '%s' "$RESPONSE" | node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(data.ssh_url || "");')"
FULL_NAME="$(printf '%s' "$RESPONSE" | node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(data.full_name || "");')"

if [[ -z "$SSH_URL" ]]; then
  echo "Failed to create repository or parse ssh_url from response:" >&2
  printf '%s\n' "$RESPONSE" >&2
  exit 1
fi

if git remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
  git remote set-url "$REMOTE_NAME" "$SSH_URL"
else
  git remote add "$REMOTE_NAME" "$SSH_URL"
fi

echo "Created/updated Gitee repository: ${FULL_NAME:-unknown}"
echo "Remote ${REMOTE_NAME}: ${SSH_URL}"

if [[ -n "$OWNER" ]]; then
  echo "Requested owner hint: $OWNER"
fi
