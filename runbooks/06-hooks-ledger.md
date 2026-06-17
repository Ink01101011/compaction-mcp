# Runbook 6 — Hooks + verification ledger (kill verification debt)

**Goal:** make sure important state survives the `compact_boundary`, and that the agent never
"forgets" what it already verified. The **verification ledger** records proven facts; the
**PreCompact/PostCompact hooks** dump and re-inject state around compaction. Together they
implement the maker/checker discipline.

## Part A — verification ledger

### When to use

- Any time something is established as true: a test passed, a signature confirmed, a decision
  made, a bug root-caused.
- In maker/checker workflows where a checker validates the maker's output.

### Record a fact

```jsonc
// tool: ledger_record
{
  "claim": "AuthService.refresh() rejects expired tokens",
  "method": "unit test",
  "result": "pass",
  "evidence": "auth.test.ts:42 green",
  "by": "checker"
}
```

### Query / snapshot

```jsonc
// tool: ledger_query
{ "claimContains": "refresh", "result": "pass" }

// tool: ledger_snapshot
{ }   // full current ledger (also captured automatically at each boundary)
```

### Why it matters

The ledger is injected into the summarization prompt (proven results are copied **verbatim**
into the summary) and re-emitted after compaction. So the agent doesn't re-run a check it
already passed — that's verification debt, eliminated. It also feeds [`recall`](./02-recall.md).

## Part B — PreCompact / PostCompact hooks

### When to use

- You want a guaranteed on-disk record before history is summarized (PreCompact).
- You want to re-inject something into context right after compaction (PostCompact).

### Configure

```bash
COMPACTION_HOOKS=/repo/compaction-mcp/examples/hooks.example.json
COMPACTION_HOOKS_ENABLED=true     # default; set false to disable all hook execution
```

```jsonc
// examples/hooks.example.json
{
  "PreCompact":  [{ "command": "scripts/dump-progress.sh",  "timeoutMs": 5000 }],
  "PostCompact": [{ "command": "scripts/reinject-ledger.sh", "timeoutMs": 5000, "continueOnError": true }]
}
```

### Lifecycle (inside `context_compact`)

1. **PreCompact** hooks run — receive the boundary draft JSON on **stdin**. Use to flush
   progress/ledger to disk. Non-zero exit aborts the compaction unless `continueOnError: true`.
2. Ledger snapshot captured and attached to the boundary.
3. Summarize → boundary appended → pre-boundary turns collapsed → tracked files re-hydrated.
4. **PostCompact** hooks run — their **stdout** is appended to the result's `extraContext`,
   so you can re-inject anything (e.g. echo the latest progress).

Sample scripts: [`../examples/scripts/`](../examples/scripts/).

### Maker/checker pattern, end-to-end

```
checker → ledger_record (pass/fail + evidence)
PreCompact hook → flush ledger + progress note to disk
context_compact → ledger copied verbatim into summary, snapshot on boundary
PostCompact hook → re-inject ledger/progress into extraContext
→ agent resumes without re-verifying proven work
```

## Verification

- After `context_compact`, confirm `ledgerSnapshot` in the block matches `ledger_snapshot`.
- Confirm proven claims appear verbatim in the `summary`.
- Check the PreCompact hook wrote its file (e.g. `PROGRESS.md`) and PostCompact output shows
  up in `extraContext`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `E_HOOK_FAILED` | hook exited non-zero | fix the script, or set `continueOnError: true` |
| Hooks never run | `COMPACTION_HOOKS_ENABLED=false` or no `COMPACTION_HOOKS` | enable + point to the file |
| Ledger empty at boundary | recorded under a different `sessionId` | thread one `sessionId` through all calls |
| Facts not in summary | ledger written after compaction | record before you compact |

## Security

Hooks run with the server's privileges. Only enable them from trusted, source-controlled
config; keep `COMPACTION_HOOKS_ENABLED=false` otherwise. See [`../ENTERPRISE.md`](../ENTERPRISE.md) §9.
