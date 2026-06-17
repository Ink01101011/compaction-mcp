# compaction-mcp — Specification v0.1

A portable **MCP stdio server** that brings Claude Code's `/compact` lifecycle to any
MCP host — GitHub Copilot (VS Code), Claude Desktop, or a custom local-LLM agent loop
(e.g. Qwen-Coder via Ollama).

It exposes context compaction as a set of **tools + resources + prompts** so the host's
agent can: track context pressure, compact accumulated history into a high-fidelity
summary, re-hydrate live files from disk, persist decisions/instructions across the
`compact_boundary`, and keep a **verification ledger** that survives compaction.

> Reference for the concept this mirrors: <https://code.claude.com/docs/en/how-claude-code-works>

---

## 1. The core constraint (read this first)

In Claude Code, `/compact` is a **host-level** operation: the CLI *owns* the context
window, so it can transparently summarize history, drop low-value tool output, set a
boundary, and silently re-read open files.

An MCP **server cannot do this**. MCP servers have no access to the host's context
window — they can only expose tools/resources/prompts and respond to calls. So this spec
splits the mechanism into two halves:

| Concern | Owner | Why |
|---|---|---|
| Deciding *when* to compact | **Host / agent loop** | Only the host knows real token usage |
| Holding the canonical working transcript | **Server** (opt-in) or host | Server can be source of truth if host can't reset itself |
| Producing the summary (inference call) | **Server** (direct) or **Host** (sampling) | Portability — see §6 |
| Re-reading live files from disk | **Server** | Server has filesystem access |
| Persisting decisions / ledger across boundary | **Server** | Must outlive the window |
| Re-injecting surviving state after compaction | **Host** (consumes server output) | Only host writes its own context |

The server provides the **mechanism**; each host wires it in differently (§9). The
server never assumes it can mutate the host's window — it returns a **compacted context
block** that the host injects as its new ground truth.

---

## 2. Concepts → MCP primitives

The 6-stage mental model from the concept, mapped to concrete MCP surface:

| Concept (Claude Code) | This server |
|---|---|
| 3-tier context mgmt (prune → compact → clear) | `context.trim` (prune), `context.compact` (summarize), `context.clear` (reset) tools |
| Compaction = separate model call, not truncation | `context.compact` runs a real summarizer call (§6) |
| `compact_boundary` marker | `SessionState.boundaries[]`, returned in every compact result + `compaction://session/{id}` resource |
| File re-hydration from disk | `files.rehydrate` tool + auto-rehydrate inside `context.compact` |
| Lossy compression — what survives vs lost | Preservation policy + `prompt: compaction/summarize` template (§5) |
| Manual vs auto trigger (~60% proactive, ~95% safety) | `context.status` reports pressure; host calls `context.compact` (manual) or uses thresholds (auto) |
| `/compact <instructions>` customization | `context.compact` `preserve` arg |
| `CLAUDE.md` re-injected every turn | "persistent rules" stored as a resource, always re-emitted post-compact (§7) |
| PreCompact / PostCompact hooks | `hooks` config + `hook.run` lifecycle (§8) |
| Verification ledger (maker/checker) | `ledger.*` tools + `compaction://ledger/{id}` resource (§7) |

---

## 3. Server identity & transport

- **Transport:** stdio only (v0.1). One server process per agent session, spawned by the host.
- **Server name:** `compaction-mcp`
- **Protocol:** MCP (JSON-RPC 2.0 over stdio), SDK `@modelcontextprotocol/sdk`.
- **Capabilities advertised:** `tools`, `resources`, `prompts`. `sampling` is *consumed
  from the host* when available (not advertised by the server).
- **Logging:** never write to `stdout` (reserved for JSON-RPC). Use `stderr` or MCP
  `logging` notifications.

---

## 4. Session model

A **session** is one logical agent run. The host passes a stable `sessionId` (or the
server mints one on first call and returns it). Session state is held in memory and
mirrored to disk at `${COMPACTION_STATE_DIR}/<sessionId>/` so it survives a host restart.

