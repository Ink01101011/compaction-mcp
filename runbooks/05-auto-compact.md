# Runbook 5 — Auto-compact (deterministic, store mode)

**Goal:** hands-off compaction driven by token math, not model judgment. In `store` mode the
server checks pressure after every ingested turn and, once it crosses the threshold, compacts
inline and returns the block under `autoCompacted`. Your loop just installs it.

> Only works in **`store`** mode (the server holds the transcript). Passthrough hosts like
> Copilot stay manual/semi-manual — the server doesn't see continuous history there.

## When to use

- You run your own agent loop (local LLM via Ollama, custom orchestrator).
- You want compaction to be deterministic and not depend on the model remembering to do it.

## Prerequisites

```bash
COMPACTION_MODE=store
COMPACTION_AUTO=true
COMPACTION_SUMMARIZER=direct
COMPACTION_LLM_BASE_URL=http://localhost:11434/v1
COMPACTION_LLM_MODEL=qwen2.5-coder:14b
COMPACTION_TOKEN_BUDGET=8000          # tune to your model's window
# thresholds (defaults): COMPACTION_PROACTIVE_PCT=60 NOW_PCT=85 LIMIT_PCT=95
```

## Steps (your loop)

1. Establish one `sessionId` (e.g. from `rules_set`) and thread it through **every** call.
2. Pin rules (`rules_set`) and track files (`files_track`) once.
3. For each message, call `turn_add`:

```jsonc
// tool: turn_add
{ "sessionId": "<id>", "role": "user", "content": "<message>" }
```

4. Inspect the result:

```jsonc
// normal:
{ "sessionId": "<id>", "turns": 12, "pressurePct": 73, "recommendation": "compact-soon" }

// when the threshold is crossed:
{ "sessionId": "<id>", "turns": 13, "autoCompacted": { /* full compacted block */ } }
```

5. If `autoCompacted` is present, rebuild your live window from it (rules + summary +
   rehydrated files) and drop the old turns. Otherwise continue.

A runnable reference loop is in [`../examples/agent-loop.mjs`](../examples/agent-loop.mjs).

## Run the reference example

```bash
npm run build
node examples/agent-loop.mjs
# or against any OpenAI-compatible endpoint:
COMPACTION_LLM_BASE_URL=https://models.github.ai/inference \
COMPACTION_LLM_MODEL=openai/gpt-4o-mini \
COMPACTION_LLM_API_KEY=$GITHUB_TOKEN \
node examples/agent-loop.mjs
```

Expected: several `+ turn (NN%)` lines, then `↻ auto-compacted ...` once pressure crosses
`nowPct`, with the window reset to the seeded block.

## Verification

- The `autoCompacted.boundary.reason` is `"auto-threshold"`.
- It fires only at/after `nowPct` (default 85%) — lower-pressure turns return `recommendation`
  without `autoCompacted`.
- `ledgerSnapshot` in the block carries verified facts across the boundary.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Never auto-compacts | not `store` mode, or `COMPACTION_AUTO` unset | set both env vars |
| Fires too early/late | budget/threshold mismatch | tune `COMPACTION_TOKEN_BUDGET` / `*_PCT` |
| State split across sessions | calls made without a shared `sessionId` | thread one id through all calls |
| `E_SUMMARIZER_UNAVAILABLE` on auto | endpoint down | check `COMPACTION_LLM_*` |
