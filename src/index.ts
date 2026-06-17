#!/usr/bin/env node
// compaction-mcp entry point — stdio transport. See SPEC.md §3.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { loadHooks } from "./hooks.js";
import { registerAll } from "./register.js";
import { SessionStore } from "./session.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new SessionStore(cfg);
  const hooks = loadHooks(cfg);

  const server = new McpServer(
    { name: "compaction-mcp", version: "0.1.0" },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions:
        "Context compaction for agentic coding. Call context_status to gauge pressure; " +
        "context_compact to summarize + re-hydrate files + snapshot the verification ledger. " +
        "Install the returned compacted context block as the new ground truth, then discard " +
        "pre-boundary history. Put session-long rules in rules_set so they survive every boundary.",
    },
  );

  registerAll(server, cfg, store, hooks);

  // stderr only — stdout is reserved for JSON-RPC.
  process.stderr.write(
    `[compaction-mcp] ready (mode=${cfg.mode}, summarizer=${cfg.summarizer}, model=${cfg.llm.model})\n`,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[compaction-mcp] fatal: ${err}\n`);
  process.exit(1);
});
