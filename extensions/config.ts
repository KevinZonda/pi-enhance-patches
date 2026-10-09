import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type Config = {
  askUserTimeoutMs: number;
  imagePasteEnabled: boolean;
  backgroundTaskAutopatchEnabled: boolean;
  compactWhenAwayEnabled: boolean;
  compactWhenAwayThresholdKind: "count" | "ratio";
  compactWhenAwayThresholdTokens: number;
  compactWhenAwayThresholdRatio: number;
  compactWhenAwayIdleMinutes: number;
};

export function normalizeConfig(raw: unknown): Config {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    askUserTimeoutMs: typeof value.askUserTimeoutMs === "number" && Number.isFinite(value.askUserTimeoutMs) && value.askUserTimeoutMs > 0
      ? Math.max(1000, Math.min(86_400_000, Math.round(value.askUserTimeoutMs))) : 0,
    imagePasteEnabled: value.imagePasteEnabled !== false,
    backgroundTaskAutopatchEnabled: value.backgroundTaskAutopatchEnabled !== false,
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

function readObject(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Config must be a JSON object.");
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function loadConfig(path: string): { config: Config; warning?: string } {
  let value: Record<string, unknown>;
  try { value = readObject(path); }
  catch { return { config: normalizeConfig({}), warning: `Cannot read ${path}; using enhancement defaults.` }; }
  const warnings: string[] = [];
  // New keys take precedence individually, including explicit false/zero values.
  const legacyFiles = [
    { name: "pi-enhance-patches-asks.json", keys: ["askUserTimeoutMs"] },
    { name: "pi-enhance-patches-compact.json", keys: ["compactWhenAwayEnabled", "compactWhenAwayThresholdKind",
      "compactWhenAwayThresholdTokens", "compactWhenAwayThresholdRatio", "compactWhenAwayIdleMinutes"] },
  ];
  for (const legacy of legacyFiles) {
    const missing = legacy.keys.filter(key => !Object.hasOwn(value, key));
    if (!missing.length) continue;
    const legacyPath = join(dirname(path), legacy.name);
    try {
      const old = readObject(legacyPath);
      for (const key of missing) if (Object.hasOwn(old, key)) value[key] = old[key];
    } catch { warnings.push(`Cannot read legacy config ${legacyPath}; using defaults for missing settings.`); }
  }
  return { config: normalizeConfig(value), ...(warnings.length ? { warning: warnings.join("\n") } : {}) };
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
