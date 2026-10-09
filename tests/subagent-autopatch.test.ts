import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createEventBus, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { applySubagentNotificationPatch, registerSubagentPatches, SUBAGENT_NOTIFICATION_PATCH } from "../extensions/gotgenes-pi-subagents/index.ts";

const upstream = process.env.PI_SUBAGENTS_TEST_DIR ?? join(getAgentDir(), "npm/node_modules/@gotgenes/pi-subagents");
const manifest = join(upstream, "package.json");
const available = existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).version === "23.4.0";
const integration = { skip: available ? false : "Requires original @gotgenes/pi-subagents 23.4.0" };
const files = ["src/index.ts", "src/observation/notification.ts"];
const snapshot = (dir: string) => files.map(file => readFileSync(join(dir, file), "utf8"));
const serviceKey = Symbol.for("@gotgenes/pi-subagents:service");
const globals = globalThis as Record<symbol, unknown>;
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagent-autopatch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function restoreEnv(t: test.TestContext, name: string, value: string | undefined) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
}
function restoreService(t: test.TestContext) {
  const previous = globals[serviceKey];
  delete globals[serviceKey];
  t.after(() => { if (previous === undefined) delete globals[serviceKey]; else globals[serviceKey] = previous; });
}

test("subagent autopatcher rejects missing, malformed, wrong-name and unreviewed manifests", async t => {
  const dir = fixture(t);
  assert.equal((await applySubagentNotificationPatch(dir)).status, "absent");
  writeFileSync(join(dir, "package.json"), "broken");
  assert.equal((await applySubagentNotificationPatch(dir)).status, "skipped");
  for (const value of [null, { name: "pi-subagents", version: "23.4.0" }, { name: "@gotgenes/pi-subagents", version: "23.5.0" }]) {
    writeFileSync(join(dir, "package.json"), JSON.stringify(value));
    assert.equal((await applySubagentNotificationPatch(dir)).status, "skipped");
  }
  assert.equal(existsSync(join(dir, ".pi-enhance-subagent-notifications.lock")), false);
});

test("subagent autopatcher is idempotent, locked, reversible and fails safely", integration, async t => {
  const target = join(fixture(t), "plugin");
  cpSync(upstream, target, { recursive: true });
  const original = snapshot(target);
  assert.equal((await applySubagentNotificationPatch(target)).status, "applied");
  const patched = snapshot(target);
  assert.equal((await applySubagentNotificationPatch(target)).status, "already_applied");
  assert.deepEqual(snapshot(target), patched);
  const reverse = () => execFileSync("git", ["apply", "--reverse", SUBAGENT_NOTIFICATION_PATCH], { cwd: target });
  reverse();
  assert.deepEqual(snapshot(target), original);
  const concurrent = await Promise.all([applySubagentNotificationPatch(target), applySubagentNotificationPatch(target)]);
  assert.equal(concurrent.filter(result => result.status === "applied").length, 1);
  assert.deepEqual(snapshot(target), patched);
  reverse();
  const lock = join(target, ".pi-enhance-subagent-notifications.lock");
  mkdirSync(lock);
  assert.equal((await applySubagentNotificationPatch(target)).status, "skipped");
  assert.equal(existsSync(lock), true);
  assert.deepEqual(snapshot(target), original);
  rmdirSync(lock);
  const changed = join(target, files[1]);
  writeFileSync(changed, original[1].replace('    this.emitUpdate(record, message);', '    throw new Error("custom source");'));
  const mismatched = snapshot(target);
  assert.notDeepEqual(mismatched, original);
  assert.equal((await applySubagentNotificationPatch(target)).status, "skipped");
  assert.deepEqual(snapshot(target), mismatched);
  assert.equal(existsSync(lock), false);
  writeFileSync(changed, original[1]);
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const mode = statSync(changed).mode & 0o777;
    chmodSync(changed, 0o400);
    try {
      assert.equal((await applySubagentNotificationPatch(target)).status, "skipped");
      assert.deepEqual(snapshot(target), original);
    } finally { chmodSync(changed, mode); }
  }
  restoreEnv(t, "PATH", "");
  assert.equal((await applySubagentNotificationPatch(target)).status, "skipped");
  assert.deepEqual(snapshot(target), original);
});

