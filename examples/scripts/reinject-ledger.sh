#!/usr/bin/env bash
# PostCompact hook. Whatever this prints to stdout is appended to the result's
# `extraContext` and re-injected by the host after compaction.
set -euo pipefail
cat   # echo the post-compact payload back so the agent re-reads the boundary summary ref
if [ -f "./PROGRESS.md" ]; then
  echo "---- recent progress ----"
  tail -n 20 ./PROGRESS.md
fi
