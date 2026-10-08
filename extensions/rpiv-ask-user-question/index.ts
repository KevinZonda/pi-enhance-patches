import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installAskTimeout } from "./ask-timeout.ts";
import { loadConfig } from "./config.ts";

export function registerAskUserQuestionPatches(pi: ExtensionAPI): void {
  const path = join(getAgentDir(), "pi-enhance-patches-asks.json");
  const { config, warning } = loadConfig(path);
  const dispose = config.askUserTimeoutMs > 0 ? installAskTimeout(config.askUserTimeoutMs) : undefined;
  pi.on("session_start", (_event, ctx) => {
    if (warning && ctx.hasUI) ctx.ui.notify(warning, "warning");
  });
  pi.on("session_shutdown", () => dispose?.());
  pi.registerCommand("askpatches", {
    description: "Show questionnaire idle timeout settings",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Questionnaire idle timeout: ${config.askUserTimeoutMs ? `${config.askUserTimeoutMs}ms (TUI only)` : "off"}\nConfig: ${path}\nApply changes with /reload.`, "info");
    },
  });
}
