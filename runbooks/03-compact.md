# Runbook 3 — Compact (in-place summarization)

**Goal:** when history has grown, replace it with a dense summary while re-hydrating live
files from disk and snapshotting the verification ledger. This is a real **model call**, not
truncation.

> **Token relief depends on who owns the window.** In `store` mode (or Claude Code) the
> window is rebuilt from the result → real relief. On Copilot (`passthrough`) the summary is
> *additive* and does **not** shrink the live window — use [re-seed](./04-re-seed.md) there.

## When to use

- End of a logical task, before starting an unrelated one (avoid mixing contexts).
- Proactively at ~60% pressure (`compact-soon`) — don't wait for the messy 95%.
- Before a step where you'll need specific details preserved (pass them in `preserve`).

## Prerequisites

- A summarizer backend (`COMPACTION_SUMMARIZER`): `direct` (Ollama/gateway), `sampling`
  (Claude Desktop), or `auto`. See [`../README.md`](../README.md).
- Optional: `files_track` the active files so they're re-hydrated post-compact.
- Optional: `rules_set` for session-long rules that must survive.

## Steps

### 1. Check pressure

```jsonc
// tool: context_status
{ "tokenBudget": 128000, "estTokensUsed": 82000 }
// → { "pressurePct": 64, "recommendation": "compact-soon", ... }
```

### 2. Track files + pin rules (once)

```jsonc
// tool: files_track
{ "paths": ["/repo/src/auth/service.ts", "/repo/src/auth/types.ts"] }

// tool: rules_set
{ "rules": "Always run tsc before claiming a fix. Public API in types.ts must stay stable." }
```

### 3. Compact

```jsonc
// tool: context_compact
{
  "transcript": "<the conversation history to compress>",   // required in passthrough
  "preserve": "keep exact error strings and the AuthService.refresh signature"
}
```

Returns the **compacted context block**:

```jsonc
{
  "summary": "## Decisions\n- ...\n\n=== ... treat earlier history as superseded ===",
  "persistentRules": "Always run tsc ...",
  "rehydratedFiles": [{ "path": ".../service.ts", "ok": true, "contents": "..." }],
  "ledgerSnapshot": [{ "claim": "...", "result": "pass", ... }],
  "boundary": { "id": "...", "tokensBefore": 82000, "tokensAfter": 1200, "reason": "manual" },
  "extraContext": "<stdout of PostCompact hooks>"
}
```

### 4. Install the block

- **Store mode / custom loop:** rebuild your message array = `persistentRules` + `summary` +
  `rehydratedFiles` (+ `extraContext`); drop everything before `boundary`.
- **Passthrough/Copilot:** treat the block as ground truth and ignore earlier history (best
  effort — see re-seed for actual relief).

## Tier-1 alternative: trim (no inference)

For cheap cleanup without a model call (store mode):

```jsonc
// tool: context_trim
{ "dropToolOutputOlderThanTurns": 10 }   // → { "removed": N }
```

## Verification

- `boundary.tokensAfter` ≪ `boundary.tokensBefore`.
- `rehydratedFiles[].ok` is true for tracked files (code is fresh from disk).
- `ledgerSnapshot` carries your verified facts; spot-check they appear verbatim in `summary`.
- Pre-boundary turns must be treated as **non-addressable** afterward (SPEC §4).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `E_NO_TRANSCRIPT` | passthrough + no `transcript` | pass the history, or use `store` mode |
| `E_SUMMARIZER_UNAVAILABLE` | endpoint down / sampling unsupported | check `COMPACTION_LLM_*`; use `auto` |
| Summary dropped a needed detail | not hinted | add it to `preserve`; record it via `ledger_record` |
| Rules vanished after a while | rules were in chat, not pinned | use `rules_set` (re-emitted every boundary) |
| Window didn't shrink (Copilot) | passthrough can't evict host window | switch to re-seed (Runbook 4) |
