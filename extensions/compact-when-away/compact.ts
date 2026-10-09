import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.ts";

/** Only arm after a completed run in this session; never compact a newly loaded history. */
export function registerCompactWhenAway(pi: ExtensionAPI, config: Config): void {
  if (!config.compactWhenAwayEnabled) return;
  const idleMs = config.compactWhenAwayIdleMinutes * 60_000;
  let ctx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let eligible = false;
  let attempted = false;
  let lastActivity = 0;
  let prompts = 0;
  const tools = new Set<string>();

  function clearTimer(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function disarm(): void {
    eligible = false;
    clearTimer();
  }

  function schedule(delay = idleMs): void {
    clearTimer();
    if (!ctx || !eligible) return;
    timer = setTimeout(check, delay);
    timer.unref();
  }

  function activity(): void {
    lastActivity = Date.now();
    schedule();
  }

  function check(): void {
    timer = undefined;
    const active = ctx;
    if (!active || !eligible) return;
    try {
      const remaining = idleMs - (Date.now() - lastActivity);
      if (remaining > 0) { schedule(remaining); return; }
      // isIdle also covers native compaction. Drafts and dialogs are user activity,
      // even when no agent run is active. Poll while blocked without restarting idle time.
      if (!active.isIdle() || active.hasPendingMessages() || prompts > 0 || tools.size > 0 ||
          active.ui.getEditorText().length > 0) {
        schedule(1000);
        return;
      }
      const usage = active.getContextUsage();
      const tokens = usage?.tokens;
      const window = usage?.contextWindow;
      const threshold = config.compactWhenAwayThresholdKind === "ratio"
        ? window != null && Number.isFinite(window) && window > 0
          ? window * config.compactWhenAwayThresholdRatio : undefined
        : config.compactWhenAwayThresholdTokens;
      if (tokens == null || !Number.isFinite(tokens) || threshold === undefined || tokens < threshold) {
        disarm();
        return;
      }
      // Consume before calling the asynchronous API, including failures/cancellations.
      attempted = true;
      disarm();
      active.ui.notify("Compact When Away: compacting idle context.", "info");
      active.compact({
        onComplete: () => {
          if (ctx === active) active.ui.notify("Compact When Away: context compacted.", "info");
        },
        onError: error => {
          if (ctx === active) active.ui.notify(`Compact When Away: ${error.message}`, "warning");
        },
      });
    } catch (error) {
      disarm();
      if (ctx === active) active.ui.notify(`Compact When Away: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }

  function cleanup(): void {
    disarm();
    unsubscribe?.();
    unsubscribe = undefined;
    ctx = undefined;
    prompts = 0;
    tools.clear();
  }

  pi.on("session_start", (_event, context) => {
    cleanup();
    attempted = false;
    if (context.mode !== "tui" || !context.hasUI) return;
    if (typeof context.ui.onTerminalInput !== "function" || typeof context.ui.getEditorText !== "function") {
      context.ui.notify("Compact When Away requires terminal input and editor APIs.", "warning");
      return;
    }
    ctx = context;
    unsubscribe = context.ui.onTerminalInput(() => { activity(); return undefined; });
  });
  pi.on("session_shutdown", cleanup);
  pi.on("input", () => { disarm(); });
  pi.on("agent_start", () => { attempted = false; disarm(); });
  // Unlike agent_end, settlement occurs after retries, queued messages and auto-compaction.
  pi.on("agent_settled", event => {
    if (!ctx || attempted || event.aborted) return;
    eligible = true;
    activity();
  });
  pi.on("tool_execution_start", event => { tools.add(event.toolCallId); clearTimer(); });
  pi.on("tool_execution_end", event => { tools.delete(event.toolCallId); activity(); });
  pi.on("ui_prompt_start", () => { prompts++; clearTimer(); });
  pi.on("ui_prompt_end", () => { prompts = Math.max(0, prompts - 1); activity(); });
  // Manual/native compaction also consumes this idle period, even if cancelled.
  pi.on("session_before_compact", () => { attempted = true; disarm(); });
  pi.on("session_compact", () => { attempted = true; disarm(); });
  pi.on("session_compact_failed", () => { attempted = true; disarm(); });
  pi.on("session_before_switch", disarm);
  pi.on("session_before_fork", disarm);
  pi.on("session_before_tree", disarm);
  pi.on("session_tree", disarm);
  // A shell command has no extension completion event. Wait for the next agent run.
  pi.on("user_bash", () => { disarm(); });
}
