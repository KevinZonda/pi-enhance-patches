import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { ExtensionRunner, createEventBus } from "@earendil-works/pi-coding-agent";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { host } from "./ask-helpers.ts";
import { findPermissionService } from "../extensions/pi-permission-system/permission-mode.ts";

test("merged package times out questions while leaving a real permission approval waiting", async t => {
  const originalRegistry = ExtensionRunner.prototype.getAllRegisteredTools;
  const dir = mkdtempSync(join(tmpdir(), "pi-combined-patches-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  writeFileSync(join(dir, "pi-enhance-patches-asks.json"), JSON.stringify({ askUserTimeoutMs: 1000 }));
  const permissions = join(dir, "extensions/pi-permission-system/config.json");
  mkdirSync(dirname(permissions), { recursive: true });
  writeFileSync(permissions, JSON.stringify({ doublePressToConfirm: false, permission: { "*": "allow", bash: { "*": "ask" } } }));
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const loaded = await loadExtensions([
    join(dirname(createRequire(import.meta.url).resolve("@gotgenes/pi-permission-system")), "index.ts"),
    resolve("node_modules/@juicesharp/rpiv-ask-user-question/index.ts"),
    resolve("extensions/index.ts"),
  ], dir, createEventBus());
  assert.deepEqual(loaded.errors, []);
  loaded.runtime.flagValues.set("ask", true);
  loaded.runtime.getAllTools = () => ["bash", "ask_user_question"].map(name => ({ name })) as any;
  loaded.runtime.getActiveTools = () => ["bash", "ask_user_question"];
  loaded.runtime.setActiveTools = () => {};
  const runner = Object.assign(Object.create(ExtensionRunner.prototype), { extensions: loaded.extensions });
  const h = host();
  const status = new Map<string, string>();
  let approve!: (value: string) => void;
  let prompted = false;
  let approvalOpened!: () => void;
  const approvalReady = new Promise<void>(resolve => { approvalOpened = resolve; });
  Object.assign(h.ctx, {
    cwd: dir,
    sessionManager: { getSessionId: () => "combined", getSessionDir: () => dir, getEntries: () => [], getSessionName: () => undefined },
  });
  Object.assign(h.ctx.ui, {
    setStatus: (key: string, value: string) => status.set(key, value),
  });
  // Both plugins share the real native custom-dialog path. Capture the inline
  // permission component so its user input can be delivered after ask timeout.
  const custom = h.ctx.ui.custom.bind(h.ctx.ui);
  h.ctx.ui.custom = ((factory, options) => custom((...args) => {
    const component = factory(...args);
    if (!options?.overlay) void Promise.resolve(component).then(component => {
      approve = value => component.handleInput?.(value === "Yes" ? "y" : "n");
      prompted = true;
      approvalOpened();
    });
    return component;
  }, options)) as typeof h.ctx.ui.custom;
  const fire = async (name: string, event: any) => {
    let result: unknown;
    for (const extension of loaded.extensions) for (const handler of extension.handlers.get(name as any) ?? []) {
      const next = await handler(event, h.ctx);
      if (next !== undefined) result = next;
    }
    return result;
  };
  let store: { current: () => unknown } | undefined;
  let effectiveCurrent: (() => unknown) | undefined;
  try {
    await fire("session_start", { reason: "start" });
    assert.equal(status.get("pi-permission-system"), "ask (temporary)");
    store = (findPermissionService("combined") as any).session.configStore;
    effectiveCurrent = store!.current;
    const permission = fire("tool_call", { toolName: "bash", toolCallId: "approval", input: { command: "pwd" } });
    await Promise.race([approvalReady, permission.then(value => { throw new Error(`Approval did not open: ${JSON.stringify(value)}`); })]);
    assert.equal(prompted, true);
    let permissionResolved = false;
    void permission.then(() => { permissionResolved = true; });
    const tool = runner.getAllRegisteredTools().find((tool: any) => tool.definition.name === "ask_user_question").definition;
    let opened!: () => void;
    const ready = new Promise<void>(resolve => { opened = resolve; });
    const show = h.tui.showOverlay;
    h.tui.showOverlay = (...args: any[]) => { const handle = show(...args); opened(); return handle; };
    const question = tool.execute("question", { questions: [{ header: "Choice", question: "Which option?", options: [
      { label: "A", description: "First" }, { label: "B", description: "Second" },
    ] }] }, undefined, undefined, h.ctx);
    await Promise.race([ready, question.then((value: unknown) => { throw new Error(`Question did not open: ${JSON.stringify(value)}`); })]);
    assert.equal((await question).details.timedOut, true);
    assert.equal(permissionResolved, false);
    assert.equal(h.stack.length, 0);
    assert.equal(status.get("pi-permission-system"), "ask (temporary)");
    approve("Yes");
    assert.deepEqual(await permission, {});
  } finally {
    approve?.("No");
    await fire("session_shutdown", { type: "session_shutdown" });
    assert.equal(ExtensionRunner.prototype.getAllRegisteredTools, originalRegistry);
    if (store) assert.notEqual(store.current, effectiveCurrent);
  }
});
