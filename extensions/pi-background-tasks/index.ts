import { execFile } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const exec = promisify(execFile);
export const BACKGROUND_CACHE_PATCH = fileURLToPath(new URL("../../patches/pi-background-tasks-2.6.9-global-cache.patch", import.meta.url));
export type PatchResult = { status: "absent" | "already_applied" | "applied" | "skipped"; reason?: string };

/** Patch only the reviewed release, with Git's all-files preflight and no force/reject mode. */
export async function applyBackgroundCachePatch(target: string, patch = BACKGROUND_CACHE_PATCH): Promise<PatchResult> {
  let manifest: { name?: string; version?: string };
  try { manifest = JSON.parse(readFileSync(join(target, "package.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
    return { status: "skipped", reason: `Cannot read background task manifest: ${String(error)}` };
  }
  if (manifest?.name !== "pi-background-tasks" || manifest.version !== "2.6.9") {
    return { status: "skipped", reason: `Requires pi-background-tasks 2.6.9; found ${manifest?.name ?? "unknown"} ${manifest?.version ?? "unknown"}` };
  }
  const git = (...args: string[]) => exec("git", ["apply", ...args, patch], { cwd: target, timeout: 10000, maxBuffer: 128 * 1024 });
  const alreadyApplied = async () => {
    try { await git("--reverse", "--check"); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
      return false;
    }
  };
  const lock = join(target, ".pi-enhance-global-cache.lock");
  let owned = false;
  try {
    if (await alreadyApplied()) return { status: "already_applied" };
    // An exclusive directory prevents two Pi startups from applying at the same time.
    mkdirSync(lock, { mode: 0o700 });
    owned = true;
    if (await alreadyApplied()) return { status: "already_applied" };
    await git("--check");
    for (const file of ["src/core/registry.ts", "dist/src/core/registry.js", "src/extension.ts", "dist/src/extension.js"]) {
      const path = join(target, file);
      accessSync(path, constants.W_OK);
      accessSync(dirname(path), constants.W_OK);
    }
    await git();
    return { status: "applied" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = code === "EEXIST" ? `Another autopatcher owns ${lock}; if a previous process crashed, remove this empty lock directory after confirming it is no longer running.`
      : (error instanceof Error ? error.message : String(error));
    return { status: "skipped", reason: reason.slice(0, 1200) };
  } finally {
    if (owned) rmdirSync(lock);
  }
}

export function registerBackgroundTaskPatches(pi: ExtensionAPI, enabled = true): void {
  if (!enabled) return;
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.PI_ENHANCE_BACKGROUND_AUTOPATCH === "0" || !pi.getAllTools().some(tool => tool.name === "bg_run")) return;
    const target = join(getAgentDir(), "npm", "node_modules", "pi-background-tasks");
    const result = await applyBackgroundCachePatch(target);
    if (result.status === "absent" || result.status === "already_applied") return;
    const message = result.status === "applied"
      ? "pi-background-tasks cache patch applied to installation files. After current tasks finish, /reload or restart Pi to load it; this session may still use .pi/tasks. Existing logs were not moved."
      : `Background task cache autopatch skipped: ${result.reason}`;
    if (ctx.hasUI) ctx.ui.notify(message, result.status === "applied" ? "info" : "warning");
    else console.error(message);
  });
}
