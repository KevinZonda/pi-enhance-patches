// Passive lifecycle/render observer for the isolated CLI PoC. Never requests a render.
import { appendFileSync } from "node:fs";
import { InteractiveMode, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { CustomOverlayHost } from "../extensions/pi-custom-overlay/overlay-close.ts";

export default function (pi: ExtensionAPI) {
  const path = process.env.PI_POC_LOG;
  if (!path) throw new Error("PI_POC_LOG is required");
  const host = InteractiveMode.prototype as unknown as CustomOverlayHost;
  const original = host.showExtensionCustom;
  let lastTui: any;
  let lastRenderer: any;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const sample = (phase: string) => {
    if (!lastTui) return;
    const lines = lastTui.previousScreen ?? lastTui.captureRenderState?.().previousLines ?? [];
    const screen = lines.map((line: string) => stripTerminalSequences(line)).join("\n");
    appendFileSync(path, JSON.stringify({ at: Date.now(), event: "ui-sample", details: {
      phase, hasOverlayEntries: lastTui.hasOverlayEntries,
      hasOverlay: lastTui.hasOverlay(), focus: lastTui.getFocusedComponent()?.constructor.name,
      renderRequested: lastTui.renderRequested, stopped: lastTui.stopped,
      referenceHasOwnHideOverlay: Object.hasOwn(lastTui, "hideOverlay"),
      rendererHasOwnHideOverlay: lastRenderer ? Object.hasOwn(lastRenderer, "hideOverlay") : undefined,
      questionnairePainted: /Review your answers|Ready to submit your answers/.test(screen), screen,
    } }) + "\n");
  };
  const installed: ExtensionUIContext["custom"] = function (this: CustomOverlayHost, factory, options) {
    lastRenderer = (this as CustomOverlayHost & { renderer?: unknown }).renderer;
    return original.call(this, (tui, theme, keys, done) => {
      lastTui = tui;
      return factory(tui, theme, keys, done);
    }, options).then(result => {
      sample("custom-resolved");
      for (const milliseconds of [50, 500, 2000]) {
        const timer = setTimeout(() => { timers.delete(timer); sample(`close+${milliseconds}ms`); }, milliseconds);
        timers.add(timer);
      }
      return result;
    });
  } as ExtensionUIContext["custom"];
  host.showExtensionCustom = installed;
  pi.on("tool_result", event => { if (event.toolName === "ask_user_question") sample("tool-result"); });
  pi.on("agent_end", () => sample("agent-end"));
  pi.on("session_shutdown", () => {
    for (const timer of timers) clearTimeout(timer);
    if (host.showExtensionCustom === installed) host.showExtensionCustom = original;
  });
}
