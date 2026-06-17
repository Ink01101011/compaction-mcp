# compaction-mcp

A portable **MCP stdio server** that brings Claude Code's `/compact` lifecycle to any
MCP host — **GitHub Copilot** (VS Code), **Claude Desktop**, or a **custom local-LLM
agent loop** (e.g. Qwen-Coder via Ollama).

It exposes context compaction as tools/resources/prompts so the agent can: gauge context
pressure, summarize accumulated history into a dense block (a real inference call, not
truncation), re-hydrate live files from disk, persist session-long rules and a
**verification ledger** across the `compact_boundary`, and run **PreCompact/PostCompact**
hooks.

See [`SPEC.md`](./SPEC.md) for the full protocol design and the host/server
responsibility split, [`ENTERPRISE.md`](./ENTERPRISE.md) for deploying under
**GitHub Copilot Enterprise** (org policy gates, MCP registry, in-tenant summarizer,
distribution), and [`runbooks/`](./runbooks/) for step-by-step operational guides for each
strategy (offload, recall, compact, re-seed, auto-compact, hooks/ledger).

## Why a server can't just "do" `/compact`

In Claude Code, `/compact` is host-level — the CLI owns the context window. An MCP server
doesn't. So this server provides the **mechanism** (summarize, re-hydrate, persist,
snapshot ledger) and returns a **compacted context block**; the *host* installs that block
as its new ground truth and discards pre-boundary history. Read §1 of the spec first.

## Install

```bash
npm install
npm run build      # → dist/index.js
```

## Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `COMPACTION_SUMMARIZER` | `direct` | `direct` \| `sampling` \| `auto` (§6 of spec) |
| `COMPACTION_LLM_BASE_URL` | `http://localhost:11434/v1` | OpenAI-compatible endpoint (Ollama) |
| `COMPACTION_LLM_MODEL` | `qwen2.5-coder:14b` | summarizer model |
| `COMPACTION_LLM_API_KEY` | — | optional bearer token |
| `COMPACTION_LLM_HEADERS` | — | JSON of extra request headers (Azure `api-key`, gateway/tenant headers); overrides Bearer |
| `COMPACTION_MODE` | `passthrough` | `passthrough` (host owns history) \| `store` (server holds it) |
| `COMPACTION_STATE_DIR` | `~/.compaction-mcp/sessions` | session + ledger persistence |
| `COMPACTION_ALLOWED_ROOTS` | cwd | colon-separated roots for file re-hydration |
| `COMPACTION_HOOKS` | — | path to hooks JSON (see `examples/hooks.example.json`) |
| `COMPACTION_HOOKS_ENABLED` | `true` | set `false` to disable all hook execution |
| `COMPACTION_TOKEN_BUDGET` | `128000` | default window size when host doesn't declare one |
| `COMPACTION_AUTO` | `false` | auto-compact on ingest when pressure ≥ `nowPct` (store mode only) |
| `COMPACTION_RECALL_MODE` | `auto` | `auto` \| `embed` \| `lexical` — recall ranking strategy |
| `COMPACTION_EMBED_MODEL` | — | embeddings model for semantic recall (e.g. `nomic-embed-text`); enables `embed` |
| `COMPACTION_EMBED_BASE_URL` | = LLM base URL | OpenAI-compatible `/embeddings` endpoint |

### Manual vs auto

The server is **manual by default** — it only acts when a tool is called. `context_status`
tells you *when* to compact, but the host decides.

