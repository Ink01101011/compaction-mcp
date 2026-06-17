# Examples

Configs and a runnable agent loop. Build the server first: `npm install && npm run build`.

| File | Host | Summarizer | Notes |
|---|---|---|---|
| [`vscode-mcp.ollama.json`](./vscode-mcp.ollama.json) | Copilot (VS Code) | `direct` → Ollama | Fully local; copy to `.vscode/mcp.json` |
| [`vscode-mcp.github-models.json`](./vscode-mcp.github-models.json) | Copilot (VS Code) | `direct` → GitHub Models | **No Ollama**; free, OpenAI-compatible; prompts for a `models: read` token |
| [`vscode-mcp.enterprise-gateway.json`](./vscode-mcp.enterprise-gateway.json) | Copilot (VS Code) | `direct` → internal gateway | In-tenant LiteLLM/Portkey/Azure; uses `COMPACTION_LLM_HEADERS` for custom auth |
| [`claude-desktop-config.json`](./claude-desktop-config.json) | Claude Desktop | `auto` → sampling | Uses the host's own model; no endpoint/key |
| [`augment-settings.json`](./augment-settings.json) | Augment Code | `direct` + semantic recall | `~/.augment/settings.json`; pairs `recall`/offload/re-seed with Augment's Context Engine |
| [`augment-instructions.md`](./augment-instructions.md) | Augment Code | — | Recall-first guidelines so it complements (not duplicates) Augment |
| [`agent-loop.mjs`](./agent-loop.mjs) | Custom loop | `direct` | **Deterministic auto-compaction** in `store` mode |
| [`hooks.example.json`](./hooks.example.json) | any | — | PreCompact/PostCompact wiring; point `COMPACTION_HOOKS` at it |
| [`scripts/`](./scripts/) | any | — | Sample hook scripts (progress dump, ledger re-inject) |

## Augment Code

Augment has its own Context Engine + Memories, so use compaction-mcp only for what it
*doesn't* do: a verified-fact cache (`recall`), ephemeral non-code offloading, and re-seed.

Add the server either by editing `~/.augment/settings.json` (see
[`augment-settings.json`](./augment-settings.json)) or via the CLI:

```bash
auggie mcp add-json compaction '{"command":"node","args":["'"$PWD"'/compaction-mcp/dist/index.js"],"env":{"COMPACTION_MODE":"passthrough","COMPACTION_ALLOWED_ROOTS":"'"$PWD"'","COMPACTION_SUMMARIZER":"direct","COMPACTION_LLM_BASE_URL":"http://localhost:11434/v1","COMPACTION_LLM_MODEL":"qwen2.5-coder:14b","COMPACTION_RECALL_MODE":"auto","COMPACTION_EMBED_MODEL":"nomic-embed-text"}}'

auggie mcp list          # verify; check /mcp inside Auggie
```

Notes:
- `"enableToolSearch": true` keeps Augment from loading all 19 tool schemas up front.
- Add the guidelines in [`augment-instructions.md`](./augment-instructions.md) so the agent
  calls `recall` before re-querying the Context Engine.

## Which summarizer for which host?

- **Ollama / local** → `direct` + `http://localhost:11434/v1`. Nothing leaves the machine.
- **Copilot, no Ollama** → `direct` + GitHub Models (or OpenAI/OpenRouter/Groq). Copilot
  can't lend its model to MCP servers (no sampling), so an external endpoint is required.
- **Claude Desktop** → `auto`; it supports sampling, so the summary runs on the host model.

## Run the agent-loop demo

```bash
npm run build
# local Ollama:
node examples/agent-loop.mjs
# or any OpenAI-compatible endpoint:
COMPACTION_LLM_BASE_URL=https://models.github.ai/inference \
COMPACTION_LLM_MODEL=openai/gpt-4o-mini \
COMPACTION_LLM_API_KEY=$GITHUB_TOKEN \
COMPACTION_SUMMARIZER=direct \
node examples/agent-loop.mjs
```

Expected: a few `+ turn (…%)` lines, then a `↻ auto-compacted …` line once pressure
crosses the threshold and the window is reset to the compacted ground truth.
