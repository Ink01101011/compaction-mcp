// PreCompact / PostCompact hook runner. See SPEC.md §8.
import { spawn } from "node:child_process";
import fs from "node:fs";
import type { Config, HookSpec, HooksConfig } from "./config.js";

export function loadHooks(cfg: Config): HooksConfig {
  const empty: HooksConfig = { PreCompact: [], PostCompact: [] };
  if (!cfg.hooksEnabled || !cfg.hooksFile) return empty;
  try {
    const parsed = JSON.parse(fs.readFileSync(cfg.hooksFile, "utf8")) as Partial<HooksConfig>;
    return {
      PreCompact: parsed.PreCompact ?? [],
      PostCompact: parsed.PostCompact ?? [],
    };
  } catch {
    return empty;
  }
}

export interface HookResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runOne(hook: HookSpec, payload: string): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(hook.command, { shell: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, hook.timeoutMs ?? 5000);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      if (hook.continueOnError) {
        resolve({ command: hook.command, exitCode: -1, stdout, stderr: String(e) });
      } else {
        reject(new Error(`E_HOOK_FAILED: ${hook.command}: ${e}`));
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const exitCode = code ?? -1;
      if (exitCode !== 0 && !hook.continueOnError) {
        reject(new Error(`E_HOOK_FAILED: ${hook.command} exited ${exitCode}: ${stderr}`));
      } else {
        resolve({ command: hook.command, exitCode, stdout, stderr });
      }
    });

    child.stdin.write(payload);
    child.stdin.end();
  });
}

export async function runHooks(
  hooks: HookSpec[],
  payload: unknown,
): Promise<HookResult[]> {
  const json = JSON.stringify(payload);
  const results: HookResult[] = [];
  for (const h of hooks) {
    results.push(await runOne(h, json));
  }
  return results;
}
