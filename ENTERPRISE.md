# Deploying compaction-mcp with GitHub Copilot Enterprise (VS Code)

This guide covers running `compaction-mcp` in an organization on a **Copilot Enterprise**
(or **Copilot Business**) plan, through VS Code agent mode. It assumes you've read
[`SPEC.md`](./SPEC.md) §1 (why a server can't *do* `/compact`) and [`README.md`](./README.md).

> **TL;DR.** The `.vscode/mcp.json` is identical to plain Copilot, but Copilot Enterprise
> adds **org-policy gates** that block MCP entirely unless an admin opts in, and governance
> that forces the summarizer endpoint to stay in-tenant. Run in `passthrough` mode with a
> `direct` summarizer pointed at your internal LLM gateway, distribute via `npx` from your
> internal registry, and (if the org is on *Registry only*) get the server allowlisted.

---

## 1. Executive summary

| Dimension | Copilot Enterprise reality | What you do |
|---|---|---|
| MCP enabled? | Off by default on Business/Enterprise | Admin enables **"MCP servers in Copilot"** policy |
| Which servers may run | `Allow all` or `Registry only` | If `Registry only`, publish `compaction-mcp` to the org MCP registry |
| Summarizer model | Copilot's model is **not** exposed to MCP (no sampling) | Use `direct` → internal OpenAI-compatible gateway |
| Data residency | Transcript + code go to the summarizer | Keep the endpoint in your tenant/VPC |
| Trigger mode | Tools-only host → semi-manual | `passthrough` + `copilot-instructions.md`; deterministic auto needs a custom loop |
| Distribution | Don't make devs `git clone` + build | Publish an npm bin, run via `npx`, or ship a container |

---

## 2. Why these constraints exist

Copilot in VS Code is an **MCP host of the tools/resources/prompts kind**. Two facts drive
everything below:

1. **No sampling.** The Copilot MCP client does not implement `sampling/createMessage`, so
   the server cannot borrow Copilot's model to write the summary. The summarization
   inference must come from an endpoint the server calls itself (`COMPACTION_SUMMARIZER=direct`).
   `auto` is safe — it detects the missing capability and falls back to `direct`.
2. **No host-owned context API.** Copilot does not expose its context window to the server,
   so compaction is **passthrough**: the agent passes recent history into `context_compact`
   and installs the returned block. The server can't reach in and reset the window itself.

Everything else is org governance layered on top.

---

## 3. The policy gates (admin)

These are set by an org/enterprise owner; a developer cannot self-enable them.

### 3.1 Enable MCP for Copilot

`Organization Settings → Copilot → Policies → "MCP servers in Copilot" → Enabled`.

On Business/Enterprise this is **disabled by default**. While disabled, VS Code silently
ignores every `.vscode/mcp.json` — the server never starts and no error is obvious to the
developer. This is the most common "it doesn't work" cause.

### 3.2 Choose the allowlist mode

- **Allow all** — any MCP server a developer configures (including a local `.vscode/mcp.json`)
  may run. Simplest; relies on developer trust.
- **Registry only** — only servers published to the org's **internal MCP registry** may run.
  More secure and the typical Enterprise choice. A local `.vscode/mcp.json` pointing at an
  un-registered server will be **refused**.

If your org is on *Registry only*, §5 (distribution) is mandatory, not optional.

### 3.3 Admin checklist

- [ ] "MCP servers in Copilot" policy enabled for the org (and assigned to the right teams).
- [ ] Allowlist mode decided (`Allow all` vs `Registry only`).
- [ ] If `Registry only`: `compaction-mcp` published to the internal MCP registry.
- [ ] Internal LLM gateway endpoint + credential issuance documented for developers.
- [ ] Data-flow review signed off (§6) — the summarizer receives source + transcript.
- [ ] Approved distribution artifact chosen (internal npm package or container).

---

## 4. Summarizer & data governance

The summarizer call sends **the conversation transcript and re-hydrated file contents** to
whatever `COMPACTION_LLM_BASE_URL` points at. In an enterprise that data is sensitive, so:

- **Default to an internal OpenAI-compatible gateway** (LiteLLM, Portkey, Kong/Cloudflare AI
  Gateway) or **Azure OpenAI in your own tenant fronted by a gateway**. This keeps code and
  transcripts inside the company boundary and gives you spend tracking, rate limits, and
  audit logs for free.
- **Do not** default Enterprise users to GitHub Models free tier or public OpenAI — those
  rarely pass a data-residency review.
- **Auth:** put non-Bearer headers in `COMPACTION_LLM_HEADERS` (JSON). Examples:
  - Azure OpenAI (via gateway that preserves it): `{"api-key": "<key>"}`
  - Portkey virtual key: `{"Authorization": "Bearer <key>", "x-portkey-virtual-key": "vk_..."}`
  - Tenant routing: `{"x-tenant-id": "team-platform"}`
- **Raw Azure OpenAI is not drop-in.** Its URL is
  `/openai/deployments/{deployment}/chat/completions?api-version=…`, which `direct` does not
  build. Front it with a gateway that exposes a standard `/v1/chat/completions`.

### Data-flow diagram

```
VS Code (Copilot agent)
  │  calls tool: context_compact { transcript, preserve }
  ▼
compaction-mcp (stdio, local process)
  │  POST {BASE_URL}/chat/completions   ← transcript + ledger + rules + tracked file contents
  ▼
Internal LLM gateway (in tenant)  ──► Azure OpenAI / self-hosted model (in tenant)
  ▲
  │  returns dense summary
compaction-mcp
  │  returns compacted block { summary, rehydratedFiles, ledgerSnapshot, persistentRules }
  ▼
VS Code installs block as new ground truth
```

Nothing leaves the tenant if the gateway and model are in-tenant. Tracked files are read
from the developer's local disk and only sent to that same gateway.

---

## 5. Distribution (don't make devs build)

Three options, best first:

### 5.1 Internal npm package + `npx` (recommended)

Publish the built server to your internal npm registry as a `bin`, then reference it:

```jsonc
"command": "npx",
"args": ["-y", "@yourorg/compaction-mcp"]
```

`package.json` already declares the bin (`"compaction-mcp": "dist/index.js"`), so publishing
is just `npm publish` to your private registry. Devs get version pinning and auto-update via
the version range; no `git clone`, no local `npm run build`. (Publish CJS or ESM per your
internal-registry norms.)

### 5.2 Container

Ship a small image (`node:22-slim` + `dist/`) and run via `command: "docker"` /
`args: ["run", "--rm", "-i", "yourorg/compaction-mcp:0.1"]`. Pass env with `-e`. Good when
you want the summarizer creds injected by the platform rather than VS Code `inputs`.

### 5.3 Org MCP registry entry

For `Registry only` orgs, register the chosen artifact (npm or container) in the internal
MCP registry so it appears for developers under `@mcp` in the Extensions view and is allowed
to run. This is the admin-side counterpart to 5.1/5.2.

---

## 6. The `.vscode/mcp.json`

Commit this to the repo so the whole team shares it; secrets stay out of source control via
VS Code `inputs` (prompted once, stored encrypted). See
[`examples/vscode-mcp.enterprise-gateway.json`](./examples/vscode-mcp.enterprise-gateway.json).

```jsonc
{
  "inputs": [
    {
      "type": "promptString",
      "id": "llm-key",
      "description": "Internal LLM gateway key (compaction summaries)",
      "password": true
    }
  ],
  "servers": {
    "compaction": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@yourorg/compaction-mcp"],
      "env": {
        "COMPACTION_SUMMARIZER": "direct",
        "COMPACTION_LLM_BASE_URL": "https://llm-gateway.internal.example.com/v1",
        "COMPACTION_LLM_MODEL": "gpt-4o-mini",
        "COMPACTION_LLM_HEADERS": "{\"Authorization\": \"Bearer ${input:llm-key}\"}",
        "COMPACTION_MODE": "passthrough",
        "COMPACTION_ALLOWED_ROOTS": "${workspaceFolder}"
      }
    }
  }
}
```

> If the gateway authenticates with your existing SSO/Entra identity rather than a static
> key, drop the `inputs` block and `COMPACTION_LLM_HEADERS` and have the gateway handle auth
> at the network layer.

---

## 7. Triggering compaction in Copilot (semi-manual)

Copilot is tools-only, so the *agent* decides when to compact. Make that reliable with a
repo-level instructions file, `.github/copilot-instructions.md`:

```markdown
## Context hygiene
- For large files, use `read_offloaded` instead of reading the whole file into chat; fetch
  full content via `offload_fetch` only when you actually need it. Use `offload_store` for
  long command output. This keeps the window small from the start.
- Before searching the codebase or re-reading a file, call `recall` first — if a fact is in
  the ledger or a needed range is in an offloaded blob, reuse it instead of re-fetching.
- Before answering when the conversation has grown long, call `context_status`.
- If it returns `compact-soon`, `compact-now`, or `at-limit`, call `context_compact` with
  the recent conversation as `transcript`. If we are about to need exact error strings or
  function signatures, pass them in `preserve`.
- After compaction, treat the returned `summary` + `rehydratedFiles` + `persistentRules` as
  ground truth and ignore earlier history.
- Record every verified fact with `ledger_record` so it survives compaction.
- Put session-long rules in `rules_set`, never in chat (chat is lost at the boundary).
- When the window is still too big, build a `handoff_brief` and continue in a fresh chat.
```

Offloading only governs *this server's* tools — Copilot's built-in file-read/grep still dump
full content, so the instruction above (use `read_offloaded`) is what makes it effective.

This is guidance, not enforcement — model adherence varies. For **deterministic** auto-compaction
you need to own the loop (next section).

### 7.1 Re-seed is how you actually reclaim tokens on Copilot

In `passthrough`, `context_compact` **does not shrink Copilot's window** — the server can't
evict the host's messages, so the summary is additive. The real token win is to **start a
fresh chat seeded from a handoff brief**:

1. Call `handoff_brief` (optionally `outPath: ".compaction/handoff.md"`).
2. Open a **new** Copilot chat.
3. Seed it: attach/read the handoff file (or the `compaction://handoff/{id}` resource), then
   continue. The new chat starts with an empty window — tokens genuinely reclaimed.

**Robust against a blocked account.** If the org disables the MCP policy for your GHCP
account (§3.1), the server won't load at all — so `handoff_brief` **always writes the brief
to disk**, and `outPath` puts a copy in the workspace. A new chat can attach that markdown
file with **no MCP involved**, so re-seed keeps working even when the connector is blocked.
Commit `.compaction/` to `.gitignore` (it contains context snippets), or point `outPath` at a
scratch location your policy allows.

> Note: this also means the summarizer endpoint being blocked (e.g. GitHub Models via a
> managed GHCP token) only affects *generating* a new summary, not *reading* an existing
> handoff. Generate the brief while the endpoint works; re-seeding later needs only the file.

---

## 8. When you need true auto: a custom agent

If a team wants compaction driven by token math rather than model judgment, wrap the work in
your own agent loop using `COMPACTION_MODE=store` + `COMPACTION_AUTO=true` (see
[`examples/agent-loop.mjs`](./examples/agent-loop.mjs)). The loop feeds each message through
`turn_add`; the server auto-compacts at the `nowPct` threshold and returns the block under
`autoCompacted`. Point that loop's summarizer at the **same** internal gateway, so governance
is identical whether the developer is in Copilot or your custom agent.

This is the only path to deterministic auto-compaction on top of an Enterprise stack —
Copilot itself stays semi-manual.

---

## 9. Security notes

- **Hooks run with the server's privileges.** Keep `COMPACTION_HOOKS_ENABLED=false` unless a
  reviewed hooks file is in use; only enable from trusted, source-controlled config.
- **File access is fenced** by `COMPACTION_ALLOWED_ROOTS` — set it to `${workspaceFolder}` so
  re-hydration can't read outside the project.
- **Secrets**: prefer VS Code `inputs` (encrypted) or platform-injected env over hardcoding;
  never commit keys in `.vscode/mcp.json`.
- **State on disk**: sessions, rules, and the ledger persist under `COMPACTION_STATE_DIR`
  (`~/.compaction-mcp/sessions` by default). Treat it as containing snippets of source/context
  and locate it on encrypted storage if your policy requires.

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Server never appears in VS Code | "MCP servers in Copilot" policy off | Admin enables it (§3.1) |
| Configured but refused to start | Org is `Registry only`, server not registered | Publish + allowlist (§3.2, §5.3) |
| `E_SUMMARIZER_UNAVAILABLE` | Gateway URL/creds wrong, or pointed at raw Azure | Verify `BASE_URL`/headers; front Azure with a gateway (§4) |
| 401/403 from gateway | Bearer used where a custom header is required | Move auth into `COMPACTION_LLM_HEADERS` |
| Summaries drop exact errors/signatures | No preservation hint | Pass `preserve` to `context_compact`; record facts via `ledger_record` |
| Agent "forgets" verified work after compact | Facts not in the ledger | Always `ledger_record`; it's injected into the summary verbatim and re-emitted |
| Auto-compaction never fires | Copilot is `passthrough` (no auto) | Use a custom loop in `store` mode (§8) |

---

## 11. References

- About MCP for Copilot — <https://docs.github.com/en/copilot/concepts/context/mcp>
- Configure MCP server access for your org/enterprise — <https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-mcp-usage/configure-mcp-server-access>
- Managing policies for Copilot in your org — <https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/manage-policies>
- Internal MCP registry & allowlist controls — <https://github.blog/changelog/2025-09-12-internal-mcp-registry-and-allowlist-controls-for-vs-code-insiders/>
- VS Code MCP configuration reference — <https://code.visualstudio.com/docs/agents/reference/mcp-configuration>
