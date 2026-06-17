// Registers tools, resources, and prompts on the McpServer. See SPEC §5, §9, §10.
// NOTE: MCP tool names use `_` (some clients, incl. Copilot, reject `.`), so the
// spec's `context.compact` is implemented as `context_compact`, etc.
import { randomUUID } from "node:crypto";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import type { HooksConfig } from "./config.js";
import { runCompaction, type CompactArgs } from "./compact.js";
import { buildHandoffBrief } from "./handoff.js";
import { EmbeddingClient } from "./embeddings.js";
import { BlobStore } from "./offload.js";
import { buildSummarizePrompt } from "./prompts.js";
import { recall } from "./recall.js";
import { rehydrate } from "./rehydrate.js";
import { SessionStore, estimateTokens } from "./session.js";
import { makeSummarizer, type Summarizer } from "./summarizer.js";
import type { LedgerEntry, SessionState } from "./types.js";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function recommendation(cfg: Config, pct: number): string {
  if (pct >= cfg.limitPct) return "at-limit";
  if (pct >= cfg.nowPct) return "compact-now";
  if (pct >= cfg.proactivePct) return "compact-soon";
  return "ok";
}

export function registerAll(
  server: McpServer,
  cfg: Config,
  store: SessionStore,
  hooks: HooksConfig,
): void {
  // Summarizer is built lazily: client capabilities (for `auto`/`sampling`) are only
  // known after the transport connects.
  let summarizer: Summarizer | undefined;
  const getSummarizer = (): Summarizer => {
    if (!summarizer) summarizer = makeSummarizer(cfg, server.server);
    return summarizer;
  };

  const blobs = new BlobStore(cfg);
  const embedder = new EmbeddingClient(cfg);

  const compact = (s: SessionState, args: CompactArgs) =>
    runCompaction({ cfg, store, summarizer: getSummarizer(), hooks }, s, args);

  const pressurePct = (s: SessionState) =>
    Math.round((s.estTokensUsed / s.tokenBudget) * 100);

  // ---- Prompts (SPEC §5) ----
  server.registerPrompt(
    "compaction_summarize",
    {
      title: "Compaction summarize",
      description: "The summarization instruction used by context_compact.",
      argsSchema: {
        transcript: z.string(),
        preserve: z.string().optional(),
        persistentRules: z.string().optional(),
      },
    },
    ({ transcript, preserve, persistentRules }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: buildSummarizePrompt({ transcript, preserve, persistentRules }),
          },
        },
      ],
    }),
  );

  // ---- Resources (SPEC §10) ----
  server.registerResource(
    "session",
    new ResourceTemplate("compaction://session/{id}", { list: undefined }),
    { title: "Session state", mimeType: "application/json" },
    (uri, { id }) => {
      const s = store.resolve(String(id));
      return { contents: [{ uri: uri.href, text: JSON.stringify(s, null, 2) }] };
    },
  );

  server.registerResource(
    "rules",
    new ResourceTemplate("compaction://rules/{id}", { list: undefined }),
    { title: "Persistent rules", mimeType: "text/markdown" },
    (uri, { id }) => {
      const s = store.resolve(String(id));
      return { contents: [{ uri: uri.href, text: s.persistentRules }] };
    },
  );

  server.registerResource(
    "ledger",
    new ResourceTemplate("compaction://ledger/{id}", { list: undefined }),
    { title: "Verification ledger", mimeType: "application/json" },
    (uri, { id }) => {
      const entries = store.readLedger(String(id));
      return { contents: [{ uri: uri.href, text: JSON.stringify(entries, null, 2) }] };
    },
  );

  server.registerResource(
    "handoff",
    new ResourceTemplate("compaction://handoff/{id}", { list: undefined }),
    { title: "Re-seed handoff brief", mimeType: "text/markdown" },
    (uri, { id }) => {
      const s = store.resolve(String(id));
      const { brief } = buildHandoffBrief(cfg, store, s, {});
      return { contents: [{ uri: uri.href, text: brief }] };
    },
  );

  server.registerResource(
    "blob",
    new ResourceTemplate("compaction://blob/{handle}", { list: undefined }),
    { title: "Offloaded content", mimeType: "text/plain" },
    (uri, { handle }) => {
      const { content } = blobs.fetch(String(handle));
      return { contents: [{ uri: uri.href, text: content }] };
    },
  );

  // ---- Context tools (SPEC §9) ----
  server.registerTool(
    "context_status",
    {
      title: "Context status",
      description:
        "Report context pressure and a compaction recommendation (ok | compact-soon | compact-now | at-limit).",
      inputSchema: {
        sessionId: z.string().optional(),
        estTokensUsed: z
          .number()
          .optional()
          .describe("Host-reported current window usage; overrides server estimate."),
        tokenBudget: z.number().optional(),
      },
    },
    async ({ sessionId, estTokensUsed, tokenBudget }) => {
      const s = store.resolve(sessionId);
      if (tokenBudget) s.tokenBudget = tokenBudget;
      if (typeof estTokensUsed === "number") s.estTokensUsed = estTokensUsed;
      else store.recomputeUsage(s);
      store.save(s);
      const pct = Math.round((s.estTokensUsed / s.tokenBudget) * 100);
      return ok({
        sessionId: s.sessionId,
        tokenBudget: s.tokenBudget,
        estTokensUsed: s.estTokensUsed,
        pressurePct: pct,
        boundaryCount: s.boundaries.length,
        recommendation: recommendation(cfg, pct),
      });
    },
  );

  server.registerTool(
    "context_compact",
    {
      title: "Compact context",
      description:
        "Summarize accumulated history into a dense block, snapshot the ledger, re-hydrate tracked files, and run Pre/PostCompact hooks. Returns the compacted context block to install as new ground truth.",
      inputSchema: {
        sessionId: z.string().optional(),
        transcript: z
          .string()
          .optional()
          .describe("Required in passthrough mode: the full history to compact."),
        preserve: z
          .string()
          .optional()
          .describe("Extra preservation instructions, e.g. 'keep all exact error strings'."),
      },
    },
    async ({ sessionId, transcript, preserve }) => {
      const s = store.resolve(sessionId);
      const block = await compact(s, { transcript, preserve, reason: "manual" });
      return ok(block);
    },
  );

  server.registerTool(
    "context_trim",
    {
      title: "Trim context (tier-1 prune)",
      description:
        "Remove low-value/duplicate tool output without an inference call. Store mode only.",
      inputSchema: {
        sessionId: z.string().optional(),
        dropToolOutputOlderThanTurns: z.number().optional(),
      },
    },
    async ({ sessionId, dropToolOutputOlderThanTurns = 10 }) => {
      const s = store.resolve(sessionId);
      const before = s.turns.length;
      const cutoff = s.turns.length - dropToolOutputOlderThanTurns;
      s.turns = s.turns.filter(
        (t, i) => t.pinned || t.role !== "tool" || i >= cutoff,
      );
      store.recomputeUsage(s);
      store.save(s);
      return ok({ sessionId: s.sessionId, removed: before - s.turns.length });
    },
  );

  server.registerTool(
    "context_clear",
    {
      title: "Clear context (tier-3 reset)",
      description: "Hard reset turns and boundaries. Keeps rules and ledger by default.",
      inputSchema: {
        sessionId: z.string().optional(),
        keepRules: z.boolean().optional().default(true),
      },
    },
    async ({ sessionId, keepRules }) => {
      const s = store.resolve(sessionId);
      s.turns = [];
      s.boundaries = [];
      s.summaries = {};
      if (!keepRules) s.persistentRules = "";
      store.recomputeUsage(s);
      store.save(s);
      return ok({ sessionId: s.sessionId, cleared: true });
    },
  );

  // ---- Re-seed / handoff (SPEC §re-seed) ----
  server.registerTool(
    "handoff_brief",
    {
      title: "Build a re-seed handoff brief",
      description:
        "Produce a small, self-contained brief (rules + latest summary + verification ledger " +
        "+ active files) to START A FRESH CHAT with. This is how you actually reclaim tokens on " +
        "hosts that own their window (e.g. Copilot): open a new chat and seed it with this brief. " +
        "Always written to disk too, so a new chat can attach the file even if MCP is unavailable.",
      inputSchema: {
        sessionId: z.string().optional(),
        includeFileContents: z
          .boolean()
          .optional()
          .describe("Inline current file contents for a fully self-contained brief (larger)."),
        outPath: z
          .string()
          .optional()
          .describe("Also write the brief here (must be within allowed roots), e.g. .compaction/handoff.md"),
      },
    },
    async ({ sessionId, includeFileContents, outPath }) => {
      const s = store.resolve(sessionId);
      const res = buildHandoffBrief(cfg, store, s, { includeFileContents, outPath });
      return ok(res);
    },
  );

  // ---- Store-mode turn ingestion ----
  server.registerTool(
    "turn_add",
    {
      title: "Add a turn (store mode)",
      description:
        "Append a message to the server-held transcript. Store mode only. " +
        "When COMPACTION_AUTO=true and pressure crosses the compact-now threshold, " +
        "compaction fires automatically and the compacted block is returned under `autoCompacted`.",
      inputSchema: {
        sessionId: z.string().optional(),
        role: z.enum(["user", "assistant", "tool"]),
        content: z.string(),
        pinned: z.boolean().optional(),
      },
    },
    async ({ sessionId, role, content, pinned }) => {
      const s = store.resolve(sessionId);
      s.turns.push({
        id: randomUUID(),
        role,
        content,
        tokensEst: estimateTokens(content),
        pinned,
        createdAt: new Date().toISOString(),
      });
      store.recomputeUsage(s);
      store.save(s);

      // Auto-compact on ingest: deterministic, store mode only, opt-in.
      if (cfg.auto && cfg.mode === "store" && pressurePct(s) >= cfg.nowPct) {
        const block = await compact(s, { reason: "auto-threshold" });
        return ok({
          sessionId: s.sessionId,
          turns: s.turns.length,
          autoCompacted: block,
        });
      }

      return ok({
        sessionId: s.sessionId,
        turns: s.turns.length,
        pressurePct: pressurePct(s),
        recommendation: recommendation(cfg, pressurePct(s)),
      });
    },
  );

  // ---- Files (SPEC §9) ----
  server.registerTool(
    "files_track",
    {
      title: "Track files for re-hydration",
      description: "Mark files to silently re-read from disk on every compaction.",
      inputSchema: { sessionId: z.string().optional(), paths: z.array(z.string()) },
    },
    async ({ sessionId, paths }) => {
      const s = store.resolve(sessionId);
      s.trackedFiles = Array.from(new Set([...s.trackedFiles, ...paths]));
      store.save(s);
      return ok({ sessionId: s.sessionId, trackedFiles: s.trackedFiles });
    },
  );

  server.registerTool(
    "files_untrack",
    {
      title: "Untrack files",
      description: "Stop re-hydrating the given files.",
      inputSchema: { sessionId: z.string().optional(), paths: z.array(z.string()) },
    },
    async ({ sessionId, paths }) => {
      const s = store.resolve(sessionId);
      s.trackedFiles = s.trackedFiles.filter((p) => !paths.includes(p));
      store.save(s);
      return ok({ sessionId: s.sessionId, trackedFiles: s.trackedFiles });
    },
  );

  server.registerTool(
    "files_rehydrate",
    {
      title: "Re-hydrate files now",
      description: "Read tracked (or given) files from disk and return current contents.",
      inputSchema: { sessionId: z.string().optional(), paths: z.array(z.string()).optional() },
    },
    async ({ sessionId, paths }) => {
      const s = store.resolve(sessionId);
      return ok(rehydrate(cfg, paths ?? s.trackedFiles));
    },
  );

  // ---- Context offloading (SPEC §10B) ----
  server.registerTool(
    "read_offloaded",
    {
      title: "Read a file without loading it into context",
      description:
        "Read a file from disk and OFFLOAD it: returns a short digest (preview + structural " +
        "outline + line/byte counts) and a handle, instead of dumping the full contents into " +
        "the window. Prefer this over a normal file read for large files. Fetch the full body " +
        "only when needed via offload_fetch or the compaction://blob/{handle} resource.",
      inputSchema: {
        path: z.string(),
        label: z.string().optional(),
      },
    },
    async ({ path: p, label }) => ok(blobs.putFile(p, label)),
  );

  server.registerTool(
    "offload_store",
    {
      title: "Offload arbitrary text",
      description:
        "Stash large text (command output, grep results, logs, API payloads) as a blob and " +
        "return a digest + handle instead of putting it all in the window.",
      inputSchema: {
        label: z.string(),
        content: z.string(),
      },
    },
    async ({ label, content }) => ok(blobs.put(label, content)),
  );

  server.registerTool(
    "offload_fetch",
    {
      title: "Fetch offloaded content",
      description:
        "Retrieve a blob's full content, or a 1-indexed inclusive line slice. Use the smallest " +
        "slice that answers the question to keep the window small.",
      inputSchema: {
        handle: z.string(),
        startLine: z.number().optional(),
        endLine: z.number().optional(),
      },
    },
    async ({ handle, startLine, endLine }) => {
      const { meta, content } = blobs.fetch(handle, startLine, endLine);
      return {
        content: [
          { type: "text" as const, text: `# ${meta.label} (${meta.source ?? "text"})\n\n${content}` },
        ],
      };
    },
  );

  server.registerTool(
    "recall",
    {
      title: "Recall cached facts before retrieving",
      description:
        "Search the verification ledger + offloaded blobs for already-known facts and content. " +
        "CALL THIS BEFORE querying the codebase / context engine: a cached fact or a known blob " +
        "line range avoids pulling whole files back into the window (token saver, esp. on hosts " +
        "with their own retrieval like Augment). Semantic ranking when embeddings are configured, " +
        "else lexical. Returns ledger hits + blob hits with line ranges (use with offload_fetch).",
      inputSchema: {
        sessionId: z.string().optional(),
        query: z.string(),
        limit: z.number().optional(),
      },
    },
    async ({ sessionId, query, limit }) => {
      const s = store.resolve(sessionId);
      return ok(await recall(cfg, store, blobs, embedder, s.sessionId, query, { limit }));
    },
  );

  // ---- Rules (SPEC §7) ----
  server.registerTool(
    "rules_set",
    {
      title: "Set persistent rules",
      description: "Replace the CLAUDE.md-equivalent rules that survive every boundary.",
      inputSchema: { sessionId: z.string().optional(), rules: z.string() },
    },
    async ({ sessionId, rules }) => {
      const s = store.resolve(sessionId);
      s.persistentRules = rules;
      store.recomputeUsage(s);
      store.save(s);
      return ok({ sessionId: s.sessionId, bytes: rules.length });
    },
  );

  server.registerTool(
    "rules_append",
    {
      title: "Append to persistent rules",
      description: "Append a rule that survives every boundary.",
      inputSchema: { sessionId: z.string().optional(), rule: z.string() },
    },
    async ({ sessionId, rule }) => {
      const s = store.resolve(sessionId);
      s.persistentRules = `${s.persistentRules}\n${rule}`.trim();
      store.recomputeUsage(s);
      store.save(s);
      return ok({ sessionId: s.sessionId, bytes: s.persistentRules.length });
    },
  );

  server.registerTool(
    "rules_get",
    {
      title: "Get persistent rules",
      description: "Return the current persistent rules.",
      inputSchema: { sessionId: z.string().optional() },
    },
    async ({ sessionId }) => {
      const s = store.resolve(sessionId);
      return ok({ sessionId: s.sessionId, rules: s.persistentRules });
    },
  );

  // ---- Verification ledger (SPEC §7) ----
  server.registerTool(
    "ledger_record",
    {
      title: "Record a verification",
      description:
        "Append an entry to the verification ledger (maker/checker). Survives compaction; verified results are copied verbatim into summaries.",
      inputSchema: {
        sessionId: z.string().optional(),
        claim: z.string(),
        method: z.string(),
        result: z.enum(["pass", "fail", "inconclusive"]),
        evidence: z.string(),
        by: z.enum(["maker", "checker", "agent"]).optional().default("agent"),
        supersedes: z.string().optional(),
      },
    },
    async ({ sessionId, claim, method, result, evidence, by, supersedes }) => {
      const s = store.resolve(sessionId);
      const entry: LedgerEntry = {
        id: randomUUID(),
        at: new Date().toISOString(),
        claim,
        method,
        result,
        evidence,
        by: by ?? "agent",
        supersedes,
      };
      store.appendLedger(s.sessionId, entry);
      return ok(entry);
    },
  );

  server.registerTool(
    "ledger_query",
    {
      title: "Query the verification ledger",
      description: "Filter ledger entries by claim substring and/or result.",
      inputSchema: {
        sessionId: z.string().optional(),
        claimContains: z.string().optional(),
        result: z.enum(["pass", "fail", "inconclusive"]).optional(),
      },
    },
    async ({ sessionId, claimContains, result }) => {
      const s = store.resolve(sessionId);
      let entries: LedgerEntry[] = store.readLedger(s.sessionId);
      if (claimContains)
        entries = entries.filter((e) => e.claim.includes(claimContains));
      if (result) entries = entries.filter((e) => e.result === result);
      return ok(entries);
    },
  );

  server.registerTool(
    "ledger_snapshot",
    {
      title: "Snapshot the ledger",
      description: "Return the full current ledger (used at boundaries for re-injection).",
      inputSchema: { sessionId: z.string().optional() },
    },
    async ({ sessionId }) => {
      const s = store.resolve(sessionId);
      return ok(store.readLedger(s.sessionId));
    },
  );
}

// re-export for index.ts typing convenience
export type { SessionState };