```ts
interface SessionState {
  sessionId: string;
  createdAt: string;            // ISO
  // Working transcript the server holds when operating in "store" mode (§9.C).
  // In "passthrough" mode the host sends history into context.compact and this stays empty.
  turns: Turn[];
  boundaries: CompactBoundary[]; // append-only
  trackedFiles: string[];        // absolute paths, re-hydrated on compact
  persistentRules: string;       // CLAUDE.md-equivalent, always survives
  tokenBudget: number;           // host-declared window size (tokens)
  estTokensUsed: number;         // running estimate, updated by host or server
}

interface Turn {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  tokensEst: number;
  pinned?: boolean;              // never dropped by trim/compact
  createdAt: string;
}

interface CompactBoundary {
  id: string;
  at: string;                    // ISO timestamp
  reason: "manual" | "auto-threshold" | "host-requested";
  turnsBefore: number;           // count summarized
  tokensBefore: number;
  tokensAfter: number;
  summaryRef: string;            // resource URI of the produced summary
  preserveInstruction?: string;  // the `/compact <instructions>` text, if any
  ledgerSnapshotRef?: string;    // ledger state captured at boundary
}
```

**Boundary semantics (critical):** anything before a `CompactBoundary` must be treated
as **not verbatim-addressable** — only the summary + pinned turns + persistent rules +
re-hydrated files survive. Host orchestration code MUST NOT depend on pre-boundary
messages being intact. This is the same contract as Claude Code's `compact_boundary`.

---

## 5. Prompts (compaction templates)

Exposed as MCP **prompts** so hosts/users can inspect and override them.

### `compaction/summarize`
Arguments: `transcript` (string), `preserve` (string, optional), `persistentRules`
(string, optional). Produces the summarization instruction sent to the summarizer
backend. Default body enforces the lossy-compression policy:

```
You are compacting an agentic coding session's context.
Produce a DENSE summary that preserves, in priority order:
1. Architectural decisions and WHY they were made.
2. The current task and its acceptance criteria.
3. Verified facts (see VERIFICATION LEDGER below) — copy exact results verbatim.
4. Exact error strings, function signatures, and API contracts referenced.
5. Open questions / next steps.

DROP: redundant tool output, superseded attempts, resolved chatter.
NEVER drop anything in <preserve> or <persistent-rules>.
Output Markdown. Be terse. No preamble.

<persistent-rules>{persistentRules}</persistent-rules>
<preserve>{preserve}</preserve>
<transcript>{transcript}</transcript>
```

### `compaction/rehydrate-note`
Small template that frames re-hydrated file contents so the agent treats disk as the
source of truth for code (and the summary as source of truth for reasoning).

---

## 6. Summarizer backends — portability (the §1.3 question, resolved)

