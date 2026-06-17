// Embeddings client + disk-backed cache for semantic recall. See SPEC.md §10C.
// OpenAI-compatible /embeddings (Ollama `nomic-embed-text`, gateways, etc.). Vectors are
// cached by content hash so recall only embeds new text + the query.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export class EmbeddingClient {
  private cachePath: string;
  private cache: Record<string, number[]>;

  constructor(private cfg: Config) {
    this.cachePath = path.join(cfg.stateDir, "embcache.json");
    this.cache = this.load();
  }

  get enabled(): boolean {
    return Boolean(this.cfg.recall.embedModel);
  }

  private load(): Record<string, number[]> {
    try {
      return JSON.parse(fs.readFileSync(this.cachePath, "utf8")) as Record<string, number[]>;
    } catch {
      return {};
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(this.cachePath, JSON.stringify(this.cache));
    } catch {
      /* best effort */
    }
  }

  /** Embed texts, using/filling the cache. Throws if the endpoint is unreachable. */
  async embed(texts: string[]): Promise<number[][]> {
    const missing = texts.filter((t) => !this.cache[sha(t)]);
    if (missing.length) {
      const vectors = await this.callApi(missing);
      missing.forEach((t, i) => (this.cache[sha(t)] = vectors[i]));
      this.save();
    }
    return texts.map((t) => this.cache[sha(t)]);
  }

  private async callApi(input: string[]): Promise<number[][]> {
    const url = `${this.cfg.recall.embedBaseUrl.replace(/\/$/, "")}/embeddings`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.cfg.recall.embedApiKey) headers.Authorization = `Bearer ${this.cfg.recall.embedApiKey}`;
    Object.assign(headers, this.cfg.recall.embedHeaders);

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: this.cfg.recall.embedModel, input }),
    });
    if (!res.ok) {
      throw new Error(`E_EMBED_UNAVAILABLE: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { data?: { embedding: number[] }[] };
    const data = json.data;
    if (!data || data.length !== input.length) {
      throw new Error("E_EMBED_UNAVAILABLE: malformed embeddings response");
    }
    return data.map((d) => d.embedding);
  }
}
