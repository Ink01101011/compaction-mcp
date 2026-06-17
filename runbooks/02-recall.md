# Runbook 2 — Recall (semantic cache before retrieval)

**Goal:** before searching the codebase or re-reading a file, check what you already know.
`recall` searches the **verification ledger** (proven facts) and **offloaded blobs**
(already-fetched content) and returns distilled hits, so the agent reuses them instead of
pulling whole files back into the window. This is the highest-value layer on hosts that have
their own retrieval (e.g. **Augment**) — it stops re-retrieval, which Augment doesn't.

## When to use

- The agent is about to grep / semantic-search the repo for something it likely saw already.
- You're resuming work and need "what did we establish about X?".
- Before re-reading a file you previously offloaded.

## Prerequisites

- Facts in the ledger (`ledger_record`) and/or content offloaded (`read_offloaded`).
- **Semantic mode (recommended):** an embeddings endpoint.
  - `COMPACTION_EMBED_MODEL=nomic-embed-text` (pull it in Ollama: `ollama pull nomic-embed-text`)
  - `COMPACTION_EMBED_BASE_URL` defaults to the summarizer endpoint; override if separate.
  - `COMPACTION_RECALL_MODE=auto` (default) uses embeddings when available, else lexical.
- **Lexical mode:** nothing — set `COMPACTION_RECALL_MODE=lexical` for zero infra.

## Steps

```jsonc
// tool: recall
{ "query": "how are expired credentials rejected", "limit": 8 }
```

Returns:

```jsonc
{
  "query": "how are expired credentials rejected",
  "mode": "embed",                       // or "lexical" if it fell back
  "ledgerHits": [
    { "claim": "token validation handles expiry", "result": "pass",
      "method": "unit test", "evidence": "auth.test.ts:42", "score": 0.83 }
  ],
  "blobHits": [
    { "handle": "0d5d57ac", "resource": "compaction://blob/0d5d57ac",
      "label": "auth service", "source": "/repo/src/auth/service.ts",
      "score": 0.79, "matches": [{ "line": 41, "endLine": 80, "text": "async refresh(token) {" }] }
  ],
  "note": "Consult these BEFORE querying ... avoids pulling whole files back into the window."
}
```

Then fetch only the indicated range:

```jsonc
// tool: offload_fetch
{ "handle": "0d5d57ac", "startLine": 41, "endLine": 80 }
```

## Expected outcome

A relevant fact + a precise line range — no full-file retrieval. On Augment, the agent skips
a context-engine query entirely when a cache hit answers the question.

## Verification

- `mode` field tells you which scorer ran (`embed` vs `lexical`).
- Semantic catches near-synonyms: query *"expired credentials"* should surface a ledger fact
  worded *"token validation handles expiry"* (no shared words) in `embed` mode — lexical would
  miss it. Use this as a smoke test that embeddings are actually engaged.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `mode` always `lexical` | no `COMPACTION_EMBED_MODEL`, or endpoint down | set the model; check the embed endpoint |
| stderr: `embed unavailable, falling back to lexical` | endpoint unreachable (auto mode) | verify `COMPACTION_EMBED_BASE_URL`; pull the model |
| `E_EMBED_UNAVAILABLE` thrown | `COMPACTION_RECALL_MODE=embed` (strict) + endpoint down | fix endpoint or switch to `auto` |
| Irrelevant hits | sparse ledger/blobs, or generic query | record more facts; query with specific terms |
| First call slow | embeddings being computed | cached by content hash afterward (`embcache.json`) |

## Host notes

- **Augment:** add a rule — "call `recall` before using the context engine; if a fact or range
  is cached, reuse it." This is where recall pays off most (Augment retrieves; recall remembers).
- **Copilot / custom loop:** same pattern; pairs with offload (Runbook 1).
