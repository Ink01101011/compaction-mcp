# Examples

Configs and a runnable agent loop. Build the server first: `npm install && npm run build`.

| File | Host | Summarizer | Notes |
|---|---|---|---|
| [`vscode-mcp.ollama.json`](./vscode-mcp.ollama.json) | Copilot (VS Code) | `direct` → Ollama | Fully local; copy to `.vscode/mcp.json` |
| [`vscode-mcp.github-models.json`](./vscode-mcp.github-models.json) | Copilot (VS Code) | `direct` → GitHub Models | **No Ollama**; free, OpenAI-compatible; prompts for a `models: read` token |
| [`vscode-mcp.enterprise-gateway.json`](./vscode-mcp.enterprise-gateway.json) | Copilot (VS Code) | `direct` → internal gateway | In-tenant LiteLLM/Portkey/Azure; uses `COMPACTION_LLM_HEADERS` for custom auth |
| [`claude-desktop-config.json`](./claude-desktop-config.json) | Claude Desktop | `auto` → sampling | Uses the host's own model; no endpoint/key |
| [`agent-loop.mjs`](./agent-loop.mjs) | Custom loop | `direct` | **Deterministic auto-compaction** in `store` mode |
| [`hooks.example.json`](./hooks.example.json) | any | — | PreCompact/PostCompact wiring; point `COMPACTION_HOOKS` at it |
| [`scripts/`](./scripts/) | any | — | Sample hook scripts (progress dump, ledger re-inject) |

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