`context.compact` needs an inference call. `sampling` (server asks the host's LLM) is the
cleanest but **GitHub Copilot's MCP client does not support sampling**, and most clients
don't. So the backend is configurable, defaulting to the portable option.

`COMPACTION_SUMMARIZER`:

- **`direct`** *(default)* — server calls an OpenAI-compatible `/chat/completions`
  endpoint itself. Works on **every** host because it needs no host capability. Configure
  `COMPACTION_LLM_BASE_URL` (e.g. `http://localhost:11434/v1` for Ollama),
  `COMPACTION_LLM_MODEL` (e.g. `qwen2.5-coder:14b`), `COMPACTION_LLM_API_KEY` (optional),
  `COMPACTION_LLM_HEADERS` (optional JSON of extra request headers — for Azure's `api-key`,
  enterprise gateway tokens, or tenant-routing headers; these override the default `Bearer`).
  Enterprise note: raw Azure OpenAI is *not* drop-in (`/openai/deployments/{d}/chat/completions?api-version=…`);
  front it with an OpenAI-compatible gateway (LiteLLM/Portkey/…) and keep the endpoint in-tenant
  so transcript + code never leave the org.
- **`sampling`** — server issues an MCP `sampling/createMessage` request; the host runs
  the completion with its own model. Use only with sampling-capable hosts (Claude
  Desktop). Zero extra infra, and the summary uses the same model the agent uses.
- **`auto`** — probe host capabilities at `initialize`; if `sampling` is offered use it,
  else fall back to `direct`. Recommended for mixed fleets.

The summarizer is a single interface so adding Anthropic/other providers is one file:

```ts
interface Summarizer {
  summarize(input: { prompt: string; maxTokens?: number }): Promise<string>;
}
```

---

## 7. Persistence: rules + verification ledger

Two things must survive every boundary (the "instructions get lost at compact" failure
mode from the concept):

### Persistent rules (CLAUDE.md-equivalent)
Stored at `${stateDir}/<sessionId>/RULES.md`, surfaced as resource
`compaction://rules/{sessionId}`, and **always concatenated into the post-compact
context block**. Tools: `rules.set`, `rules.append`, `rules.get`.

### Verification ledger (maker/checker support)
The defense against *verification debt* — the agent "forgetting" what it already checked
after a compact. Append-only JSONL at `${stateDir}/<sessionId>/ledger.jsonl`, surfaced as
`compaction://ledger/{sessionId}`.

```ts
interface LedgerEntry {
  id: string;
  at: string;
  claim: string;              // "auth.refreshToken() rejects expired tokens"
  method: string;             // "unit test", "manual repro", "type-check"
  result: "pass" | "fail" | "inconclusive";
  evidence: string;           // exact output / command / file:line
  by: "maker" | "checker" | "agent";
  supersedes?: string;        // id of a prior entry this invalidates
}
```

Tools: `ledger.record`, `ledger.query` (by claim/result), `ledger.snapshot` (capture
current state at a boundary). The ledger is injected into the summarize prompt (§5 item 3)
so verified results are copied verbatim into the summary, and re-emitted post-compact.

---

## 8. Hooks: PreCompact / PostCompact

Configured via `COMPACTION_HOOKS` pointing at a JSON file, or inline env. Each hook is a
shell command run by the server at the lifecycle point. Mirrors Claude Code's hooks.

```jsonc
{
  "PreCompact":  [{ "command": "scripts/dump-progress.sh", "timeoutMs": 5000 }],
  "PostCompact": [{ "command": "scripts/reinject.sh",      "timeoutMs": 5000 }]
}
```

**Lifecycle of `context.compact`:**

1. **PreCompact hooks** run. Receive session JSON on `stdin` (id, boundary draft, token
   stats). Use to dump state to disk (progress notes, ledger flush). Non-zero exit aborts
   compaction unless `continueOnError: true`.
2. `ledger.snapshot` is captured automatically and attached to the boundary.
3. Transcript (host-supplied or server-held) + ledger + rules → summarizer (§6).
4. Boundary appended; pre-boundary turns marked non-addressable; tracked files re-hydrated.
5. **PostCompact hooks** run. `stdout` of each hook is captured and appended to the
   `extraContext` field of the result, letting hooks re-inject anything.
6. Result returned: `{ summary, persistentRules, rehydratedFiles[], ledgerSnapshot,
   boundary, extraContext }` — the **compacted context block** the host installs.

Maker/checker pattern, end to end: PreCompact writes the ledger to disk → snapshot taken
→ summary copies verified results verbatim → PostCompact re-injects the ledger resource →
agent never re-verifies what's already proven.

---

## 9. Tool reference

All tools take `sessionId` (string, optional on first call — server mints + returns it).

> **Naming:** dotted names below are conceptual namespaces. Since some MCP clients
> (incl. Copilot) reject `.` in tool names, the implementation uses `_`:
> `context.compact` → `context_compact`, `ledger.record` → `ledger_record`, etc.

### Context
- **`context.status`** → `{ tokenBudget, estTokensUsed, pressurePct, boundaryCount,
  recommendation }`. `recommendation` is `"ok" | "compact-soon" (>=60%) | "compact-now"
  (>=85%) | "at-limit" (>=95%)`, mirroring the proactive-vs-safety-net guidance.

  **Manual by default.** The server is reactive — it never compacts on its own; the host
  decides when to call `context.compact`. The one exception is **auto-compact-on-ingest**
  (`COMPACTION_AUTO=true`, store mode only): `turn.add` checks pressure after each turn and,
  if it crosses `nowPct`, runs compaction inline and returns the block under
  `autoCompacted`. This makes auto behavior *deterministic* (driven by token math, not LLM
  judgment). Passthrough mode stays manual because the server doesn't hold continuous history.
- **`context.trim`** `{ maxTokens?, dropToolOutputOlderThan? }` → tier-1 prune: removes
  low-value/duplicate tool output without an inference call. Returns tokens reclaimed.
- **`context.compact`** `{ transcript?, preserve?, force? }` → the main operation (§8).
  `transcript` required in passthrough mode, ignored in store mode. Returns the compacted
  context block.
- **`context.clear`** `{ keepRules?: boolean }` → tier-3 hard reset; keeps rules + ledger
  by default, wipes turns and boundaries.

### Files
- **`files.track`** `{ paths: string[] }` / **`files.untrack`** `{ paths }`.
- **`files.rehydrate`** `{ paths? }` → reads tracked (or given) files from disk now,
  returns current contents. Called automatically inside `context.compact`.

### Rules & ledger
- **`rules.set` / `rules.append` / `rules.get`** (§7).
- **`ledger.record` / `ledger.query` / `ledger.snapshot`** (§7).

### Re-seed
- **`handoff.brief`** `{ includeFileContents?, outPath? }` → builds a small self-contained
  brief (marker + rules + latest summary + ledger + active file list) to **start a fresh
  chat** with. Always written to `${stateDir}/<id>/handoff.md`; `outPath` also writes it
  into the workspace. See §10A.

### Integration modes (config `COMPACTION_MODE`)
- **`store`** — server holds the transcript; host calls `turn.add` after each message and
  `context.compact` with no transcript arg. Best for **custom agent loops** with full control.
- **`passthrough`** *(default)* — host owns history, passes it into `context.compact`.
  Best for hosts where you can't intercept every message (**Copilot**): the agent calls
  `context.compact` as a tool and installs the returned block as the new ground truth.

(In store mode add: **`turn.add`** `{ role, content, pinned? }`. With `COMPACTION_AUTO=true`
it returns `autoCompacted` when the added turn crosses `nowPct`.)

---

## 10. Resources

| URI | Contents |
|---|---|
| `compaction://session/{id}` | Full `SessionState` JSON (boundaries, stats) |
| `compaction://rules/{id}` | Persistent rules Markdown |
| `compaction://ledger/{id}` | Verification ledger (JSONL → JSON array) |
| `compaction://summary/{id}/{boundaryId}` | A specific produced summary |
| `compaction://handoff/{id}` | Re-seed brief for starting a fresh chat (§10A) |

Resources let sampling-incapable hosts (Copilot) *read* state into context via the host's
resource-attachment UI, even when they can't run sampling.

## 10A. Re-seed / handoff — reclaiming tokens on host-owned windows

A server cannot evict messages from a host's window (§1). So on **passthrough hosts like
Copilot, `context.compact` does not actually shrink the live window** — the summary is
*additive*; the verbose history is still there, and the host's own internal trimming is
what eventually reclaims space. Compaction's value there is a high-quality summary + ledger,
not token relief.

The reliable way to reclaim tokens depends on who owns the window:

| Host | How "read the summary, not the history" is enforced | Real token relief? |
|---|---|---|
| Host-owned window (Claude Code) | Host replaces messages with the summary | Yes (in-place) |
| Custom loop, `store` mode | Your loop rebuilds the message array from the compacted block | Yes (in-place) |
| Copilot, `passthrough` | Best-effort: instructions + recency; **or re-seed** | Only via re-seed |

**Re-seed** is the practical answer for Copilot: opening a **new chat** starts a genuinely
empty window. `handoff.brief` produces the seed (rules + latest summary + verification ledger
+ files to re-open). The flow is *compact → new chat → seed from the brief → continue*.

**Survives MCP being blocked.** If org policy disables MCP for the account, the server won't
load — so the brief is **always also written to disk** (and to `outPath` in the workspace,
e.g. `.compaction/handoff.md`). A new chat can attach/read that file with no MCP at all,
making re-seed robust even when the connector is unavailable.

## 10B. Context offloading — keeping the window small proactively

Re-seed (§10A) recovers *after* the window is big. Offloading prevents it from getting big.
The dominant token sink in agentic coding is **tool output** — full file reads, grep dumps,
command logs. Offloading replaces "dump the blob into chat" with "store the blob, return a
**digest + handle**". The model sees a preview + a ranked structural outline + line/byte
counts, and pulls the full body (or a line slice) **only when it actually needs it**.

Tools: `read_offloaded` (read a file from disk → store full, return digest), `offload_store`
(stash arbitrary text — command output, logs, payloads), `offload_fetch`
`{ handle, startLine?, endLine? }` (retrieve full or a slice). Resource:
`compaction://blob/{handle}` (full content).

The digest ranks declarations so a flood of trivial lines (e.g. 200 `const` rows) can't
crowd out the `function` / `class` / `interface` / heading skeleton.

**Caveat (Copilot):** offloading only controls *this server's* tool output. Copilot's
built-in file-read / grep tools still dump full content. To get the benefit, route file
access through `read_offloaded` (and instruct the agent accordingly) rather than the native
tools — or use offloading in a custom agent loop where you choose every tool.

## 10C. Recall cache — avoid re-retrieval (esp. on Augment)

Hosts with their own retrieval (Augment's Context Engine, etc.) save you nothing if the agent
keeps re-pulling the same code. `recall { query }` searches the **verification ledger** (already
-proven facts) and **offloaded blobs** (already-fetched content) and returns distilled hits:
ledger facts with evidence, and blob matches with **line snippets + handle** so the agent can
`offload_fetch { handle, startLine, endLine }` exactly the range it needs.

The discipline: **`recall` before querying the codebase / context engine.** A cache hit reuses
a fact or a known line range instead of pulling whole files back into the window. This layers
*on top of* Augment rather than duplicating it — Augment finds code; recall remembers what was
already found and proven, so it isn't fetched twice.

**Two scorers, configurable (`COMPACTION_RECALL_MODE`):**

- **`embed`** — semantic ranking via an OpenAI-compatible `/embeddings` endpoint
  (`COMPACTION_EMBED_MODEL`, e.g. Ollama `nomic-embed-text`; `COMPACTION_EMBED_BASE_URL`
  defaults to the summarizer endpoint). Blobs are chunked into ~40-line windows so a hit
  returns a **line range** to `offload_fetch`. Vectors are cached on disk by content hash, so
  recall only embeds new text + the query.
- **`lexical`** — dependency-free term overlap; label/source weighted above content. Zero infra.
- **`auto`** *(default)* — semantic when an embed model is set and the endpoint answers, else
  falls back to lexical (logged to stderr). Same graceful-degradation contract as the summarizer.

Semantic catches matches lexical misses — e.g. query *"expired credentials"* still ranks a
ledger fact phrased *"token validation handles expiry"* (no shared words).

---

## 11. Error model

JSON-RPC errors with `data.code`:

- `E_NO_SESSION` — unknown sessionId.
- `E_NO_TRANSCRIPT` — passthrough mode, `context.compact` called without `transcript`.
- `E_SUMMARIZER_UNAVAILABLE` — direct backend endpoint unreachable / sampling unsupported
  in `sampling` mode. (`auto` degrades instead of erroring.)
- `E_HOOK_FAILED` — a hook exited non-zero without `continueOnError`.
- `E_FILE_UNREADABLE` — tracked file missing on rehydrate (returned per-file, non-fatal).

---

## 12. Security

- File access is restricted to `COMPACTION_ALLOWED_ROOTS` (colon-separated). `files.track`
  rejects paths outside roots.
- Hook commands run with the server's privileges — document this; only enable hooks from
  trusted config. `COMPACTION_HOOKS_ENABLED=false` disables all hook execution.
- The direct summarizer may send transcript content to an external endpoint; default base
  URL is localhost (Ollama) so nothing leaves the machine unless configured otherwise.

---

## 13. Versioning & roadmap

- v0.1 (this doc): stdio, store/passthrough modes, direct/sampling/auto summarizer, ledger, hooks.
- v0.2 (planned): Streamable HTTP transport; automatic token counting via tokenizer;
  multi-session GC; `context.trim` semantic dedup.
