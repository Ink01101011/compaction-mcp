# Augment guidelines (recall-first)

Add these to your Augment user/workspace guidelines so the agent uses compaction-mcp to
*complement* Augment's Context Engine rather than duplicate it. The win on Augment is
**not re-retrieving** and **not bloating the window with non-code data**.

```markdown
## Context discipline (compaction-mcp)
- Before searching the codebase or re-reading a file, call `recall` first. If a fact is in
  the ledger or a needed range is in an offloaded blob, reuse it instead of re-querying the
  Context Engine.
- For long, non-code output (test runs, build logs, large JSON/DB dumps), use `offload_store`
  and keep only the digest in the conversation; `offload_fetch` the exact range if needed.
  (The Context Engine indexes repo code, not this ephemeral output — so offload it.)
- When something is verified (test passed, signature confirmed, decision made), record it with
  `ledger_record` (claim + method + result + evidence). This feeds `recall` and survives summaries.
- When the session grows large, build a `handoff_brief` and continue in a fresh Augment chat —
  that's how tokens are actually reclaimed (Augment's window can't be shrunk in place).
```

## Why these and not the rest

Augment already does codebase retrieval and cross-session Memories well, so `read_offloaded`
on source files and `rules_set`/freeform memory overlap with native features. The four rules
above are the **non-overlapping** value: a verified-fact cache (`recall` + ledger), ephemeral
non-code offloading, and re-seed. See [`../runbooks/02-recall.md`](../runbooks/02-recall.md)
and [`../runbooks/04-re-seed.md`](../runbooks/04-re-seed.md).
