import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { createJiti } from "jiti";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import enhancePatches from "../extensions/index.ts";
import { findPermissionService, installPermissionMode, selectPermissionMode, type PermissionMode } from "../extensions/pi-permission-system/permission-mode.ts";

const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, { moduleCache: false });
const originalPlugin = await jiti.import<(pi: ExtensionAPI) => void>(join(dirname(require.resolve("@gotgenes/pi-permission-system")), "index.ts"), { default: true });

type Handler = (event: unknown, ctx: unknown) => unknown;
function fakePi(flags: Record<string, boolean> = {}) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
  const registered: string[] = [];
  const pi = {
    events: createEventBus(),
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerFlag(name: string) { registered.push(name); },
    getFlag(name: string) { return flags[name]; },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) { commands.set(name, options); },
    getAllTools: () => ["read", "write", "edit", "bash"].map(name => ({ name })),
    getActiveTools: () => ["read", "write", "edit", "bash"],
    setActiveTools: () => {},
    registerProvider: () => {},
  };
  return {
    api: pi as unknown as ExtensionAPI, registered, commands, handlers,
    async fire(name: string, event: unknown, ctx: unknown) {
      let result: unknown;
      for (const handler of handlers.get(name) ?? []) {
        const next = await handler(event, ctx);
        if (next !== undefined) result = next;
        if (next && typeof next === "object" && "block" in next && next.block) return next;
      }
      return result;
    },
  };
}

test("flags are mutually exclusive and optional", () => {
  assert.equal(selectPermissionMode(() => undefined), undefined);
  for (const mode of ["yolo", "ask", "deny"]) assert.equal(selectPermissionMode(name => name === mode), mode);
  for (const pair of [["yolo", "ask"], ["yolo", "deny"], ["ask", "deny"]]) {
    assert.throws(() => selectPermissionMode(name => pair.includes(name)), /mutually exclusive/);
  }
  const pi = fakePi();
  enhancePatches(pi.api);
  assert.deepEqual(pi.registered, ["yolo", "ask", "deny"]);
});

