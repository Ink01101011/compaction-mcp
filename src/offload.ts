// Context offloading. See SPEC.md §10B.
// Proactive token control: instead of dumping a full file / command output into the chat,
// store it as a blob on disk and return only a SHORT digest + a handle. The model pulls the
// full content (or a line slice) via offload_fetch / the blob resource ONLY when it needs it.
// This keeps the window small from the start, rather than compacting after it bloats.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { isPathAllowed } from "./rehydrate.js";

export interface BlobMeta {
  handle: string;
  label: string;
  source?: string; // file path, if read from disk
  lines: number;
  bytes: number;
  createdAt: string;
}

export interface Digest {
  handle: string;
  resource: string; // compaction://blob/{handle}
  label: string;
  source?: string;
  lines: number;
  bytes: number;
  preview: string; // first lines
  outline: string[]; // structural lines (decls / headings), with line numbers
  note: string;
}

const PREVIEW_LINES = 12;
const OUTLINE_MAX = 40;

// Strong declarations / headings — these should always surface in the outline.
const PRIMARY_RE =
  /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum|struct|trait|impl|module|namespace|package|func|def)\b|^\s*#{1,6}\s/;
// Weaker signals — only used to fill remaining outline slots, so a flood of `const`
// declarations can't drown out the function/class skeleton.
const SECONDARY_RE = /^\s*(export\s+)?(const|let|var)\b|^\s*@\w+|^\s*[-*]\s/;

function buildDigest(meta: BlobMeta, content: string): Digest {
  const lines = content.split("\n");
  const preview = lines.slice(0, PREVIEW_LINES).join("\n");

  const numbered = lines.map((l, i): [number, string] => [i + 1, l]);
  const primary = numbered.filter(([, l]) => PRIMARY_RE.test(l));
  const secondary = numbered.filter(([, l]) => SECONDARY_RE.test(l));
  // Primary first, then fill with secondary, then restore line order for readability.
  const chosen = [...primary.slice(0, OUTLINE_MAX), ...secondary]
    .slice(0, OUTLINE_MAX)
    .sort((a, b) => a[0] - b[0]);
  const outline = chosen.map(([n, l]) => `${n}: ${l.trim()}`);

  return {
    handle: meta.handle,
    resource: `compaction://blob/${meta.handle}`,
    label: meta.label,
    source: meta.source,
    lines: meta.lines,
    bytes: meta.bytes,
    preview,
    outline,
    note:
      "Full content is offloaded — NOT in context. Use offload_fetch { handle } (optionally " +
      "startLine/endLine) or read the resource only if you actually need it.",
  };
}

export class BlobStore {
  private dir: string;

  constructor(private cfg: Config) {
    this.dir = path.join(cfg.stateDir, "blobs");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private blobPath(handle: string): string {
    return path.join(this.dir, `${handle}.txt`);
  }
  private metaPath(handle: string): string {
    return path.join(this.dir, `${handle}.json`);
  }

  /** Store arbitrary text; returns a digest (the only thing that should enter the window). */
  put(label: string, content: string, source?: string): Digest {
    const handle = randomUUID().slice(0, 8);
    const meta: BlobMeta = {
      handle,
      label,
      source,
      lines: content.split("\n").length,
      bytes: Buffer.byteLength(content, "utf8"),
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.blobPath(handle), content);
    fs.writeFileSync(this.metaPath(handle), JSON.stringify(meta, null, 2));
    return buildDigest(meta, content);
  }

  /** Read a file from disk (within allowed roots) and offload it. */
  putFile(filePath: string, label?: string): Digest {
    const resolved = path.resolve(filePath);
    if (!isPathAllowed(this.cfg, resolved)) {
      throw new Error("E_FILE_UNREADABLE: outside allowed roots");
    }
    const content = fs.readFileSync(resolved, "utf8");
    return this.put(label ?? path.basename(resolved), content, resolved);
  }

  /** List metadata for all stored blobs. */
  list(): BlobMeta[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as BlobMeta);
  }

  /** Read just the raw content of a blob (no slicing). */
  read(handle: string): string {
    const bp = this.blobPath(handle);
    if (!fs.existsSync(bp)) throw new Error(`E_NO_BLOB: ${handle}`);
    return fs.readFileSync(bp, "utf8");
  }

  /** Retrieve full content or a 1-indexed inclusive line slice. */
  fetch(handle: string, startLine?: number, endLine?: number): { meta: BlobMeta; content: string } {
    const bp = this.blobPath(handle);
    if (!fs.existsSync(bp)) throw new Error(`E_NO_BLOB: ${handle}`);
    const meta = JSON.parse(fs.readFileSync(this.metaPath(handle), "utf8")) as BlobMeta;
    let content = fs.readFileSync(bp, "utf8");
    if (startLine != null || endLine != null) {
      const lines = content.split("\n");
      const a = Math.max(1, startLine ?? 1);
      const b = Math.min(lines.length, endLine ?? lines.length);
      content = lines.slice(a - 1, b).join("\n");
    }
    return { meta, content };
  }
}
