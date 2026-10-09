import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync } from "node:fs";
import { BACKGROUND_CACHE_PATCH, BACKGROUND_PANEL_CLOSE_PATCH } from "../extensions/pi-background-tasks/index.ts";

/** Normalize only a test copy; the installed package may already have either patch. */
export function copyOriginalBackgroundPackage(upstream: string, target: string): void {
  cpSync(upstream, target, { recursive: true });
  for (const patch of [BACKGROUND_CACHE_PATCH, BACKGROUND_PANEL_CLOSE_PATCH]) {
    const check = spawnSync("git", ["apply", "--reverse", "--check", patch], { cwd: target });
    if (check.error) throw check.error;
    if (check.status === 0) execFileSync("git", ["apply", "--reverse", patch], { cwd: target });
    else assert.equal(check.status, 1, check.stderr.toString());
  }
}
