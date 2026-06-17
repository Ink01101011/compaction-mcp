// Recall cache. See SPEC.md §10C.
// A token saver for hosts with their own retrieval (e.g. Augment): before asking the codebase
// /context engine again, the agent queries recall — a distilled cache of already-verified
// facts (ledger) and already-offloaded content (blobs). Hits avoid re-pulling whole files.
//
// Two scorers: semantic (embeddings, when configured) and lexical (dependency-free term
// overlap). `auto` uses embeddings when an embed model is set and the endpoint answers, else
// falls back to lexical — same graceful-degradation contract as the summarizer.
import type { Config } from "./config.js";
import { cosine, EmbeddingClient } from "./embeddings.js";
import type { BlobStore } from "./offload.js";
import type { SessionStore } from "./session.js";
import type { LedgerEntry } from "./types.js";

export interface LedgerHit {
  claim: string;
  result: LedgerEntry["result"];
  method: string;
  evidence: string;
  by: LedgerEntry["by"];
  score: number;
}

export interface BlobSnippet {
  line: number;
  endLine?: number;
  text: string;
}

export interface BlobHit {
  handle: string;
  resource: string;
  label: string;
  source?: string;
  score: number;
  matches: BlobSnippet[];
}

export interface RecallResult {
  query: string;
  mode: "embed" | "lexical";
  ledgerHits: LedgerHit[];
  blobHits: BlobHit[];
  note: string;
}

const CHUNK_LINES = 40;
const NOTE =
  "Consult these BEFORE querying the codebase / context engine — re-using a cached fact or a " +
  "known blob line range (via offload_fetch handle+startLine+endLine) avoids pulling whole " +
  "files back into the window.";

// ---------------- lexical ----------------

function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_.]+/i)
    .filter((t) => t.length > 1);
}

function lexScore(text: string, qterms: string[]): number {
  const hay = text.toLowerCase();
  return qterms.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0);
}

function recallLexical(
  store: SessionStore,
  blobs: BlobStore,
  sessionId: string,
  query: string,
  limit: number,
): RecallResult {
  const qterms = terms(query);

  const ledgerHits = store
    .readLedger(sessionId)
    .map((e) => ({
      claim: e.claim,
      result: e.result,
      method: e.method,
      evidence: e.evidence,
      by: e.by,
      score: lexScore(`${e.claim} ${e.method} ${e.evidence}`, qterms),
    }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const blobHits: BlobHit[] = [];
  for (const meta of blobs.list()) {
    const metaScore = lexScore(`${meta.label} ${meta.source ?? ""}`, qterms);
    let matches: BlobSnippet[] = [];
    try {
      const lines = blobs.read(meta.handle).split("\n");
      matches = lines
        .map((text, i): BlobSnippet => ({ line: i + 1, text: text.trim() }))
        .filter((s) => lexScore(s.text, qterms) > 0)
        .slice(0, 3);
    } catch {
      /* removed */
    }
    const total = metaScore * 2 + matches.length;
    if (total > 0) {
      blobHits.push({ handle: meta.handle, resource: `compaction://blob/${meta.handle}`, label: meta.label, source: meta.source, score: total, matches });
    }
  }
  blobHits.sort((a, b) => b.score - a.score);

  return { query, mode: "lexical", ledgerHits, blobHits: blobHits.slice(0, limit), note: NOTE };
}

// ---------------- semantic ----------------

interface Chunk {
  handle: string;
  startLine: number;
  endLine: number;
  text: string;
}

function chunkBlob(handle: string, content: string): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];
  for (let i = 0; i < lines.length; i += CHUNK_LINES) {
    const slice = lines.slice(i, i + CHUNK_LINES);
    if (slice.join("").trim() === "") continue;
    chunks.push({ handle, startLine: i + 1, endLine: Math.min(i + CHUNK_LINES, lines.length), text: slice.join("\n") });
  }
  return chunks;
}

async function recallSemantic(
  cfg: Config,
  store: SessionStore,
  blobs: BlobStore,
  embedder: EmbeddingClient,
  sessionId: string,
  query: string,
  limit: number,
): Promise<RecallResult> {
  const ledger = store.readLedger(sessionId);
  const ledgerTexts = ledger.map((e) => `${e.claim}. ${e.method}. ${e.evidence}`);

  const metas = blobs.list();
  const chunks: Chunk[] = [];
  for (const m of metas) {
    try {
      chunks.push(...chunkBlob(m.handle, blobs.read(m.handle)));
    } catch {
      /* removed */
    }
  }

  // One batched embed call for query + all candidates (cached by hash on repeat).
  const [qVec, ...rest] = await embedder.embed([query, ...ledgerTexts, ...chunks.map((c) => c.text)]);
  const ledgerVecs = rest.slice(0, ledgerTexts.length);
  const chunkVecs = rest.slice(ledgerTexts.length);

  const ledgerHits = ledger
    .map((e, i) => ({
      claim: e.claim,
      result: e.result,
      method: e.method,
      evidence: e.evidence,
      by: e.by,
      score: Number(cosine(qVec, ledgerVecs[i]).toFixed(4)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // best chunk per blob handle
  const bestByHandle = new Map<string, { score: number; chunk: Chunk; label: string; source?: string }>();
  const labelByHandle = new Map(metas.map((m) => [m.handle, m]));
  chunks.forEach((c, i) => {
    const s = cosine(qVec, chunkVecs[i]);
    const cur = bestByHandle.get(c.handle);
    if (!cur || s > cur.score) {
      const meta = labelByHandle.get(c.handle)!;
      bestByHandle.set(c.handle, { score: s, chunk: c, label: meta.label, source: meta.source });
    }
  });

  const blobHits: BlobHit[] = [...bestByHandle.values()]
    .map((b) => ({
      handle: b.chunk.handle,
      resource: `compaction://blob/${b.chunk.handle}`,
      label: b.label,
      source: b.source,
      score: Number(b.score.toFixed(4)),
      matches: [{ line: b.chunk.startLine, endLine: b.chunk.endLine, text: b.chunk.text.split("\n")[0]?.trim() ?? "" }],
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return { query, mode: "embed", ledgerHits, blobHits, note: NOTE };
}

// ---------------- entry ----------------

export async function recall(
  cfg: Config,
  store: SessionStore,
  blobs: BlobStore,
  embedder: EmbeddingClient,
  sessionId: string,
  query: string,
  opts: { limit?: number } = {},
): Promise<RecallResult> {
  const limit = opts.limit ?? 8;
  const wantEmbed =
    cfg.recall.mode === "embed" || (cfg.recall.mode === "auto" && embedder.enabled);

  if (wantEmbed) {
    try {
      return await recallSemantic(cfg, store, blobs, embedder, sessionId, query, limit);
    } catch (err) {
      if (cfg.recall.mode === "embed") throw err; // explicit embed mode: surface the failure
      // auto: fall back to lexical
      process.stderr.write(`[compaction-mcp] recall: embed unavailable, falling back to lexical (${(err as Error).message})\n`);
    }
  }
  return recallLexical(store, blobs, sessionId, query, limit);
}
