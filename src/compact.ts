// Orchestrates context.compact: hooks → snapshot → summarize → boundary → rehydrate. SPEC §8.
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { HooksConfig } from "./config.js";
import { runHooks } from "./hooks.js";
import { buildSummarizePrompt, REHYDRATE_NOTE } from "./prompts.js";
import { rehydrate } from "./rehydrate.js";
import { SessionStore, estimateTokens } from "./session.js";
import type { Summarizer } from "./summarizer.js";
import type {
  CompactBoundary,
  CompactedContextBlock,
  SessionState,
} from "./types.js";

export interface CompactArgs {
  transcript?: string;
  preserve?: string;
  reason?: CompactBoundary["reason"];
}

export async function runCompaction(
  deps: {
    cfg: Config;
    store: SessionStore;
    summarizer: Summarizer;
    hooks: HooksConfig;
  },
  session: SessionState,
  args: CompactArgs,
): Promise<CompactedContextBlock> {
  const { cfg, store, summarizer, hooks } = deps;

  // Source transcript: passthrough (host-supplied) or store mode (server-held turns).
  const transcript =
    cfg.mode === "passthrough"
      ? args.transcript
      : session.turns
          .filter((t) => !t.pinned)
          .map((t) => `### ${t.role}\n${t.content}`)
          .join("\n\n");

  if (cfg.mode === "passthrough" && !transcript) {
    throw new Error("E_NO_TRANSCRIPT: passthrough mode requires `transcript`");
  }

  const boundaryId = randomUUID();
  const tokensBefore = session.estTokensUsed;
  const ledger = store.readLedger(session.sessionId);

  // 1. PreCompact hooks — dump state to disk before anything is lost.
  const preDraft = {
    sessionId: session.sessionId,
    boundaryId,
    tokensBefore,
    turnsBefore: session.turns.length,
    reason: args.reason ?? "manual",
  };
  await runHooks(hooks.PreCompact, preDraft);

  // 2. Ledger snapshot captured at the boundary.
  const ledgerSnapshotRef = `compaction://ledger/${session.sessionId}#${boundaryId}`;

  // 3. Summarize.
  const prompt = buildSummarizePrompt({
    transcript: transcript ?? "",
    preserve: args.preserve,
    persistentRules: session.persistentRules,
    ledger,
  });
  const summary = await summarizer.summarize({ prompt });

  // 4. Append boundary; collapse pre-boundary turns (keep pinned only).
  const pinned = session.turns.filter((t) => t.pinned);
  const boundary: CompactBoundary = {
    id: boundaryId,
    at: new Date().toISOString(),
    reason: args.reason ?? "manual",
    turnsBefore: session.turns.length,
    tokensBefore,
    tokensAfter: estimateTokens(summary),
    summaryRef: `compaction://summary/${session.sessionId}/${boundaryId}`,
    preserveInstruction: args.preserve,
    ledgerSnapshotRef,
  };
  session.turns = pinned;
  session.boundaries.push(boundary);
  session.summaries[boundaryId] = summary;
  store.recomputeUsage(session);
  store.save(session);

  // 5. Re-hydrate tracked files from disk.
  const rehydratedFiles = rehydrate(cfg, session.trackedFiles);

  // 6. PostCompact hooks — capture stdout to re-inject extra context.
  const postResults = await runHooks(hooks.PostCompact, {
    sessionId: session.sessionId,
    boundaryId,
    summary,
  });
  const extraContext = postResults
    .map((r) => r.stdout.trim())
    .filter(Boolean)
    .join("\n");

  return {
    sessionId: session.sessionId,
    summary: `${summary}\n\n${REHYDRATE_NOTE}`,
    persistentRules: session.persistentRules,
    rehydratedFiles,
    ledgerSnapshot: ledger,
    boundary,
    extraContext,
  };
}
