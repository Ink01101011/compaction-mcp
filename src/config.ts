// Configuration from environment. See SPEC.md §6, §8, §12.
import os from "node:os";
import path from "node:path";

export type SummarizerMode = "direct" | "sampling" | "auto";
export type IntegrationMode = "store" | "passthrough";

export interface HookSpec {
  command: string;
  timeoutMs?: number;
  continueOnError?: boolean;
}

export interface HooksConfig {
  PreCompact: HookSpec[];
  PostCompact: HookSpec[];
}

export interface Config {
  stateDir: string;
  mode: IntegrationMode;
  summarizer: SummarizerMode;
  llm: { baseUrl: string; model: string; apiKey?: string; headers: Record<string, string> };
  allowedRoots: string[];
  hooksEnabled: boolean;
  hooksFile?: string;
  /** auto-compact on ingest when pressure crosses nowPct (store mode only) */
  auto: boolean;
  recall: {
    mode: "auto" | "embed" | "lexical";
    embedModel?: string;
    embedBaseUrl: string;
    embedApiKey?: string;
    embedHeaders: Record<string, string>;
  };
  /** default budget when host does not declare one */
  defaultTokenBudget: number;
  proactivePct: number; // SPEC §9 "compact-soon" threshold
  nowPct: number; // "compact-now"
  limitPct: number; // "at-limit"
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** Parse COMPACTION_LLM_HEADERS (JSON object of extra request headers). */
function parseHeaders(): Record<string, string> {
  const raw = process.env.COMPACTION_LLM_HEADERS;
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, String(v)]),
    );
  } catch {
    process.stderr.write("[compaction-mcp] WARN: COMPACTION_LLM_HEADERS is not valid JSON; ignoring\n");
    return {};
  }
}

export function loadConfig(): Config {
  const summarizer = (process.env.COMPACTION_SUMMARIZER as SummarizerMode) || "direct";
  const mode = (process.env.COMPACTION_MODE as IntegrationMode) || "passthrough";

  return {
    stateDir:
      process.env.COMPACTION_STATE_DIR ||
      path.join(os.homedir(), ".compaction-mcp", "sessions"),
    mode,
    summarizer,
    llm: {
      baseUrl: process.env.COMPACTION_LLM_BASE_URL || "http://localhost:11434/v1",
      model: process.env.COMPACTION_LLM_MODEL || "qwen2.5-coder:14b",
      apiKey: process.env.COMPACTION_LLM_API_KEY,
      headers: parseHeaders(),
    },
    allowedRoots: (process.env.COMPACTION_ALLOWED_ROOTS || process.cwd())
      .split(path.delimiter)
      .filter(Boolean)
      .map((p) => path.resolve(p)),
    hooksEnabled: process.env.COMPACTION_HOOKS_ENABLED !== "false",
    hooksFile: process.env.COMPACTION_HOOKS,
    auto: process.env.COMPACTION_AUTO === "true",
    recall: {
      mode: (process.env.COMPACTION_RECALL_MODE as "auto" | "embed" | "lexical") || "auto",
      embedModel: process.env.COMPACTION_EMBED_MODEL,
      // Embeddings reuse the summarizer endpoint/creds unless overridden.
      embedBaseUrl:
        process.env.COMPACTION_EMBED_BASE_URL ||
        process.env.COMPACTION_LLM_BASE_URL ||
        "http://localhost:11434/v1",
      embedApiKey: process.env.COMPACTION_EMBED_API_KEY || process.env.COMPACTION_LLM_API_KEY,
      embedHeaders: parseHeaders(),
    },
    defaultTokenBudget: envInt("COMPACTION_TOKEN_BUDGET", 128_000),
    proactivePct: envInt("COMPACTION_PROACTIVE_PCT", 60),
    nowPct: envInt("COMPACTION_NOW_PCT", 85),
    limitPct: envInt("COMPACTION_LIMIT_PCT", 95),
  };
}
