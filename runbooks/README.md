# Runbooks

Step-by-step operational guides for each context-management strategy in `compaction-mcp`.
Each runbook is self-contained: when to use it, exact tool calls, expected output,
verification, and troubleshooting.

| # | Runbook | Strategy | Primary win |
|---|---|---|---|
| 1 | [offload.md](./01-offload.md) | Offload (proactive) | Keep ephemeral/non-code data out of the window |
| 2 | [recall.md](./02-recall.md) | Recall (semantic cache) | Don't re-retrieve what's already known |
| 3 | [compact.md](./03-compact.md) | Compact (in-place) | Summarize history, re-hydrate files |
| 4 | [re-seed.md](./04-re-seed.md) | Re-seed (recovery) | Actually reclaim tokens on Copilot |
| 5 | [auto-compact.md](./05-auto-compact.md) | Auto (deterministic) | Hands-off compaction in a custom loop |
| 6 | [hooks-ledger.md](./06-hooks-ledger.md) | Hooks + ledger | Survive the boundary; kill verification debt |

## The 4-layer model

```
offload   → keep the window small in the first place        (before it grows)
recall    → reuse known facts instead of re-fetching        (during work)
compact   → summarize + re-hydrate when it has grown         (store mode: real relief)
re-seed   → start a fresh chat from a handoff brief          (Copilot: real relief)
```

`compact` only reclaims tokens where the server (or your loop) owns the window — `store`
mode or Claude Code. On Copilot (`passthrough`) the real reducers are **offload** and
**re-seed**; `compact` there gives a good summary but doesn't shrink the live window. See
[`../SPEC.md`](../SPEC.md) §1 and §10A.

## Tool ↔ runbook map

- `read_offloaded`, `offload_store`, `offload_fetch` → [1](./01-offload.md)
- `recall` → [2](./02-recall.md)
- `context_status`, `context_compact`, `context_trim`, `files_track`, `files_rehydrate`, `rules_set` → [3](./03-compact.md)
- `handoff_brief`, `compaction://handoff/{id}` → [4](./04-re-seed.md)
- `turn_add` (+ `COMPACTION_AUTO`) → [5](./05-auto-compact.md)
- `ledger_record`, `ledger_query`, `ledger_snapshot`, Pre/PostCompact hooks → [6](./06-hooks-ledger.md)
