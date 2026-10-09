import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createEventBus, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

test("Git-style install without node_modules loads clipboard helpers from the running Pi", async t => {
  const dir = mkdtempSync(join(tmpdir(), "pi-image-install-"));
  cpSync(resolve("extensions"), join(dir, "extensions"), { recursive: true });
  const entrypoint = join(dir, "extensions", "index.ts");
  assert.throws(() => createRequire(entrypoint).resolve("@earendil-works/pi-coding-agent"), { code: "MODULE_NOT_FOUND" });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const loaded = await loadExtensions([entrypoint], dir, createEventBus());
  assert.deepEqual(loaded.errors, []);
  loaded.runtime.getAllTools = () => []; // Simulate Pi's binding before session_start; no bg plugin is loaded.
  const prototype = InteractiveMode.prototype as any;
  const original = prototype.handleClipboardPaste;
  const notifications: string[] = [];
  const ctx = {
    mode: "tui", hasUI: true, cwd: dir,
    sessionManager: { getSessionId: () => "git-install", getEntries: () => [] },
    ui: { notify: (message: string) => notifications.push(message) },
  };
  const fire = async (name: "session_start" | "session_shutdown") => {
    for (const extension of loaded.extensions) {
      for (const handler of extension.handlers.get(name) ?? []) await handler({ type: name } as any, ctx as any);
    }
  };
  try {
    await fire("session_start");
    assert.deepEqual(notifications, []);
    assert.notEqual(prototype.handleClipboardPaste, original);
  } finally {
    await fire("session_shutdown");
    assert.equal(prototype.handleClipboardPaste, original);
  }
});
