// Core domain types. See SPEC.md §4, §7.

export type Role = "user" | "assistant" | "tool";

export interface Turn {
  id: string;
  role: Role;
  content: string;
  tokensEst: number;
  pinned?: boolean;
  createdAt: string;
}

export interface CompactBoundary {
  id: string;
  at: string;
  reason: "manual" | "auto-threshold" | "host-requested";
  turnsBefore: number;
  tokensBefore: number;
  tokensAfter: number;
  summaryRef: string;
  preserveInstruction?: string;
  ledgerSnapshotRef?: string;
}

export interface SessionState {
  sessionId: string;
  createdAt: string;
  turns: Turn[];
  boundaries: CompactBoundary[];
  trackedFiles: string[];
  persistentRules: string;
  tokenBudget: number;
  estTokensUsed: number;
  /** produced summaries keyed by boundary id */
  summaries: Record<string, string>;
}

export interface LedgerEntry {
  id: string;
  at: string;
  claim: string;
  method: string;
  result: "pass" | "fail" | "inconclusive";
  evidence: string;
  by: "maker" | "checker" | "agent";
  supersedes?: string;
}

export interface RehydratedFile {
  path: string;
  ok: boolean;
  contents?: string;
  error?: string;
  bytes?: number;
}

/** The "compacted context block" returned by context.compact (SPEC §8.6). */
export interface CompactedContextBlock {
  sessionId: string;
  summary: string;
  persistentRules: string;
  rehydratedFiles: RehydratedFile[];
  ledgerSnapshot: LedgerEntry[];
  boundary: CompactBoundary;
  extraContext: string;
}
