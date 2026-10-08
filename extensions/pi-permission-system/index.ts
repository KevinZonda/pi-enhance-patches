import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findPermissionService, getEffectiveYoloMode, installPermissionMode, refreshPermissionConfiguration, selectPermissionMode, type PermissionMode } from "./permission-mode.ts";

export function registerPermissionSystemPatches(pi: ExtensionAPI): void {
  pi.registerFlag("yolo", { type: "boolean", description: "Temporarily approve ask permissions; explicit denies remain" });
  pi.registerFlag("ask", { type: "boolean", description: "Temporarily prompt for ask permissions, overriding YOLO and automatic authorizers" });
  pi.registerFlag("deny", { type: "boolean", description: "Temporarily reject ask permissions; existing allows and denies remain" });
  // Pi fills extension flags after loading factories, before session_start.
  let mode: PermissionMode | undefined;
  let initialized = false;
  let installedMode: PermissionMode | undefined;

  let service: unknown;
  let restore: (() => void) | undefined;
  let failure = "Permission plugin has not published a compatible service.";
  let context: ExtensionContext | undefined;

  function initialize(): void {
    if (initialized) return;
    mode = selectPermissionMode(name => pi.getFlag(name));
    initialized = true;
  }

  function attach(sessionId: string): void {
    try {
      initialize();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      return;
    }
    if (!mode) return;
    const candidate = findPermissionService(sessionId);
    if (candidate && candidate === service && installedMode === mode) return;
    restore?.();
    restore = undefined;
    service = undefined;
    installedMode = undefined;
    if (!candidate) {
      failure = "Permission plugin has not published a compatible service.";
      return;
    }
    try {
      restore = installPermissionMode(candidate, mode);
      service = candidate;
      installedMode = mode;
      failure = "";
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      context?.ui.notify(`pi-enhance-patches: ${failure}; tool calls are blocked.`, "error");
    }
  }
  const unsubscribe = pi.events.on("permissions:ready", event => {
    if (event && typeof event === "object" && "sessionId" in event && typeof event.sessionId === "string") attach(event.sessionId);
  });
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    try {
      initialize();
    } catch (error) {
      console.error(`pi-enhance-patches: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    if (!mode) return;
    const id = ctx.sessionManager.getSessionId();
    if (id) attach(id);
    if (failure) ctx.ui.notify(`pi-enhance-patches: ${failure}; tool calls are blocked.`, "error");
  });
  pi.on("before_agent_start", (_event, ctx) => {
    if (!mode) return;
    const id = ctx.sessionManager.getSessionId();
    if (id) attach(id);
  });
  pi.on("tool_call", () => {
    if (mode && !restore) return { block: true, reason: `pi-enhance-patches: ${failure}` };
  });
  const choices = [
    { value: "yolo", label: "yolo", description: "Auto-approve asks temporarily; explicit denies remain" },
    { value: "ask", label: "ask", description: "Prompt for asks temporarily; bypass automatic authorizers" },
    { value: "deny", label: "deny", description: "Reject asks temporarily; existing allows remain" },
    { value: "default", label: "default", description: "Remove the temporary override and use configuration" },
    { value: "show", label: "show", description: "Show the current mode" },
  ];
  pi.registerCommand("permission", {
    description: "View or change temporary permission mode: yolo, ask, deny, default",
    getArgumentCompletions: prefix => choices.filter(choice => choice.value.startsWith(prefix.trim().toLowerCase())),
    handler: async (args, ctx) => {
      initialize();
      context = ctx;
      const sessionId = ctx.sessionManager.getSessionId();
      const candidate = sessionId ? findPermissionService(sessionId) : undefined;
      function show(): void {
        let effective = "; permission plugin unavailable";
        if (candidate) {
          try { effective = `; effective YOLO ${getEffectiveYoloMode(candidate) ? "on" : "off"}`; }
          catch { effective = "; permission plugin incompatible"; }
        }
        ctx.ui.notify(`Permission: ${mode ? `${mode} (temporary)` : "default (configuration)"}${effective}${mode && !restore ? `; blocked: ${failure}` : ""}`, "info");
      }
      let action = args.trim().toLowerCase();
      if (!action) {
        show();
        if (!ctx.hasUI) return;
        const selected = await ctx.ui.select("Temporary permission mode", choices.filter(choice => choice.value !== "show").map(choice => choice.value));
        if (!selected) return;
        action = selected;
      }
      if (action === "show") { show(); return; }
      if (!["yolo", "ask", "deny", "default"].includes(action)) {
        ctx.ui.notify("Usage: /permission [yolo|ask|deny|default|show]", "warning");
        return;
      }
      if (action !== "default" && !candidate) {
        ctx.ui.notify("Permission plugin unavailable; mode unchanged.", "error");
        return;
      }
      if (action === "default") {
        restore?.();
        restore = undefined;
        service = undefined;
        installedMode = undefined;
        mode = undefined;
        failure = "";
        if (candidate) refreshPermissionConfiguration(candidate, ctx, ctx.isProjectTrusted());
        else ctx.ui.setStatus("pi-permission-system", undefined);
      } else {
        mode = action as PermissionMode;
        if (sessionId) attach(sessionId);
      }
      show();
    },
  });
  pi.on("session_shutdown", () => {
    unsubscribe();
    restore?.();
    restore = undefined;
    service = undefined;
    installedMode = undefined;
    context = undefined;
  });
}
