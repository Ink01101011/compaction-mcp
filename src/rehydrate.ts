// File re-hydration from disk. See SPEC.md §2 (file re-hydration), §12 (allowed roots).
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type { RehydratedFile } from "./types.js";

export function isPathAllowed(cfg: Config, target: string): boolean {
  const resolved = path.resolve(target);
  return cfg.allowedRoots.some((root) => {
    const rel = path.relative(root, resolved);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

const MAX_BYTES = 256 * 1024; // guard against re-hydrating huge files

export function rehydrate(cfg: Config, paths: string[]): RehydratedFile[] {
  return paths.map((p): RehydratedFile => {
    if (!isPathAllowed(cfg, p)) {
      return { path: p, ok: false, error: "E_FILE_UNREADABLE: outside allowed roots" };
    }
    try {
      const stat = fs.statSync(p);
      if (stat.size > MAX_BYTES) {
        return { path: p, ok: false, error: `E_FILE_UNREADABLE: exceeds ${MAX_BYTES} bytes` };
      }
      const contents = fs.readFileSync(p, "utf8");
      return { path: p, ok: true, contents, bytes: stat.size };
    } catch (err) {
      return { path: p, ok: false, error: `E_FILE_UNREADABLE: ${(err as Error).message}` };
    }
  });
}
