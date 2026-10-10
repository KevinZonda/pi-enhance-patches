import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyPackagePatch, type PatchResult } from "../install-patch.ts";

export const INTERACTIVE_SHELL_ABORT_PATCH = fileURLToPath(new URL("../../patches/pi-interactive-shell-0.17.0-abort.patch", import.meta.url));

export function applyInteractiveShellAbortPatch(target: string): Promise<PatchResult> {
  return applyPackagePatch(target, INTERACTIVE_SHELL_ABORT_PATCH, {
    name: "pi-interactive-shell", version: "0.17.0", lock: ".pi-enhance-abort.lock",
    files: ["index.ts", "overlay-component.ts", "headless-monitor.ts", "session-manager.ts"],
  });
}

export function registerInteractiveShellPatches(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.PI_ENHANCE_INTERACTIVE_SHELL_AUTOPATCH === "0" || !pi.getAllTools().some(tool => tool.name === "interactive_shell")) return;
    const result = await applyInteractiveShellAbortPatch(join(getAgentDir(), "npm/node_modules/pi-interactive-shell"));
    if (result.status !== "applied" && result.status !== "skipped") return;
    const message = result.status === "applied"
      ? "pi-interactive-shell cancellation patch applied. After current tasks finish, /reload or restart Pi to load it. Cancelling a query preserves its process; cancelling a blocking shell overlay cancels that session."
      : `Interactive shell cancellation autopatch skipped: ${result.reason}`;
    if (ctx.hasUI) ctx.ui.notify(message, result.status === "applied" ? "info" : "warning");
    else console.error(message);
  });
}
