import { readFileSync } from "node:fs";

export type Config = { askUserTimeoutMs: number };

export function normalizeConfig(raw: unknown): Config {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>).askUserTimeoutMs : undefined;
  return { askUserTimeoutMs: typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1000, Math.min(86_400_000, Math.round(value))) : 0 };
}

export function loadConfig(path: string): { config: Config; warning?: string } {
  try {
    return { config: normalizeConfig(JSON.parse(readFileSync(path, "utf8"))) };
  } catch (error) {
    return { config: normalizeConfig({}), ...((error as NodeJS.ErrnoException).code === "ENOENT" ? {} : {
      warning: `Cannot read ${path}; ask timeout is disabled.`,
    }) };
  }
}
