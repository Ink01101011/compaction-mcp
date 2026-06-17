// Compaction prompt templates. See SPEC.md §5.
import type { LedgerEntry } from "./types.js";

export interface SummarizePromptArgs {
  transcript: string;
  preserve?: string;
  persistentRules?: string;
  ledger?: LedgerEntry[];
}

export function buildSummarizePrompt(args: SummarizePromptArgs): string {
  const ledgerBlock =
    args.ledger && args.ledger.length
      ? args.ledger
          .map(
            (e) =>
              `- [${e.result.toUpperCase()}] ${e.claim} (via ${e.method}, by ${e.by}) :: ${e.evidence}`,
          )
          .join("\n")
      : "(none)";

  return [
    "You are compacting an agentic coding session's context.",
    "Produce a DENSE summary that preserves, in priority order:",
    "1. Architectural decisions and WHY they were made.",
    "2. The current task and its acceptance criteria.",
    "3. Verified facts (see VERIFICATION LEDGER) — copy exact results verbatim.",
    "4. Exact error strings, function signatures, and API contracts referenced.",
    "5. Open questions / next steps.",
    "",
    "DROP: redundant tool output, superseded attempts, resolved chatter.",
    "NEVER drop anything in <preserve> or <persistent-rules>.",
    "Output Markdown. Be terse. No preamble.",
    "",
    `<persistent-rules>\n${args.persistentRules ?? ""}\n</persistent-rules>`,
    `<preserve>\n${args.preserve ?? ""}\n</preserve>`,
    `<verification-ledger>\n${ledgerBlock}\n</verification-ledger>`,
    `<transcript>\n${args.transcript}\n</transcript>`,
  ].join("\n");
}

export const REHYDRATE_NOTE =
  "The files below were re-read from disk at compaction time. Treat their contents as the " +
  "current source of truth for code; treat the summary above as the source of truth for reasoning and decisions.";
