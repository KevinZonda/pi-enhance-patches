import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { registerCompactWhenAway } from "./compact.ts";
import { compactThresholdLabel, editCompactSettings } from "./settings.ts";

export function registerCompactWhenAwayPatches(pi: ExtensionAPI): void {
  const path = join(getAgentDir(), "pi-enhance-patches-compact.json");
  const { config, warning } = loadConfig(path);
  registerCompactWhenAway(pi, config);
  if (warning) pi.on("session_start", (_event, ctx) => { if (ctx.hasUI) ctx.ui.notify(warning, "warning"); });
  pi.registerCommand("compact-away", {
    description: "Configure Compact When Away; /compact-away show displays current settings",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (command === "show") {
        ctx.ui.notify([
          `Compact When Away: ${config.compactWhenAwayEnabled ? "on" : "off"}`,
          `Context threshold kind: ${config.compactWhenAwayThresholdKind}`,
          `Context threshold: >= ${compactThresholdLabel(config)}`,
          `Idle time: ${config.compactWhenAwayIdleMinutes} minutes`,
          `Config: ${path}`,
        ].join("\n"), "info");
      } else if (command === "" || command === "settings") {
        await editCompactSettings(ctx, config, path);
      } else { ctx.ui.notify("Usage: /compact-away [settings|show]", "warning"); }
    },
  });
}
