# Runbook 1 — Offload (proactive window control)

**Goal:** stop large, low-value content from ever entering the context window. Store it as a
blob; put only a short **digest + handle** in the conversation. Fetch the full body (or a
line slice) only when actually needed.

## When to use

- Reading a large file you only partly need.
- Long command output: test runs, build logs, `git diff`, stack traces.
- Bulky payloads: API responses, DB dumps, JSON fixtures.
- Any time you're about to paste >~100 lines into chat "just in case".

## Prerequisites

- `COMPACTION_ALLOWED_ROOTS` must include any file path you offload from disk.
- No summarizer/embeddings needed — offloading is local and free.

## Steps

### A. Offload a file instead of reading it

```jsonc
// tool: read_offloaded
{ "path": "/repo/src/auth/service.ts", "label": "auth service" }
```

Returns a digest — note the `handle`:

```jsonc
{
  "handle": "0d5d57ac",
  "resource": "compaction://blob/0d5d57ac",
  "label": "auth service",
  "source": "/repo/src/auth/service.ts",
  "lines": 412, "bytes": 13980,
  "preview": "import { ... } from ...\n...",   // first 12 lines
  "outline": ["12: export class AuthService", "44: async refresh(token)", "..."],
  "note": "Full content is offloaded — NOT in context. Use offload_fetch ..."
}
```

### B. Offload arbitrary text (command output)

```jsonc
// tool: offload_store
{ "label": "npm test output", "content": "<...2,000 lines of jest output...>" }
```

### C. Pull only what you need

```jsonc
// tool: offload_fetch
{ "handle": "0d5d57ac", "startLine": 44, "endLine": 78 }
```

Or read the whole thing via the resource `compaction://blob/0d5d57ac` (host resource UI).

## Expected outcome

The window holds a ~10–40 line digest instead of a 400-line file. The model reasons over the
outline and fetches the exact range it needs — typically a fraction of the full content.

## Verification

- Compare `digest size` vs `bytes` in the result — the digest should be a small fraction.
- Confirm the `outline` contains the real declarations (functions/classes/headings), not just
  noise — the ranker prioritizes those over a flood of `const`/list lines.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `E_FILE_UNREADABLE: outside allowed roots` | path not under `COMPACTION_ALLOWED_ROOTS` | add the root |
| `E_NO_BLOB: <handle>` | wrong handle / state dir changed | re-offload; check `COMPACTION_STATE_DIR` |
| Outline is all trivial lines | file has few real decls | use `offload_fetch` with ranges from `preview` |

## Host notes

- **Custom loop:** full benefit — you choose every tool.
- **Copilot/Augment:** benefit only if the agent calls `read_offloaded` instead of the
  built-in file-read/grep (those still dump full content). Enforce via `copilot-instructions.md`
  (see [`../ENTERPRISE.md`](../ENTERPRISE.md) §7).
