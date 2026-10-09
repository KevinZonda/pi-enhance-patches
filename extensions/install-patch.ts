import { execFile } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export type PatchResult = { status: "absent" | "already_applied" | "applied" | "skipped"; reason?: string };
type PackagePatch = { name: string; version: string; files: string[]; lock: string };

/** Version-bound, all-files preflight; never force or partially apply a patch. */
export async function applyPackagePatch(target: string, patch: string, spec: PackagePatch): Promise<PatchResult> {
  let manifest: { name?: string; version?: string };
  try { manifest = JSON.parse(readFileSync(join(target, "package.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
    return { status: "skipped", reason: `Cannot read ${spec.name} manifest: ${String(error)}` };
  }
  if (manifest?.name !== spec.name || manifest.version !== spec.version) {
    return { status: "skipped", reason: `Requires ${spec.name} ${spec.version}; found ${manifest?.name ?? "unknown"} ${manifest?.version ?? "unknown"}` };
  }
  const git = (...args: string[]) => exec("git", ["apply", ...args, patch], { cwd: target, timeout: 10000, maxBuffer: 128 * 1024 });
  const alreadyApplied = async () => {
    try { await git("--reverse", "--check"); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
      return false;
    }
  };
  const lock = join(target, spec.lock);
  let owned = false;
  try {
    if (await alreadyApplied()) return { status: "already_applied" };
    mkdirSync(lock, { mode: 0o700 });
    owned = true;
    if (await alreadyApplied()) return { status: "already_applied" };
    await git("--check");
    for (const file of spec.files) {
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
