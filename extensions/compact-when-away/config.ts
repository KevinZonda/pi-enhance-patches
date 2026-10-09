import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type Config = {
  compactWhenAwayEnabled: boolean;
  compactWhenAwayThresholdKind: "count" | "ratio";
  compactWhenAwayThresholdTokens: number;
  compactWhenAwayThresholdRatio: number;
  compactWhenAwayIdleMinutes: number;
};

export function normalizeConfig(raw: unknown): Config {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    compactWhenAwayEnabled: value.compactWhenAwayEnabled === true,
    compactWhenAwayThresholdKind: value.compactWhenAwayThresholdKind === "ratio" ? "ratio" : "count",
    compactWhenAwayThresholdTokens: positiveInteger(value.compactWhenAwayThresholdTokens, 128_000),
    compactWhenAwayThresholdRatio: typeof value.compactWhenAwayThresholdRatio === "number" &&
      Number.isFinite(value.compactWhenAwayThresholdRatio) && value.compactWhenAwayThresholdRatio > 0 &&
      value.compactWhenAwayThresholdRatio <= 1 ? value.compactWhenAwayThresholdRatio : 0.7,
    compactWhenAwayIdleMinutes: positiveInteger(value.compactWhenAwayIdleMinutes, 10, 1440),
  };
}

function positiveInteger(value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.min(maximum, Math.round(value)) : fallback;
}

export function loadConfig(path: string): { config: Config; warning?: string } {
  try { return { config: normalizeConfig(JSON.parse(readFileSync(path, "utf8"))) }; }
  catch (error) {
    return { config: normalizeConfig({}), ...((error as NodeJS.ErrnoException).code === "ENOENT" ? {} : {
      warning: `Cannot read ${path}; Compact When Away is disabled.`,
    }) };
  }
}

/** Preserve unknown configuration keys and reject malformed existing files. */
export function saveConfig(path: string, updates: Partial<Config>): void {
  let existing: unknown = {};
  try { existing = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    throw new Error("Config must be a JSON object.");
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify({ ...existing, ...updates }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally { rmSync(temporaryPath, { force: true }); }
}