test("subagent startup requires explicit enable, target service and tool, honors environment and notifies once", integration, async t => {
  const dir = fixture(t);
  const target = join(dir, "npm/node_modules/@gotgenes/pi-subagents");
  cpSync(upstream, target, { recursive: true });
  const original = snapshot(target);
  restoreEnv(t, "PI_CODING_AGENT_DIR", dir);
  restoreEnv(t, "PI_ENHANCE_SUBAGENT_AUTOPATCH", undefined);
  restoreService(t);
  const disabled = { on() { assert.fail("disabled installed hooks"); } } as unknown as ExtensionAPI;
  registerSubagentPatches(disabled);
  registerSubagentPatches(disabled, false);
  let handler!: (event: any, ctx: any) => Promise<void>;
  let toolLoaded = false;
  registerSubagentPatches({
    on(_name: string, fn: typeof handler) { handler = fn; },
    getAllTools: () => toolLoaded ? [{ name: "subagent" }] : [],
  } as unknown as ExtensionAPI, true);
  const messages: string[] = [];
  const ctx = { hasUI: true, ui: { notify: (m: string) => messages.push(m) } };
  await handler({}, ctx);
  toolLoaded = true;
  await handler({}, ctx); // Other subagent packages must not count as the target being loaded.
  assert.deepEqual(snapshot(target), original);
  globals[serviceKey] = {};
  toolLoaded = false;
  await handler({}, ctx);
  assert.deepEqual(snapshot(target), original);
  toolLoaded = true;
  process.env.PI_ENHANCE_SUBAGENT_AUTOPATCH = "0";
  await handler({}, ctx);
  assert.deepEqual(snapshot(target), original);
  delete process.env.PI_ENHANCE_SUBAGENT_AUTOPATCH;
  await handler({}, ctx);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /reload or restart/);
  await handler({}, ctx);
  assert.equal(messages.length, 1);
});

test("real enhancement loading in either order honors unified opt-in and applies once", integration, async t => {
  const dir = fixture(t);
  restoreEnv(t, "PI_CODING_AGENT_DIR", dir);
  restoreEnv(t, "PI_ENHANCE_SUBAGENT_AUTOPATCH", undefined);
  restoreService(t);
  const messages: string[] = [];
  t.mock.method(console, "error", (message: string) => messages.push(String(message)));
  const stub = join(dir, "target-service.ts");
  writeFileSync(stub, `export default function(pi) {
    const key = Symbol.for("@gotgenes/pi-subagents:service");
    globalThis[key] = {};
    pi.registerTool({ name: "subagent", label: "Subagent", description: "fixture",
      parameters: {type: "object", properties: {}}, execute: async () => ({content: [], details: {}}) });
    pi.on("session_shutdown", () => { delete globalThis[key]; });
  }`);
  for (const patchFirst of [true, false]) {
    const agent = join(dir, patchFirst ? "first" : "last");
    const target = join(agent, "npm/node_modules/@gotgenes/pi-subagents");
    cpSync(upstream, target, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agent;
    writeFileSync(join(agent, "pi-enhance-patches.json"), JSON.stringify({ subagentNotificationAutopatchEnabled: true }));
    for (let startup = 1; startup <= 2; startup++) {
      const paths = [resolve("extensions/index.ts"), stub];
      if (!patchFirst) paths.reverse();
      const loaded = await loadExtensions(paths, agent, createEventBus());
      assert.deepEqual(loaded.errors, []);
      loaded.runtime.getAllTools = () => loaded.extensions.flatMap(extension => [...extension.tools.keys()].map(name => ({ name }))) as any;
      const ctx: any = { mode: "print", hasUI: false, cwd: agent, ui: {} };
      for (const name of ["session_start", "session_shutdown"] as const) {
        for (const extension of loaded.extensions) for (const callback of extension.handlers.get(name) ?? []) {
          await callback({ type: name, reason: name === "session_start" ? "startup" : "quit" } as any, ctx);
        }
      }
      execFileSync("git", ["apply", "--reverse", "--check", SUBAGENT_NOTIFICATION_PATCH], { cwd: target });
      assert.equal(messages.length, (patchFirst ? 0 : 1) + 1);
    }
  }
  assert.equal(messages.length, 2);
  assert.ok(messages.every(message => message.includes("notification patch applied")));
});