test("real permission plugin: modes, refresh, saving, cleanup and both load orders", async t => {
  for (const mode of ["yolo", "ask", "deny"] as PermissionMode[]) {
    for (const patchFirst of [false, true]) {
      await t.test(`${mode}, patch loaded ${patchFirst ? "first" : "last"}`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "pi-enhance-test-"));
        const previousDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = dir;
        const configPath = join(dir, "extensions/pi-permission-system/config.json");
        mkdirSync(dirname(configPath), { recursive: true });
        const persistedYolo = mode !== "yolo";
        writeFileSync(configPath, JSON.stringify({ yoloMode: persistedYolo, authorizerChain: ["test-auto"], permission: {
          "*": "allow", bash: { "*": "ask", "echo *": "allow", "forbidden *": "deny" },
          path: { "*": "allow", "*.env": "deny" },
        } }));
        const before = readFileSync(configPath, "utf8");
        const flags: Record<string, boolean> = {};
        const pi = fakePi(flags);
        const statuses = new Map<string, string | undefined>();
        const prompts: string[] = [];
        let idle = true;
        const ctx = {
          cwd: dir, hasUI: true, isProjectTrusted: () => true,
          isIdle: () => idle,
          sessionManager: { getSessionId: () => `session-${mode}-${patchFirst}`, getSessionDir: () => dir,
            getEntries: () => [], getSessionName: () => undefined },
          ui: { setStatus: (key: string, value: string | undefined) => statuses.set(key, value), notify: () => {},
            select: async (title: string) => { prompts.push(title); return title === "Temporary permission mode" ? "ask" : "Yes"; }, input: async () => undefined },
        };
        try {
          if (patchFirst) enhancePatches(pi.api);
          originalPlugin(pi.api);
          if (!patchFirst) enhancePatches(pi.api);
          flags[mode] = true;
          await pi.fire("session_start", { reason: "start" }, ctx);
          assert.equal(statuses.get("pi-permission-system"), `${mode}`);
          const service = findPermissionService(ctx.sessionManager.getSessionId()) as {
            registerAuthorizer: (name: string, fn: () => Promise<{ kind: "allow" }>) => () => void;
            session: { configStore: { current: () => { yoloMode: boolean }; save: (next: unknown, ctx: unknown) => void } };
          };
          const store = service.session.configStore;
          let autoCalls = 0;
          service.registerAuthorizer("test-auto", async () => { autoCalls++; return { kind: "allow" }; });
          const effectiveCurrent = store.current;
          for (let turn = 0; turn < 2; turn++) {
            await pi.fire("before_agent_start", { systemPrompt: "", systemPromptOptions: { sections: {}, skills: [] } }, ctx);
            const result = await pi.fire("tool_call", { toolName: "bash", toolCallId: `ask-${turn}`, input: { command: "pwd" } }, ctx);
            if (mode === "deny") assert.equal((result as { block: boolean }).block, true);
            else assert.deepEqual(result, {});
          }
          assert.equal(prompts.length, mode === "ask" ? 2 : 0);
          assert.equal(autoCalls, 0);
          assert.deepEqual(await pi.fire("tool_call", { toolName: "bash", toolCallId: "allow", input: { command: "echo ok" } }, ctx), {});
          for (const [toolName, input] of [["bash", { command: "forbidden operation" }], ["read", { path: join(dir, "secret.env") }]] as const) {
            const result = await pi.fire("tool_call", { toolName, toolCallId: "hard-deny", input }, ctx);
            assert.equal((result as { block: boolean }).block, true);
          }
          assert.equal(readFileSync(configPath, "utf8"), before);
          store.save({ ...store.current(), debugLog: true }, ctx);
          assert.equal(JSON.parse(readFileSync(configPath, "utf8")).yoloMode, persistedYolo);
          assert.equal(store.current().yoloMode, mode === "yolo");
          assert.equal(statuses.get("pi-permission-system"), `${mode}`);
          const command = pi.commands.get("permission");
          assert.ok(command);
          const savedBeforeCommands = readFileSync(configPath, "utf8");
          for (const next of ["deny", "yolo", "ask"] as const) {
            await command.handler(next, ctx);
            assert.equal(statuses.get("pi-permission-system"), `${next}`);
            await pi.fire("before_agent_start", { systemPrompt: "", systemPromptOptions: { sections: {}, skills: [] } }, ctx);
            assert.equal(statuses.get("pi-permission-system"), `${next}`);
            const result = await pi.fire("tool_call", { toolName: "bash", toolCallId: `switch-${next}`, input: { command: "pwd" } }, ctx);
            if (next === "deny") assert.equal((result as { block: boolean }).block, true);
            else assert.deepEqual(result, {});
          }
          idle = false;
          await command.handler("yolo", ctx);
          assert.equal(statuses.get("pi-permission-system"), "yolo");
          await command.handler("invalid", ctx);
          assert.equal(statuses.get("pi-permission-system"), "yolo");
          await command.handler("default", ctx);
          assert.equal(store.current().yoloMode, persistedYolo);
          assert.equal(statuses.get("pi-permission-system"), persistedYolo ? "yolo" : undefined);
          await pi.fire("before_agent_start", { systemPrompt: "", systemPromptOptions: { sections: {}, skills: [] } }, ctx);
          assert.equal(store.current().yoloMode, persistedYolo);
          assert.equal(statuses.get("pi-permission-system"), persistedYolo ? "yolo" : undefined);
          const promptsBeforeDefault = prompts.length;
          assert.deepEqual(await pi.fire("tool_call", { toolName: "bash", toolCallId: "default", input: { command: "pwd" } }, ctx), {});
          assert.equal(prompts.length, promptsBeforeDefault);
          assert.equal(autoCalls, persistedYolo ? 0 : 1);
          await command.handler("", ctx);
          assert.equal(statuses.get("pi-permission-system"), "ask");
          await command.handler("show", ctx);
          assert.equal(readFileSync(configPath, "utf8"), savedBeforeCommands);
          await pi.fire("session_shutdown", {}, ctx);
          assert.notEqual(store.current, effectiveCurrent);
          assert.equal(store.current().yoloMode, persistedYolo);
        } finally {
          await pi.fire("session_shutdown", {}, ctx);
          if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
          else process.env.PI_CODING_AGENT_DIR = previousDir;
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }
});

test("missing or incompatible plugin blocks requested mode", async () => {
  assert.throws(() => installPermissionMode({}, "yolo"), /Missing permission runtime/);
  const pi = fakePi({ yolo: true });
  enhancePatches(pi.api);
  const ctx = { sessionManager: { getSessionId: () => "missing" }, ui: { notify: () => {} } };
  await pi.fire("session_start", {}, ctx);
  assert.equal((await pi.fire("tool_call", {}, ctx) as { block: boolean }).block, true);
  await pi.fire("session_shutdown", {}, ctx);
});

test("teardown preserves newer owners and deactivates superseded wrappers", () => {
  const configStore = { current: () => ({ yoloMode: false }), save: () => {} };
  const selection = { escalate: async () => ({ approved: true }), linksFor: () => ["judge"] };
  const service = { session: { configStore, authorizerSelection: selection, refreshConfig: () => {}, getRuntimeContext: () => null } };
  const restoreOld = installPermissionMode(service, "yolo");
  const restoreNew = installPermissionMode(service, "ask");
  restoreOld();
  assert.equal(configStore.current().yoloMode, false);
  assert.deepEqual(selection.linksFor(), []);
  restoreNew();
  assert.equal(configStore.current().yoloMode, false);
  assert.deepEqual(selection.linksFor(), ["judge"]);
});

test("incompatible instance is validated before any method is changed", () => {
  const current = () => ({ yoloMode: false });
  const configStore = { current, save: () => {} };
  assert.throws(() => installPermissionMode({ session: { configStore, authorizerSelection: {} } }, "yolo"), /Unsupported/);
  assert.equal(configStore.current, current);
});

test("slash command enables temporary mode without CLI flags and resets without saving", async () => {
  const key = Symbol.for("@gotgenes/pi-permission-system:session-services");
  const globals = globalThis as Record<symbol, unknown>;
  const previous = globals[key];
  const statuses = new Map<string, unknown>();
  const notices: string[] = [];
  const ctx = { hasUI: true, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "slash-only" },
    ui: { notify: (message: string) => notices.push(message), setStatus: (name: string, value: unknown) => statuses.set(name, value), select: async () => undefined },
  };
  const current = () => ({ yoloMode: false });
  const service = { session: {
    configStore: { current, save: () => { throw new Error("Command must not save config"); } },
    authorizerSelection: { escalate: async () => ({ approved: true }), linksFor: () => ["judge"] },
    refreshConfig: () => ctx.ui.setStatus("pi-permission-system", undefined), getRuntimeContext: () => ctx,
  } };
  globals[key] = new Map([["slash-only", service]]);
  const pi = fakePi();
  enhancePatches(pi.api);
  try {
    await pi.fire("session_start", {}, ctx);
    assert.equal(service.session.configStore.current, current);
    const command = pi.commands.get("permission");
    assert.ok(command);
    await command.handler("yolo", ctx);
    assert.equal(service.session.configStore.current().yoloMode, true);
    await command.handler("", ctx); // Cancel the picker without changing mode.
    assert.equal(statuses.get("pi-permission-system"), "yolo");
    await command.handler("show", ctx);
    assert.match(notices.at(-1) ?? "", /yolo.*YOLO on/);
    await command.handler("default", ctx);
    assert.equal(service.session.configStore.current, current);
    assert.equal(statuses.get("pi-permission-system"), undefined);
    assert.equal(await pi.fire("tool_call", {}, ctx), undefined);
  } finally {
    await pi.fire("session_shutdown", {}, ctx);
    if (previous === undefined) delete globals[key]; else globals[key] = previous;
  }
});

