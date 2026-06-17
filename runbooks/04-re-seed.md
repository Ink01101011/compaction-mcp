# Runbook 4 — Re-seed (recover tokens by starting fresh)

**Goal:** actually reclaim tokens on hosts that own their window (Copilot, Augment). You
can't shrink the live window, but **a new chat starts empty**. `handoff_brief` builds a small
seed (rules + latest summary + verification ledger + files to re-open); you open a new chat
and continue from it.

## When to use

- Copilot/Augment session has grown and `context_compact` isn't relieving pressure.
- Switching to a clearly new phase of work.
- You suspect MCP may get blocked and want a durable, MCP-independent handoff on disk.

## Prerequisites

- Ideally a prior `context_compact` (so the brief includes a dense summary). Without one, the
  brief still carries rules + ledger + file list.
- `COMPACTION_ALLOWED_ROOTS` must include `outPath` if you write into the workspace.

## Steps

### 1. Build the brief

```jsonc
// tool: handoff_brief
{ "outPath": ".compaction/handoff.md", "includeFileContents": false }
```

Returns:

```jsonc
{
  "sessionId": "a7623365-...",
  "brief": "=== COMPACTED HANDOFF — AUTHORITATIVE GROUND TRUTH ===\n...",
  "writtenTo": [
    "~/.compaction-mcp/sessions/<id>/handoff.md",   // always
    "/repo/.compaction/handoff.md"                  // because outPath was given
  ]
}
```

The brief contains: authoritative marker · persistent rules · latest summary · verification
ledger (proven facts) · active files to re-open.

### 2. Open a new chat

Start a fresh Copilot/Augment chat (empty window).

### 3. Seed it — two ways

- **With MCP:** read the resource `compaction://handoff/{sessionId}` (host resource UI), or
  call `handoff_brief` again from the new chat with the same `sessionId`.
- **Without MCP (robust):** attach/paste `.compaction/handoff.md`. Works even if MCP is
  disabled for the account.

### 4. Continue

The agent re-opens the listed files from disk and proceeds from the summary + ledger. Tokens
genuinely reclaimed — the verbose history is not in the new session.

## `includeFileContents`

Set `true` to inline current file contents into the brief (fully self-contained, larger).
Leave `false` (default) to keep the brief small and let the new chat re-read files itself —
preferred when files are large or the host has good file access.

## Verification

- `writtenTo` lists the disk paths; confirm `.compaction/handoff.md` exists.
- Open the brief: it must start with the `=== COMPACTED HANDOFF ===` marker and contain the
  ledger facts.
- In the new chat, confirm token usage starts low (fresh window).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Workspace file not written | `outPath` outside allowed roots | include the root, or rely on the state-dir copy |
| Summary line says "no compaction summary yet" | never compacted | run `context_compact` first for a denser brief |
| New chat ignores the brief | not seeded clearly | paste/attach the file explicitly; the marker tells it to treat it as ground truth |
| MCP blocked in new session | org policy | use the file fallback — that's why it's always written to disk |

## Note on a blocked summarizer

Generating a *new* summary needs the LLM endpoint. **Re-seeding from an existing brief needs
only the file.** If the summarizer (e.g. GitHub Models via a managed token) gets blocked,
you can still re-seed from a brief generated earlier. See [`../ENTERPRISE.md`](../ENTERPRISE.md) §7.1.
