import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { saveConfig, type Config } from "./config.ts";

export function compactThresholdLabel(config: Config): string {
  return config.compactWhenAwayThresholdKind === "ratio"
    ? `${Number((config.compactWhenAwayThresholdRatio * 100).toFixed(6))}% of context window`
    : `${config.compactWhenAwayThresholdTokens} tokens`;
}

/** Command-scoped settings dialog; save and reload only after the user applies the draft. */
export async function editSettings(ctx: ExtensionCommandContext, config: Config, path: string): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify("Enhancement settings are available in TUI mode. Use /enhance-patches show to view them.", "warning");
    return;
  }
  const draft = { ...config };
  while (true) {
    const options = [
      `Compact When Away: ${draft.compactWhenAwayEnabled ? "on" : "off"}`,
      `Context threshold kind: ${draft.compactWhenAwayThresholdKind}`,
      `Context threshold: ${compactThresholdLabel(draft)}`,
      `Compact idle time: ${draft.compactWhenAwayIdleMinutes} minutes`,
      `Questionnaire idle timeout: ${draft.askUserTimeoutMs ? `${draft.askUserTimeoutMs / 1000} seconds` : "off"}`,
      `Image paste markers: ${draft.imagePasteEnabled ? "on" : "off"}`,
      `Background task autopatch: ${draft.backgroundTaskAutopatchEnabled ? "on" : "off"}${process.env.PI_ENHANCE_BACKGROUND_AUTOPATCH === "0" ? " (disabled by environment)" : ""}`,
      "Save and apply", "Cancel",
    ];
    const selected = await ctx.ui.select("Pi enhancement settings", options);
    if (selected === undefined || selected === "Cancel") return;
    const index = options.indexOf(selected);
    if (index === 0 || index === 5 || index === 6) {
      const key = index === 0 ? "compactWhenAwayEnabled" : index === 5 ? "imagePasteEnabled" : "backgroundTaskAutopatchEnabled";
      const value = await ctx.ui.select(options[index].split(":")[0], ["on", "off"]);
      if (value === "on" || value === "off") draft[key] = value === "on";
    } else if (index === 1) {
      const value = await ctx.ui.select("Context threshold kind", ["count", "ratio"]);
      if (value === "count" || value === "ratio") draft.compactWhenAwayThresholdKind = value;
    } else if (index >= 2 && index <= 4) {
      const ratio = index === 2 && draft.compactWhenAwayThresholdKind === "ratio";
      const current = index === 2 ? ratio ? draft.compactWhenAwayThresholdRatio * 100 : draft.compactWhenAwayThresholdTokens
        : index === 3 ? draft.compactWhenAwayIdleMinutes : draft.askUserTimeoutMs / 1000;
      const title = index === 2 ? ratio ? "Context threshold (percent, >0–100)" : "Context threshold (tokens)"
        : index === 3 ? "Compact idle time (minutes, 1–1440)" : "Questionnaire idle timeout (seconds, 0=off, 1–86400)";
      const value = await ctx.ui.input(title, String(current));
      if (value === undefined) continue;
      const number = Number(value.trim());
      const valid = value.trim() !== "" && Number.isFinite(number) && (index === 4
        ? number === 0 || number >= 1 && number <= 86400
        : number > 0 && (ratio ? number <= 100 : Number.isSafeInteger(number) && (index !== 3 || number <= 1440)));
      if (!valid) { ctx.ui.notify("Enter a valid value within the indicated range.", "warning"); continue; }
      if (index === 2) {
        if (ratio) draft.compactWhenAwayThresholdRatio = number / 100;
        else draft.compactWhenAwayThresholdTokens = number;
      } else if (index === 3) draft.compactWhenAwayIdleMinutes = number;
      else draft.askUserTimeoutMs = Math.round(number * 1000);
    } else if (index === 7) {
      try {
        saveConfig(path, draft);
      } catch (error) {
        ctx.ui.notify(`Cannot save settings: ${error instanceof Error ? error.message : String(error)}`, "error");
        continue;
      }
      ctx.ui.notify("Enhancement settings saved. Reloading extensions.", "info");
      await ctx.reload();
      return;
    }
  }
}

export function registerSettings(pi: ExtensionAPI, config: Config, path: string): void {
  const handler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const command = args.trim();
    if (command === "show") {
      ctx.ui.notify([
        `Compact When Away: ${config.compactWhenAwayEnabled ? "on" : "off"}`,
        `Context threshold: ${config.compactWhenAwayThresholdKind}, >= ${compactThresholdLabel(config)}`,
        `Compact idle time: ${config.compactWhenAwayIdleMinutes} minutes`,
        `Questionnaire idle timeout: ${config.askUserTimeoutMs ? `${config.askUserTimeoutMs / 1000} seconds` : "off"}`,
        `Image paste markers: ${config.imagePasteEnabled ? "on" : "off"}`,
        `Background task autopatch: ${config.backgroundTaskAutopatchEnabled ? "on" : "off"}${process.env.PI_ENHANCE_BACKGROUND_AUTOPATCH === "0" ? " (disabled by environment)" : ""}`,
        `Config: ${path}`,
      ].join("\n"), "info");
    } else if (command === "" || command === "settings") {
      await editSettings(ctx, config, path);
    } else { ctx.ui.notify("Usage: /enhance-patches [settings|show]", "warning"); }
  };
  pi.registerCommand("enhance-patches", { description: "Configure all Pi enhancement settings", handler });
}
