import { ExtensionRunner, type ExtensionToolContext, type RegisteredTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { closeOverlay } from "../pi-custom-overlay/close-overlay.ts";

type Execute = ToolDefinition["execute"];
type Result = Awaited<ReturnType<Execute>>;
const KEY = Symbol.for("pi.enhance-patches-asks.owner");
export const TIMEOUT_MESSAGE = "The user did not answer before the questionnaire idle timeout. The questions were skipped automatically, not declined. No option was selected or approved. Continue only with work that does not require these answers; do not immediately repeat the same questionnaire.";

function timeoutResult(result: Result, timeoutMs: number): Result {
  return {
    ...result,
    content: [{ type: "text", text: TIMEOUT_MESSAGE }],
    details: { ...(result.details && typeof result.details === "object" ? result.details : {}), answers: [], cancelled: true, timedOut: true, reason: "idle_timeout", timeoutMs },
  };
}

/** Each invocation gets its own UI facade; the host UI object is never mutated. */
export function wrapAskExecute(original: Execute, timeoutMs: number, pending: Set<() => void>): Execute {
  return async function (this: unknown, id, params, signal, onUpdate, ctx) {
    if (timeoutMs <= 0 || !ctx.hasUI || ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
      return original.call(this, id, params, signal, onUpdate, ctx);
    }
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline = 0;
    let paused = false;
    let handle: OverlayHandle | undefined;
    let finish: ((result: unknown) => void) | undefined;
    const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
    const touch = () => { deadline = Date.now() + timeoutMs; };
    const close = (result: unknown) => {
      if (settled) return;
      settled = true;
      clearTimer();
      finish?.(result);
    };
    // The native close callback hides the top overlay. Wait while another overlay
    // owns focus or this questionnaire is hidden, so timeout cannot dismiss it.
    const tick = () => {
      if (settled) return;
      if (paused || (handle && (handle.isHidden() || !handle.isFocused()))) touch();
      if (Date.now() >= deadline) {
        timedOut = true;
        close({ answers: [], cancelled: true });
      } else {
        timer = setTimeout(tick, Math.min(250, Math.max(1, deadline - Date.now())));
        timer.unref?.();
      }
    };
    const cancel = () => close({ answers: [], cancelled: true });
    pending.add(cancel);
    const ui = Object.create(ctx.ui) as ExtensionToolContext["ui"];
    ui.custom = ((factory, options) => ctx.ui.custom(async (tui, theme, keys, done) => {
      const complete = done as (value: unknown) => void;
      finish = result => {
        if (!options?.overlay || !handle) { complete(result); return; }
        // Pi 1.1.0's close() calls hideOverlay(), which removes the top entry.
        // For cancellation during shutdown/abort, close this exact handle even
        // when another dialog is above it. Override only during synchronous done().
        closeOverlay(tui, handle, () => complete(result));
      };
      if (settled) { finish({ answers: [], cancelled: true }); return { render: () => [], invalidate() {} }; }
      // rpiv's external editor stops/starts this TUI. Pause only this dialog's
      // clock, and bind all other methods to the original TUI instance.
      const scopedTui = new Proxy(tui, {
        get(target, property) {
          if (property === "stop") return (...args: Parameters<typeof tui.stop>) => {
            paused = true; return target.stop(...args);
          };
          if (property === "start") return () => { target.start(); paused = false; touch(); };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const component = await factory(scopedTui, theme, keys, close);
      if (settled) component.dispose?.();
      const scopedComponent = Object.create(component) as typeof component;
      if (component.handleInput) scopedComponent.handleInput = data => { touch(); component.handleInput?.(data); };
      scopedComponent.dispose = () => { settled = true; clearTimer(); component.dispose?.(); };
      if (!settled) { touch(); tick(); }
      return scopedComponent;
    }, {
      ...options,
      onHandle: nextHandle => { handle = nextHandle; options?.onHandle?.(nextHandle); },
    })) as typeof ui.custom;
    if (typeof ctx.ui.onTerminalInput === "function") {
      ui.onTerminalInput = listener => ctx.ui.onTerminalInput(data => {
        const result = listener(data);
        if (result?.consume) touch();
        return result;
      });
    }
    const scopedContext = Object.create(ctx) as ExtensionToolContext;
    Object.defineProperty(scopedContext, "ui", { value: ui });
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      const result = await original.call(this, id, params, signal, onUpdate, scopedContext);
      return timedOut ? timeoutResult(result, timeoutMs) : result;
    } finally {
      settled = true;
      clearTimer();
      pending.delete(cancel);
      signal?.removeEventListener("abort", cancel);
    }
  };
}

/** Intercept registry reads before Pi builds its execution wrappers, in either load order. */
export function installAskTimeout(timeoutMs: number, prototype = ExtensionRunner.prototype): () => void {
  const host = prototype as typeof prototype & { [KEY]?: { dispose(): void } };
  host[KEY]?.dispose();
  const list = prototype.getAllRegisteredTools;
  const get = prototype.getToolDefinition;
  const originals = new Map<ToolDefinition, { original: Execute; installed: Execute }>();
  const pending = new Set<() => void>();
  let active = true;
  function patch(definition: ToolDefinition | undefined): void {
    if (!active || !definition || definition.name !== "ask_user_question" || originals.has(definition)) return;
    const original = definition.execute;
    const wrapped = wrapAskExecute(original, timeoutMs, pending);
    const installed: Execute = function (this: unknown, ...args) { return (active ? wrapped : original).apply(this, args); };
    originals.set(definition, { original, installed });
    definition.execute = installed;
  }
  const installedList = function (this: ExtensionRunner): RegisteredTool[] {
    const tools = list.call(this);
    tools.forEach(tool => patch(tool.definition));
    return tools;
  };
  const installedGet = function (this: ExtensionRunner, name: string) {
    const definition = get.call(this, name);
    patch(definition);
    return definition;
  };
  const owner = {
    dispose() {
      if (!active) return;
      active = false;
      for (const cancel of pending) cancel();
      for (const [definition, { original, installed }] of originals) {
        if (definition.execute === installed) definition.execute = original;
      }
      originals.clear();
      if (prototype.getAllRegisteredTools === installedList) prototype.getAllRegisteredTools = list;
      if (prototype.getToolDefinition === installedGet) prototype.getToolDefinition = get;
      if (host[KEY] === owner) delete host[KEY];
    },
  };
  prototype.getAllRegisteredTools = installedList;
  prototype.getToolDefinition = installedGet;
  host[KEY] = owner;
  return () => owner.dispose();
}
