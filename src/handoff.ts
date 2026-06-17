// Session re-seed / handoff. See SPEC.md §re-seed.
// Produces a small, self-contained brief to start a FRESH chat/session with — the only way
// to actually reclaim tokens on hosts that own their own window (e.g. Copilot): you don't
// shrink the old window, you start a new one seeded from this brief.
//
// The brief is ALWAYS written to disk so it survives even when MCP itself is blocked by org
// policy — a new chat can just read/attach the file without the server running.
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { isPathAllowed } from "./rehydrate.js";
import type { SessionStore } from "./session.js";
import type { LedgerEntry, SessionState } from "./types.js";

export const HANDOFF_MARKER =
  "=== COMPACTED HANDOFF — AUTHORITATIVE GROUND TRUTH ===\n" +
  "You are resuming a coding session in a fresh context. Treat everything below as the " +
  "single source of truth. Re-open the listed files from disk before editing. Do not ask " +
  "to re-derive what the verification ledger already proves.";

function latestSummary(s: SessionState): string | undefined {
  const last = s.boundaries[s.boundaries.length - 1];
  return last ? s.summaries[last.id] : undefined;
}

function renderLedger(entries: LedgerEntry[]): string {
  if (!entries.length) return "_(no verified facts recorded)_";
  // Collapse superseded entries.
  const superseded = new Set(entries.map((e) => e.supersedes).filter(Boolean) as string[]);
  return entries
    .filter((e) => !superseded.has(e.id))
    .map((e) => `- **[${e.result.toUpperCase()}]** ${e.claim} — _${e.method}_, ${e.by} :: ${e.evidence}`)
    .join("\n");
}

export interface HandoffOptions {
  /** include current file contents inline (larger brief, but fully self-contained) */
  includeFileContents?: boolean;
  /** also write the brief to this workspace-relative or absolute path (must be in allowed roots) */
  outPath?: string;
}

export interface HandoffResult {
  sessionId: string;
  brief: string;
  /** absolute paths the brief was written to */
  writtenTo: string[];
}

export function buildHandoffBrief(
  cfg: Config,
  store: SessionStore,
  session: SessionState,
  opts: HandoffOptions,
): HandoffResult {
  const summary = latestSummary(session) ?? "_(no compaction summary yet — compact first for a denser brief)_";
  const ledger = store.readLedger(session.sessionId);

  const fileList = session.trackedFiles.length
    ? session.trackedFiles.map((p) => `- \`${p}\``).join("\n")
    : "_(none tracked)_";

  const parts = [
    HANDOFF_MARKER,
    "",
    `## Session\n\`${session.sessionId}\` · ${session.boundaries.length} boundaries · generated ${new Date().toISOString()}`,
    "",
    "## Persistent rules",
    session.persistentRules.trim() || "_(none)_",
    "",
    "## Summary (latest compaction)",
    summary,
    "",
    "## Verification ledger (already proven — do not re-verify)",
    renderLedger(ledger),
    "",
    "## Active files — re-open these from disk",
    fileList,
  ];

  if (opts.includeFileContents && session.trackedFiles.length) {
    parts.push("", "## File snapshots");
    for (const p of session.trackedFiles) {
      if (!isPathAllowed(cfg, p)) continue;
      try {
        const text = fs.readFileSync(p, "utf8");
        parts.push(`\n### \`${p}\`\n\n\`\`\`\n${text}\n\`\`\``);
      } catch {
        /* skip unreadable files */
      }
    }
  }

  const brief = parts.join("\n");

  // Always persist alongside session state.
  const written: string[] = [];
  const stateOut = path.join(cfg.stateDir, session.sessionId, "handoff.md");
  fs.mkdirSync(path.dirname(stateOut), { recursive: true });
  fs.writeFileSync(stateOut, brief);
  written.push(stateOut);

  // Optionally also write into the workspace so a new chat can attach it without MCP.
  if (opts.outPath) {
    const target = path.resolve(opts.outPath);
    if (isPathAllowed(cfg, target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, brief);
      written.push(target);
    }
  }

  return { sessionId: session.sessionId, brief, writtenTo: written };
}
