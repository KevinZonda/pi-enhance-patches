import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyPackagePatch, type PatchResult } from "../install-patch.ts";

export type { PatchResult } from "../install-patch.ts";
export const BACKGROUND_CACHE_PATCH = fileURLToPath(new URL("../../patches/pi-background-tasks-2.6.9-global-cache.patch", import.meta.url));
export const BACKGROUND_PANEL_CLOSE_PATCH = fileURLToPath(new URL("../../patches/pi-background-tasks-2.6.9-panel-close.patch", import.meta.url));

export function applyBackgroundCachePatch(target: string, patch = BACKGROUND_CACHE_PATCH): Promise<PatchResult> {
  return applyPackagePatch(target, patch, {
    name: "pi-background-tasks", version: "2.6.9", lock: ".pi-enhance-global-cache.lock",
    files: ["src/core/registry.ts", "dist/src/core/registry.js", "src/extension.ts", "dist/src/extension.js"],
  });
}

export function applyBackgroundPanelClosePatch(target: string, patch = BACKGROUND_PANEL_CLOSE_PATCH): Promise<PatchResult> {
  return applyPackagePatch(target, patch, {
    name: "pi-background-tasks", version: "2.6.9", lock: ".pi-enhance-panel-close.lock",
    files: ["src/ui/background-tasks-manager.ts", "dist/src/ui/background-tasks-manager.js"],
  });
}

export function registerBackgroundTaskPatches(pi: ExtensionAPI, enabled = true): void {
  if (!enabled) return;
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.PI_ENHANCE_BACKGROUND_AUTOPATCH === "0" || !pi.getAllTools().some(tool => tool.name === "bg_run")) return;
    const target = join(getAgentDir(), "npm", "node_modules", "pi-background-tasks");
    const results = [
      { name: "cache", result: await applyBackgroundCachePatch(target) },
      { name: "panel close", result: await applyBackgroundPanelClosePatch(target) },
    ];
    const notices = results.filter(({ result }) => result.status === "applied" || result.status === "skipped");
    if (!notices.length) return;
    const message = notices.map(({ name, result }) => result.status === "applied"
      ? `pi-background-tasks ${name} patch applied to installation files. After current tasks finish, /reload or restart Pi to load it.${name === "cache" ? " This session may still use .pi/tasks. Existing logs were not moved." : " Esc/q/x close the panel without stopping tasks."}`
      : `Background task ${name} autopatch skipped: ${result.reason}`).join("\n");
    if (ctx.hasUI) ctx.ui.notify(message, notices.some(({ result }) => result.status === "skipped") ? "warning" : "info");
    else console.error(message);
  });
}
