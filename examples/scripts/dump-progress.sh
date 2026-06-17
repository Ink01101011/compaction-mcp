#!/usr/bin/env bash
# PreCompact hook. Receives the boundary draft JSON on stdin.
# Dump a progress note to disk so it is guaranteed to survive the compact_boundary.
set -euo pipefail
payload="$(cat)"
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "[$ts] PreCompact: $payload" >> "${PROGRESS_LOG:-./PROGRESS.md}"