test("busy default sessions switch modes for new requests without resolving existing approval dialogs", async t => {
  const dir = mkdtempSync(join(tmpdir(), "pi-permission-busy-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const path = join(dir, "extensions/pi-permission-system/config.json");
  mkdirSync(dirname(path), { recursive: true });
  const saved = JSON.stringify({ yoloMode: false, authorizerChain: [], permission: {
    "*": "allow", bash: { "*": "ask", "forbidden *": "deny", "echo *": "allow" },
  } });
  writeFileSync(path, saved);
  const pi = fakePi();
  const statuses = new Map<string, unknown>();
  const notices: string[] = [];
  const dialogs: Array<{ answer(value: string): void }> = [];
  let opened: (() => void) | undefined;
  const ctx = {
    cwd: dir, hasUI: true, isIdle: () => false, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "busy-default", getSessionDir: () => dir,
      getEntries: () => [], getSessionName: () => undefined },
    ui: {
      setStatus: (name: string, value: unknown) => statuses.set(name, value),
      notify: (message: string) => notices.push(message),
      select: async () => new Promise<string>(resolve => {
        dialogs.push({ answer: resolve });
        opened?.();
      }),
      input: async () => undefined,
    },
  };
  originalPlugin(pi.api);
  enhancePatches(pi.api);
  const tasks: Promise<unknown>[] = [];
  t.after(async () => {
    for (const dialog of dialogs) dialog.answer("No");
    await Promise.allSettled(tasks);
    await pi.fire("session_shutdown", {}, ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const call = (id: string, command = "pwd") => pi.fire("tool_call", { toolName: "bash", toolCallId: id, input: { command } }, ctx);
  async function waitingApproval(id: string) {
    const ready = new Promise<void>(resolve => { opened = resolve; });
    const result = call(id);
    tasks.push(result);
    await Promise.race([ready, result.then(value => { throw new Error(`Expected approval dialog: ${JSON.stringify(value)}`); })]);
    opened = undefined;
    let finished = false;
    void result.then(() => { finished = true; });
    return { result, finished: () => finished, dialog: dialogs.at(-1)! };
  }
  await pi.fire("session_start", {}, ctx);
  const service = findPermissionService("busy-default") as any;
  const baseline = service.session.configStore.current;
  const permission = pi.commands.get("permission")!;
  assert.equal(service.session.configStore.current().yoloMode, false);
  const old = await waitingApproval("before-switch");
  await permission.handler("yolo", ctx);
  assert.equal(statuses.get("pi-permission-system"), "yolo");
  assert.deepEqual(await call("new-yolo"), {});
  assert.equal(dialogs.length, 1);
  assert.equal(old.finished(), false);
  await permission.handler("deny", ctx);
  assert.equal((await call("new-deny") as { block: boolean }).block, true);
  assert.equal(dialogs.length, 1);
  assert.equal(old.finished(), false);
  await permission.handler("ask", ctx);
  // Resolve the original dialog as a real user would; subsequent asks use the
  // newly selected mode, even though the agent remains busy throughout.
  assert.equal(old.finished(), false);
  old.dialog.answer("Yes");
  assert.deepEqual(await old.result, {});
  const next = await waitingApproval("new-ask");
  await permission.handler("default", ctx);
  assert.equal(service.session.configStore.current, baseline);
  assert.equal(statuses.get("pi-permission-system"), undefined);
  assert.equal(next.finished(), false);
  next.dialog.answer("No");
  assert.equal((await next.result as { block: boolean }).block, true);
  const restored = await waitingApproval("new-default");
  restored.dialog.answer("Yes");
  assert.deepEqual(await restored.result, {});
  await permission.handler("yolo", ctx);
  assert.equal((await call("explicit-deny", "forbidden operation") as { block: boolean }).block, true);
  assert.deepEqual(await call("explicit-allow", "echo ok"), {});
  assert.equal(readFileSync(path, "utf8"), saved);
  assert.ok(!notices.some(message => message.includes("agent is idle")));
});
