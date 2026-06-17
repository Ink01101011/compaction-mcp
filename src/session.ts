// In-memory session store mirrored to disk. See SPEC.md §4.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type { LedgerEntry, SessionState } from "./types.js";

/** Cheap heuristic token estimate (~4 chars/token). Replace with a real tokenizer in v0.2. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class SessionStore {
  private sessions = new Map<string, SessionState>();

  constructor(private cfg: Config) {
    fs.mkdirSync(cfg.stateDir, { recursive: true });
  }

  private dir(id: string): string {
    return path.join(this.cfg.stateDir, id);
  }

  private persist(s: SessionState): void {
    const d = this.dir(s.sessionId);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "session.json"), JSON.stringify(s, null, 2));
    fs.writeFileSync(path.join(d, "RULES.md"), s.persistentRules);
  }

  /** Get an existing session, hydrating from disk, or create a fresh one. */
  resolve(sessionId?: string): SessionState {
    const id = sessionId || randomUUID();
    let s = this.sessions.get(id);
    if (s) return s;

    const file = path.join(this.dir(id), "session.json");
    if (fs.existsSync(file)) {
      s = JSON.parse(fs.readFileSync(file, "utf8")) as SessionState;
    } else {
      s = {
        sessionId: id,
        createdAt: new Date().toISOString(),
        turns: [],
        boundaries: [],
        trackedFiles: [],
        persistentRules: "",
        tokenBudget: this.cfg.defaultTokenBudget,
        estTokensUsed: 0,
        summaries: {},
      };
    }
    this.sessions.set(id, s);
    return s;
  }

  save(s: SessionState): void {
    this.sessions.set(s.sessionId, s);
    this.persist(s);
  }

  recomputeUsage(s: SessionState): void {
    const turnTokens = s.turns.reduce((a, t) => a + t.tokensEst, 0);
    const summaryTokens = Object.values(s.summaries).reduce(
      (a, x) => a + estimateTokens(x),
      0,
    );
    s.estTokensUsed = turnTokens + summaryTokens + estimateTokens(s.persistentRules);
  }

  // --- ledger persistence (append-only JSONL) ---

  ledgerPath(id: string): string {
    return path.join(this.dir(id), "ledger.jsonl");
  }

  appendLedger(id: string, entry: LedgerEntry): void {
    const d = this.dir(id);
    fs.mkdirSync(d, { recursive: true });
    fs.appendFileSync(this.ledgerPath(id), JSON.stringify(entry) + "\n");
  }

  readLedger(id: string): LedgerEntry[] {
    const p = this.ledgerPath(id);
    if (!fs.existsSync(p)) return [];
    return fs
      .readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LedgerEntry);
  }
}
