#!/usr/bin/env node
/**
 * Custom local-LLM agent loop — DETERMINISTIC auto-compaction (store mode).
 *
 * Shows the pattern from SPEC §9: feed every message through `turn_add`; the server
 * auto-compacts when pressure crosses `nowPct` and returns the block under
 * `autoCompacted`. Your loop just installs it whenever present — no LLM judgment,
 * no polling `context_status`.
 *
 * Run:  COMPACTION_LLM_BASE_URL=http://localhost:11434/v1 node examples/agent-loop.mjs
 *       (server env is set below; point it at Ollama or any OpenAI-compatible endpoint)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, "..", "dist", "index.js");

const transport = new StdioClientTransport({
  command: "node",
  args: [serverEntry],
  env: {
    ...process.env,
    COMPACTION_MODE: "store",
    COMPACTION_AUTO: "true",
    COMPACTION_SUMMARIZER: process.env.COMPACTION_SUMMARIZER ?? "direct",
    COMPACTION_LLM_BASE_URL:
      process.env.COMPACTION_LLM_BASE_URL ?? "http://localhost:11434/v1",
    COMPACTION_LLM_MODEL: process.env.COMPACTION_LLM_MODEL ?? "qwen2.5-coder:14b",
    COMPACTION_TOKEN_BUDGET: process.env.COMPACTION_TOKEN_BUDGET ?? "8000",
    COMPACTION_ALLOWED_ROOTS: path.join(here, ".."),
  },
});

const client = new Client({ name: "agent-loop-demo", version: "1.0.0" });
await client.connect(transport);

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return JSON.parse(r.content[0].text);
};

const ctx = []; // your live context window (the host owns this)

// 0. Establish ONE session id up front and thread it through every call — otherwise each
//    tool call mints its own session and state (rules, ledger, turns) ends up disconnected.
const { sessionId } = await call("rules_set", {
  rules: "Always run the type-checker before claiming a fix works.",
});

// 1. Track active files for re-hydration after compaction.
await call("files_track", {
  sessionId,
  paths: [path.join(here, "..", "README.md")],
});

// 2. The loop: each turn goes through the server; install autoCompacted when it appears.
async function addTurn(role, content) {
  const res = await call("turn_add", { sessionId, role, content });
  ctx.push({ role, content });

  if (res.autoCompacted) {
    const b = res.autoCompacted;
    // Reset the live window to the compacted ground truth.
    ctx.length = 0;
    ctx.push({ role: "system", content: b.persistentRules });
    ctx.push({ role: "system", content: b.summary });
    for (const f of b.rehydratedFiles.filter((x) => x.ok)) {
      ctx.push({ role: "system", content: `FILE ${f.path}:\n${f.contents}` });
    }
    console.log(
      `↻ auto-compacted at ${b.boundary.tokensBefore}→${b.boundary.tokensAfter} tok; ` +
        `ledger kept ${b.ledgerSnapshot.length} entries; window reset to ${ctx.length} msgs`,
    );
    return true;
  }
  console.log(`+ turn (${res.pressurePct}% — ${res.recommendation})`);
  return false;
}

// Simulate work until pressure forces an auto-compact (cap iterations as a safety net).
await call("ledger_record", {
  sessionId,
  claim: "build passes on main",
  method: "npm run build",
  result: "pass",
  evidence: "exit 0",
});
for (let i = 0; i < 100; i++) {
  const compacted = await addTurn("user", `step ${i}: ` + "context filler ".repeat(40));
  if (compacted) break;
}

await client.close();
