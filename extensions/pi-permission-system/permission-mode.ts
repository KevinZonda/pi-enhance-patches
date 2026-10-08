export type PermissionMode = "yolo" | "ask" | "deny";

type Method = (...args: unknown[]) => unknown;
type RuntimeObject = Record<string, unknown>;

function object(value: unknown, name: string): RuntimeObject {
  if (value === null || typeof value !== "object") throw new Error(`Missing permission runtime ${name}`);
  return value as RuntimeObject;
}

function method(target: RuntimeObject, name: string): Method {
  const value = target[name];
  if (typeof value !== "function") throw new Error(`Unsupported permission runtime method ${name}`);
  return value as Method;
}

export function selectPermissionMode(getFlag: (name: string) => unknown): PermissionMode | undefined {
  const modes: PermissionMode[] = ["yolo", "ask", "deny"];
  const selected = modes.filter(mode => getFlag(mode) === true);
  if (selected.length > 1) throw new Error("--yolo, --ask and --deny are mutually exclusive.");
  return selected[0];
}

/** Patch one node's shared instances, preserving descriptors and newer owners on teardown. */
export function installPermissionMode(service: unknown, mode: PermissionMode): () => void {
  const session = object(object(service, "service").session, "session");
  const config = object(session.configStore, "config store");
  const selection = object(session.authorizerSelection, "authorizer selection");
  const current = method(config, "current");
  const save = method(config, "save");
  const refresh = method(session, "refreshConfig");
  const escalate = method(selection, "escalate");
  const linksFor = method(selection, "linksFor");
  const getContext = method(session, "getRuntimeContext");
  const baseline = object(current.call(config), "config");
  if (typeof baseline.yoloMode !== "boolean") throw new Error("Unsupported permission runtime config");

  const restores: (() => void)[] = [];
  let active = true;
  function replace(target: RuntimeObject, name: string, replacement: Method): void {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, { configurable: true, writable: true, value: replacement });
    restores.push(() => {
      if (target[name] !== replacement) return;
      if (descriptor) Object.defineProperty(target, name, descriptor);
      else delete target[name];
    });
  }
  function status(ctx: unknown): void {
    if (ctx === null || typeof ctx !== "object") return;
    const ui = object((ctx as RuntimeObject).ui, "UI");
    method(ui, "setStatus").call(ui, "pi-permission-system", `${mode} (temporary)`);
  }
  try {
    replace(config, "current", function () {
      if (!active) return current.call(config);
      return { ...object(current.call(config), "config"), yoloMode: mode === "yolo" };
    });
    replace(config, "save", function (next, ctx) {
      if (!active) return save.call(config, next, ctx);
      // The modal reads the effective config. Persist the underlying YOLO value instead.
      const stored = object(current.call(config), "config");
      const result = save.call(config, { ...object(next, "settings"), yoloMode: stored.yoloMode }, ctx);
      status(ctx);
      return result;
    });
    replace(session, "refreshConfig", function (...args) {
      const result = refresh.apply(session, args);
      if (active) status(args[0] ?? getContext.call(session));
      return result;
    });
    if (mode === "ask") replace(selection, "linksFor", (...args) => active ? [] : linksFor.apply(selection, args));
    if (mode === "deny") replace(selection, "escalate", function (...args) {
      if (!active) return escalate.apply(selection, args);
      const reason = "Approval-required operation rejected by --deny for this run.";
      return Promise.resolve({ approved: false, state: "denied", denialReason: reason,
        decidedBy: { kind: "authorizer", name: "pi-enhance-patches:deny", verdict: "deny", reason } });
    });
    status(getContext.call(session));
  } catch (error) {
    active = false;
    for (const restore of restores.reverse()) restore();
    throw error;
  }
  return () => {
    active = false;
    for (const restore of restores.toReversed()) restore();
  };
}

export function findPermissionService(sessionId: string): unknown {
  const key = Symbol.for("@gotgenes/pi-permission-system:session-services");
  const registry = (globalThis as Record<symbol, unknown>)[key];
  return registry instanceof Map ? registry.get(sessionId) : undefined;
}
