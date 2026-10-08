import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { ExtensionRunner, createEventBus } from "@earendil-works/pi-coding-agent";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { host } from "./ask-helpers.ts";
import { TIMEOUT_MESSAGE } from "../extensions/rpiv-ask-user-question/ask-timeout.ts";

test("real rpiv questionnaire times out in either load order, keeps BEL and clears blocked/input state", async t => {
  const dir = mkdtempSync(join(tmpdir(), "pi-ask-timeout-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  writeFileSync(join(dir, "pi-enhance-patches-asks.json"), JSON.stringify({ askUserTimeoutMs: 1000 }));
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  t.after(() => {
    if (tty) Object.defineProperty(process.stdout, "isTTY", tty); else delete (process.stdout as any).isTTY;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  let bells = 0;
  const write = process.stdout.write;
  t.mock.method(process.stdout, "write", function (this: typeof process.stdout, ...args: any[]) {
    if (args[0] === "\x07") { bells++; return true; }
    return (write as any).apply(this, args);
  });
  const rpiv = resolve("node_modules/@juicesharp/rpiv-ask-user-question/index.ts");
  const patch = resolve("extensions/index.ts");
  for (const paths of [[rpiv, patch], [patch, rpiv]]) {
    const blocked: boolean[] = [];
    const events = createEventBus();
    events.on("rpiv:ask-user:blocked", (event: any) => blocked.push(event.active));
    const loaded = await loadExtensions(paths, process.cwd(), events);
    assert.deepEqual(loaded.errors, []);
    const runner = Object.assign(Object.create(ExtensionRunner.prototype), { extensions: loaded.extensions });
    const tool = runner.getAllRegisteredTools().find((tool: any) => tool.definition.name === "ask_user_question").definition;
    const h = host();
    const show = h.tui.showOverlay;
    let ready!: () => void;
    const opened = new Promise<void>(resolve => { ready = resolve; });
    h.tui.showOverlay = (...args: any[]) => { const handle = show(...args); ready(); return handle; };
    const bellBefore = bells;
    const response = tool.execute("q", { questions: [{
      header: "Choice", question: "Which option?",
      options: [{ label: "A", description: "First" }, { label: "B", description: "Second" }],
    }] }, undefined, undefined, h.ctx);
    try {
      await Promise.race([opened, response.then((value: any) => { throw new Error(`No questionnaire opened: ${JSON.stringify(value)}`); })]);
      assert.equal(bells, bellBefore + 1);
      assert.equal(h.stack.length, 1);
      assert.ok(h.stack[0].component.render(100).join("\n").includes("Which option?"));
      const result = await response;
      assert.deepEqual(result.content, [{ type: "text", text: TIMEOUT_MESSAGE }]);
      assert.equal(result.details.timedOut, true);
      assert.equal(result.details.timeoutMs, 1000);
      assert.deepEqual(blocked, [true, false]);
      assert.equal(h.stack.length, 0);
      assert.equal(h.listeners.size, 0);
    } finally {
      for (const extension of loaded.extensions) {
        for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, h.ctx);
      }
    }
  }
});
