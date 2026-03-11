#!/usr/bin/env bash
set -euo pipefail

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Git repository already initialized."
else
  git init -b main
  echo "Initialized git repository on branch main."
fi

git status --short
