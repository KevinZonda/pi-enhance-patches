import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { saveConfig, type Config } from "./config.ts";

export function compactThresholdLabel(config: Config): string {
  return config.compactWhenAwayThresholdKind === "ratio"
    ? `${Number((config.compactWhenAwayThresholdRatio * 100).toFixed(6))}% of context window`
    : `${config.compactWhenAwayThresholdTokens} tokens`;
}

/** Command-scoped settings dialog; save and reload only after the user applies the draft. */
export async function editCompactSettings(ctx: ExtensionCommandContext, config: Config, path: string): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify("Compact When Away settings are available in TUI mode.", "warning");
    return;
  }
  const draft = { ...config };
  while (true) {
    const options = [
      `Enabled: ${draft.compactWhenAwayEnabled ? "on" : "off"}`,
      `Context threshold kind: ${draft.compactWhenAwayThresholdKind}`,
      `Context count: ${draft.compactWhenAwayThresholdTokens} tokens`,
      `Context ratio: ${Number((draft.compactWhenAwayThresholdRatio * 100).toFixed(6))}%`,
      `Idle time: ${draft.compactWhenAwayIdleMinutes} minutes`,
      "Save and apply", "Cancel",
    ];
    const selected = await ctx.ui.select("Compact When Away settings", options);
    if (selected === undefined || selected === "Cancel") return;
    const index = options.indexOf(selected);
    if (index === 0) {
      const value = await ctx.ui.select("Compact When Away", ["on", "off"]);
      if (value !== undefined) draft.compactWhenAwayEnabled = value === "on";
    } else if (index === 1) {
      const value = await ctx.ui.select("Context threshold kind", ["count", "ratio"]);
      if (value === "count" || value === "ratio") draft.compactWhenAwayThresholdKind = value;
    } else if (index >= 2 && index <= 4) {
      const current = index === 2 ? draft.compactWhenAwayThresholdTokens : index === 3
        ? draft.compactWhenAwayThresholdRatio * 100 : draft.compactWhenAwayIdleMinutes;
      const value = await ctx.ui.input(index === 2 ? "Context threshold (tokens)" : index === 3
        ? "Context threshold (percent, >0–100)" : "Idle time (minutes, 1–1440)", String(current));
      if (value === undefined) continue;
      const number = Number(value.trim());
      const valid = Number.isFinite(number) && number > 0 && (index === 3
        ? number <= 100 : Number.isSafeInteger(number) && (index !== 4 || number <= 1440));
      if (!valid) { ctx.ui.notify("Enter a valid value within the indicated range.", "warning"); continue; }
      if (index === 2) draft.compactWhenAwayThresholdTokens = number;
      else if (index === 3) draft.compactWhenAwayThresholdRatio = number / 100;
      else draft.compactWhenAwayIdleMinutes = number;
    } else if (index === 5) {
      try {
        saveConfig(path, {
          compactWhenAwayEnabled: draft.compactWhenAwayEnabled,
          compactWhenAwayThresholdKind: draft.compactWhenAwayThresholdKind,
          compactWhenAwayThresholdTokens: draft.compactWhenAwayThresholdTokens,
          compactWhenAwayThresholdRatio: draft.compactWhenAwayThresholdRatio,
          compactWhenAwayIdleMinutes: draft.compactWhenAwayIdleMinutes,
        });
      } catch (error) {
        ctx.ui.notify(`Cannot save settings: ${error instanceof Error ? error.message : String(error)}`, "error");
        continue;
      }
      ctx.ui.notify("Compact When Away settings saved. Reloading extensions.", "info");
      await ctx.reload();
      return;
    }
  }
}
