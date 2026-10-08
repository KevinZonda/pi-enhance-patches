import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findPermissionService, installPermissionMode, selectPermissionMode, type PermissionMode } from "./permission-mode.ts";

export function registerPermissionSystemPatches(pi: ExtensionAPI): void {
  pi.registerFlag("yolo", { type: "boolean", description: "Temporarily approve ask permissions; explicit denies remain" });
  pi.registerFlag("ask", { type: "boolean", description: "Temporarily prompt for ask permissions, overriding YOLO and automatic authorizers" });
  pi.registerFlag("deny", { type: "boolean", description: "Temporarily reject ask permissions; existing allows and denies remain" });
  // Pi fills extension flags after loading factories, before session_start.
  let mode: PermissionMode | undefined;

  let service: unknown;
  let restore: (() => void) | undefined;
  let failure = "Permission plugin has not published a compatible service.";
  let context: ExtensionContext | undefined;

  function attach(sessionId: string): void {
    try {
      mode = selectPermissionMode(name => pi.getFlag(name));
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      return;
    }
    if (!mode) return;
    const candidate = findPermissionService(sessionId);
    if (candidate && candidate === service) return;
    restore?.();
    restore = undefined;
    service = undefined;
    if (!candidate) {
      failure = "Permission plugin has not published a compatible service.";
      return;
    }
    try {
      restore = installPermissionMode(candidate, mode);
      service = candidate;
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
      mode = selectPermissionMode(name => pi.getFlag(name));
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
  pi.on("session_shutdown", () => {
    unsubscribe();
    restore?.();
    restore = undefined;
    service = undefined;
    context = undefined;
  });
}
