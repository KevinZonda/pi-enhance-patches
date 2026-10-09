import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyPackagePatch, type PatchResult } from "../install-patch.ts";

export const SUBAGENT_NOTIFICATION_PATCH = fileURLToPath(new URL("../../patches/gotgenes-pi-subagents-23.4.0-stale-notifications.patch", import.meta.url));

export function applySubagentNotificationPatch(target: string, patch = SUBAGENT_NOTIFICATION_PATCH): Promise<PatchResult> {
  return applyPackagePatch(target, patch, {
    name: "@gotgenes/pi-subagents", version: "23.4.0", lock: ".pi-enhance-subagent-notifications.lock",
    files: ["src/index.ts", "src/observation/notification.ts"],
  });
}

export function registerSubagentPatches(pi: ExtensionAPI, enabled = false): void {
  if (!enabled) return;
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.PI_ENHANCE_SUBAGENT_AUTOPATCH === "0" || !pi.getAllTools().some(tool => tool.name === "subagent")
      || !(globalThis as Record<symbol, unknown>)[Symbol.for("@gotgenes/pi-subagents:service")]) return;
    const target = join(getAgentDir(), "npm", "node_modules", "@gotgenes", "pi-subagents");
    const result = await applySubagentNotificationPatch(target);
    if (result.status === "absent" || result.status === "already_applied") return;
    const message = result.status === "applied"
      ? "@gotgenes/pi-subagents notification patch applied to installation files. After current tasks finish, /reload or restart Pi to load it; already queued notifications are unchanged."
      : `Subagent notification autopatch skipped: ${result.reason}`;
    if (ctx.hasUI) ctx.ui.notify(message, result.status === "applied" ? "info" : "warning");
    else console.error(message);
  });
}