For **deterministic auto** behavior, use `COMPACTION_MODE=store` + `COMPACTION_AUTO=true`:
`turn_add` then checks pressure after each turn and, once it crosses the compact-now
threshold, runs compaction inline and returns the block under `autoCompacted`. Your agent
loop just installs `autoCompacted` whenever it's present. Passthrough mode stays manual
(the server doesn't hold continuous history).

### Summarizer choice (important)

- **`direct`** works on **every** host (incl. Copilot) — the server calls the LLM itself.
  Point it at Ollama for fully local operation.
- **`sampling`** needs a sampling-capable host (Claude Desktop). **Copilot does not
  support sampling** — don't use it there.
- **`auto`** uses sampling if the client offers it, else falls back to `direct`.

## Host setup

### GitHub Copilot (VS Code) — `.vscode/mcp.json`

Copilot is tools-only, so use `passthrough` mode + `direct` summarizer (Ollama):

```jsonc
{
  "servers": {
    "compaction": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/compaction-mcp/dist/index.js"],
      "env": {
        "COMPACTION_SUMMARIZER": "direct",
        "COMPACTION_LLM_BASE_URL": "http://localhost:11434/v1",
        "COMPACTION_LLM_MODEL": "qwen2.5-coder:14b",
        "COMPACTION_MODE": "passthrough",
        "COMPACTION_ALLOWED_ROOTS": "${workspaceFolder}"
      }
    }
  }
}
```

Then instruct Copilot (e.g. in `.github/copilot-instructions.md`): when the conversation
grows long, call `context_compact` with the recent history as `transcript`, then continue
from the returned `summary` + `rehydratedFiles` + `persistentRules`.

**No Ollama? (Copilot-only)** Copilot doesn't lend its model to MCP servers (no sampling),
so `direct` must point at *some* OpenAI-compatible endpoint. Easiest for a Copilot user is
**GitHub Models** (free, OpenAI-compatible) — see
[`examples/vscode-mcp.github-models.json`](./examples/vscode-mcp.github-models.json). It
uses VS Code's `inputs` to prompt for a GitHub token (scope `models: read`) once and store
it encrypted. Any other OpenAI-compatible provider (OpenAI, OpenRouter, Groq, …) works the
same way — just change `COMPACTION_LLM_BASE_URL` / `COMPACTION_LLM_MODEL`.

### Claude Desktop — `claude_desktop_config.json`

```jsonc
{
  "mcpServers": {
    "compaction": {
      "command": "node",
      "args": ["/abs/path/compaction-mcp/dist/index.js"],
      "env": { "COMPACTION_SUMMARIZER": "auto" }
    }
  }
}
```

`auto` lets Claude Desktop run the summary via sampling (same model, no extra infra).

### Enterprise (internal LLM gateway)

Point `direct` at your company's OpenAI-compatible gateway (LiteLLM, Portkey, Kong/Cloudflare
AI Gateway, or Azure OpenAI fronted by one) so code + transcripts stay in-tenant. Non-Bearer
auth goes in `COMPACTION_LLM_HEADERS` (e.g. Azure's `{"api-key": "..."}`). See
[`examples/vscode-mcp.enterprise-gateway.json`](./examples/vscode-mcp.enterprise-gateway.json).
Raw Azure OpenAI isn't drop-in (its URL is `/openai/deployments/{d}/chat/completions?api-version=…`),
so front it with a gateway rather than pointing the server at it directly.

On a **Copilot Enterprise/Business** plan there are also org-policy gates that block MCP
unless an admin opts in — see [`ENTERPRISE.md`](./ENTERPRISE.md) for the full deployment guide.

### Custom local-LLM agent loop (full control)

Use `COMPACTION_MODE=store`: feed each message through `turn_add`, poll `context_status`,
and call `context_compact` (no `transcript` arg) when it returns `compact-soon`/`compact-now`.

## Tool surface

`context_status`, `context_compact`, `context_trim`, `context_clear`, `turn_add`,
`handoff_brief`, `read_offloaded`, `offload_store`, `offload_fetch`, `recall`, `files_track`,
`files_untrack`, `files_rehydrate`, `rules_set`, `rules_append`, `rules_get`,
`ledger_record`, `ledger_query`, `ledger_snapshot`.

Resources: `compaction://session/{id}`, `compaction://rules/{id}`,
`compaction://ledger/{id}`, `compaction://summary/{id}/{boundaryId}`,
`compaction://handoff/{id}`, `compaction://blob/{handle}`.

## Keeping the window small: offloading

Re-seed recovers after the window is big; **offloading keeps it small in the first place**.
Instead of dumping a full file or command output into chat, `read_offloaded` / `offload_store`
stash it and return a short **digest + handle**; the agent pulls the full body (or a line
slice) via `offload_fetch` only when needed. On Copilot this only helps if the agent uses
`read_offloaded` instead of the native file-read tool. See `SPEC.md` §10B.

On hosts with their own retrieval (e.g. **Augment**), add `recall { query }`: it searches the
ledger + offloaded blobs for already-known facts/content so the agent doesn't re-pull the same
files. Instruct the agent to `recall` *before* querying the codebase. Ranking is **semantic**
when `COMPACTION_EMBED_MODEL` is set (e.g. Ollama `nomic-embed-text`), else lexical; `auto`
falls back gracefully. See `SPEC.md` §10C.

## Reclaiming tokens on Copilot: re-seed

On Copilot (`passthrough`), `context_compact` produces a great summary but **doesn't shrink
the live window** — the server can't evict the host's messages, so the summary is additive.
The way to actually reclaim tokens is **re-seed**: `compact → open a new chat → seed it from
`handoff_brief` → continue`. A new chat starts with an empty window.

`handoff_brief` returns the seed (rules + latest summary + ledger + files to re-open) and
**always writes it to disk** (and to `outPath`, e.g. `.compaction/handoff.md`), so a new chat
can attach the file even if MCP is blocked for the account. See `SPEC.md` §10A.

## Typical loop (passthrough)

1. `rules_set` — pin session-long rules (survive every boundary).
2. `files_track` — list active files to re-hydrate.
3. …work… `ledger_record` whenever something is verified.
4. `context_status` → `compact-soon`? → `context_compact { transcript, preserve }`.
5. Install the returned block; drop everything before `boundary`. Continue.

## Status

v0.1 scaffold — stub logic is wired end-to-end and typechecks; replace the token
estimator (§ `estimateTokens`) with a real tokenizer and harden hook sandboxing before
production. Roadmap in `SPEC.md` §13.
