import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionRunner, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { installAskTimeout, TIMEOUT_MESSAGE, wrapAskExecute } from "../extensions/rpiv-ask-user-question/ask-timeout.ts";
import { normalizeConfig } from "../extensions/config.ts";
import { flush, host, simpleExecute } from "./ask-helpers.ts";

test("timeout config defaults off and validates positive finite millisecond bounds", () => {
  for (const value of [undefined, 0, -1, Infinity, NaN, "60000"]) assert.equal(normalizeConfig({ askUserTimeoutMs: value }).askUserTimeoutMs, 0);
  assert.equal(normalizeConfig({ askUserTimeoutMs: 1 }).askUserTimeoutMs, 1000);
  assert.equal(normalizeConfig({ askUserTimeoutMs: 60_000.4 }).askUserTimeoutMs, 60_000);
  assert.equal(normalizeConfig({ askUserTimeoutMs: 1e10 }).askUserTimeoutMs, 86_400_000);
});

test("idle timeout closes the actual Pi dialog and returns timeout rather than decline; cleans listeners", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const h = host(), pending = new Set<() => void>();
  const result = wrapAskExecute(simpleExecute, 1000, pending)("q", {}, undefined, undefined, h.ctx);
  await flush();
  assert.equal(h.stack.length, 1);
  t.mock.timers.tick(999);
  assert.equal(h.stack.length, 1);
  t.mock.timers.tick(1);
  const response = await result;
  assert.deepEqual(response.content, [{ type: "text", text: TIMEOUT_MESSAGE }]);
  assert.deepEqual(response.details, { answers: [], cancelled: true, timedOut: true, reason: "idle_timeout", timeoutMs: 1000 });
  assert.equal(h.stack.length, 0);
  assert.equal(h.listeners.size, 0);
  assert.equal(pending.size, 0);
});

test("input resets idle timeout; normal answers keep their original result", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const h = host();
  const result = wrapAskExecute(simpleExecute, 1000, new Set())("q", {}, undefined, undefined, h.ctx);
  await flush();
  t.mock.timers.tick(800);
  h.stack[0].component.handleInput("typing");
  t.mock.timers.tick(800);
  assert.equal(h.stack.length, 1);
  h.stack[0].component.handleInput("yes");
  assert.equal((await result).content[0].type, "text");
  assert.deepEqual((await result).details, { answers: ["yes"], cancelled: false });
  t.mock.timers.tick(10_000);
  assert.equal(h.stack.length, 0);
});

test("manual Escape remains a decline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const h = host();
  const result = wrapAskExecute(simpleExecute, 1000, new Set())("q", {}, undefined, undefined, h.ctx);
  await flush();
  h.stack[0].component.handleInput("esc");
  assert.deepEqual((await result).content, [{ type: "text", text: "User declined to answer questions" }]);
  assert.equal(h.listeners.size, 0);
});

test("external editor pauses timeout and restarts the interval on return", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const h = host();
  const result = wrapAskExecute(simpleExecute, 1000, new Set())("q", {}, undefined, undefined, h.ctx);
  await flush();
  h.stack[0].component.handleInput("editor");
  for (let i = 0; i < 20; i++) t.mock.timers.tick(250);
  assert.equal(h.stack.length, 1);
  h.stack[0].component.handleInput("resume");
  t.mock.timers.tick(999);
  assert.equal(h.stack.length, 1);
  t.mock.timers.tick(1);
  assert.equal(((await result).details as any)?.timedOut, true);
});

test("hidden or covered questionnaires pause; abort closes only their own overlay", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const h = host(), controller = new AbortController();
  const result = wrapAskExecute(simpleExecute, 1000, new Set())("q", {}, controller.signal, undefined, h.ctx);
  await flush();
  h.stack[0].handle.setHidden(true);
  for (let i = 0; i < 8; i++) t.mock.timers.tick(250);
  assert.equal(h.stack.length, 1);
  h.stack[0].handle.setHidden(false);
  const other = { render: () => ["Another dialog"] };
  h.tui.showOverlay(other);
  for (let i = 0; i < 8; i++) t.mock.timers.tick(250);
  assert.equal(h.stack.length, 2);
  controller.abort();
  assert.equal(((await result).details as any)?.timedOut, undefined);
  assert.equal(h.stack.length, 1);
  assert.equal(h.stack[0].component, other);
  assert.equal(h.listeners.size, 0);
});

test("RPC, non-UI and disabled timeout calls use the original context unchanged", async () => {
  const h = host();
  let seen: unknown;
  const original: ToolDefinition["execute"] = async (_id, _params, _signal, _update, ctx) => {
    seen = ctx; return { content: [], details: { ok: true } };
  };
  for (const [timeout, ctx] of [[0, h.ctx], [1000, { ...h.ctx, mode: "rpc" }], [1000, { ...h.ctx, hasUI: false }]] as const) {
    await wrapAskExecute(original, timeout, new Set())("q", {}, undefined, undefined, ctx as any);
    assert.equal(seen, ctx);
  }
});

test("registry patch restores definitions on reload and old disposal cannot remove the new owner", async () => {
  const original = ExtensionRunner.prototype.getAllRegisteredTools;
  const definition = { name: "ask_user_question", execute: simpleExecute } as ToolDefinition;
  const runner = Object.assign(Object.create(ExtensionRunner.prototype), { extensions: [{ tools: new Map([[definition.name, { definition }]]) }] });
  const first = installAskTimeout(1000);
  runner.getAllRegisteredTools();
  const oldExecute = definition.execute;
  const second = installAskTimeout(2000);
  runner.getAllRegisteredTools();
  first();
  assert.notEqual(definition.execute, simpleExecute);
  assert.notEqual(oldExecute, definition.execute);
  second();
  assert.equal(definition.execute, simpleExecute);
  assert.equal(ExtensionRunner.prototype.getAllRegisteredTools, original);
});
