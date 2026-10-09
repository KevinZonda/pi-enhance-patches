import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createEventBus, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { applyBackgroundCachePatch, BACKGROUND_CACHE_PATCH, registerBackgroundTaskPatches } from "../extensions/pi-background-tasks/index.ts";

const upstream = process.env.PI_BACKGROUND_TASKS_TEST_DIR ?? join(getAgentDir(), "npm/node_modules/pi-background-tasks");
const manifestPath = join(upstream, "package.json");
const available = existsSync(manifestPath) && JSON.parse(readFileSync(manifestPath, "utf8")).version === "2.6.9";
const integration = { skip: available ? false : "Requires an original pi-background-tasks 2.6.9 installation" };
const files = ["src/core/registry.ts", "dist/src/core/registry.js", "src/extension.ts", "dist/src/extension.js"];
const snapshot = (target: string) => files.map(file => readFileSync(join(target, file), "utf8"));

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pi-autopatch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("autopatcher skips missing, malformed and unreviewed package manifests", async t => {
  const dir = fixture(t);
  assert.equal((await applyBackgroundCachePatch(dir)).status, "absent");
  writeFileSync(join(dir, "package.json"), "not json");
  assert.equal((await applyBackgroundCachePatch(dir)).status, "skipped");
  for (const manifest of [{ name: "pi-background-tasks", version: "2.7.0" }, { name: "other", version: "2.6.9" }, null]) {
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    assert.equal((await applyBackgroundCachePatch(dir)).status, "skipped");
  }
  assert.equal(existsSync(join(dir, ".pi-enhance-global-cache.lock")), false);
});

test("autopatcher applies once, respects locks, preserves mismatched files and tolerates missing Git", integration, async t => {
  const target = join(fixture(t), "plugin");
  cpSync(upstream, target, { recursive: true });
  const original = snapshot(target);
  assert.equal((await applyBackgroundCachePatch(target)).status, "applied");
  const patched = snapshot(target);
  assert.equal((await applyBackgroundCachePatch(target)).status, "already_applied");
  assert.deepEqual(snapshot(target), patched);
  execFileSync("git", ["apply", "--reverse", BACKGROUND_CACHE_PATCH], { cwd: target });
  assert.deepEqual(snapshot(target), original);
  const concurrent = await Promise.all([applyBackgroundCachePatch(target), applyBackgroundCachePatch(target)]);
  assert.equal(concurrent.filter(result => result.status === "applied").length, 1);
  assert.deepEqual(snapshot(target), patched);
  execFileSync("git", ["apply", "--reverse", BACKGROUND_CACHE_PATCH], { cwd: target });
  const lock = join(target, ".pi-enhance-global-cache.lock");
  mkdirSync(lock);
  assert.equal((await applyBackgroundCachePatch(target)).status, "skipped");
  assert.deepEqual(snapshot(target), original);
  assert.equal(existsSync(lock), true); // Never release another process's lock.
  rmdirSync(lock);
  const changed = join(target, files[1]);
  writeFileSync(changed, original[1].replace("join(ctx.cwd, '.pi', 'tasks', runId)", "join(ctx.cwd, '.pi', 'custom', runId)"));
  const mismatched = snapshot(target);
  assert.equal((await applyBackgroundCachePatch(target)).status, "skipped");
  assert.deepEqual(snapshot(target), mismatched);
  assert.equal(existsSync(lock), false);
  writeFileSync(changed, original[1]);
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const mode = statSync(changed).mode & 0o777;
    chmodSync(changed, 0o400);
    try {
      assert.equal((await applyBackgroundCachePatch(target)).status, "skipped");
      assert.deepEqual(snapshot(target), original);
    } finally { chmodSync(changed, mode); }
  }
  const path = process.env.PATH;
  process.env.PATH = "";
  try {
    assert.equal((await applyBackgroundCachePatch(target)).status, "skipped");
    assert.deepEqual(snapshot(target), original);
  } finally {
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
  }
});

test("startup does not patch an installed but unloaded background plugin; success notifies once", integration, async t => {
  const dir = fixture(t);
  const target = join(dir, "npm/node_modules/pi-background-tasks");
  cpSync(upstream, target, { recursive: true });
  const original = snapshot(target);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  let handler!: (event: any, ctx: any) => Promise<void>;
  let loaded = false;
  const messages: string[] = [];
  registerBackgroundTaskPatches({
    on(_name: string, callback: typeof handler) { handler = callback; },
    getAllTools: () => loaded ? [{ name: "bg_run" }] : [],
  } as any as ExtensionAPI);
  const ctx = { hasUI: true, ui: { notify: (message: string) => messages.push(message) } };
  await handler({}, ctx);
  assert.deepEqual(snapshot(target), original);
  loaded = true;
  const disabled = process.env.PI_ENHANCE_BACKGROUND_AUTOPATCH;
  process.env.PI_ENHANCE_BACKGROUND_AUTOPATCH = "0";
  try { await handler({}, ctx); assert.deepEqual(snapshot(target), original); }
  finally { if (disabled === undefined) delete process.env.PI_ENHANCE_BACKGROUND_AUTOPATCH; else process.env.PI_ENHANCE_BACKGROUND_AUTOPATCH = disabled; }
  await handler({}, ctx);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /reload or restart/);
  await handler({}, ctx);
  assert.equal(messages.length, 1);
});

test("real extension loader in either order applies on first startup and loads global cache on next startup", integration, async t => {
  const dir = fixture(t);
  const names = ["PI_CODING_AGENT_DIR", "PI_BG_FEATURES", "PI_BG_DISABLE_UPDATE_CHECK"] as const;
  const previous = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }));
  process.env.PI_BG_FEATURES = "process";
  process.env.PI_BG_DISABLE_UPDATE_CHECK = "1";
  const messages: string[] = [];
  t.mock.method(console, "error", (message: string) => { messages.push(String(message)); });
  for (const patchFirst of [true, false]) {
    const agent = join(dir, patchFirst ? "first" : "last");
    const target = join(agent, "npm/node_modules/pi-background-tasks");
    cpSync(upstream, target, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agent;
    const cwd = join(agent, "project");
    mkdirSync(cwd);
    for (const startup of [1, 2]) {
      const paths = [resolve("extensions/index.ts"), join(target, "dist/extensions/background-tasks.js")];
      if (!patchFirst) paths.reverse();
      const loaded = await loadExtensions(paths, cwd, createEventBus());
      assert.deepEqual(loaded.errors, []);
      loaded.runtime.getAllTools = () => loaded.extensions.flatMap(extension => [...extension.tools.keys()].map(name => ({ name }))) as any;
      const ctx: any = { mode: "print", hasUI: false, cwd, ui: {}, sessionManager: { getSessionId: () => "autopatch" }, modelRegistry: { getAll: () => [] } };
      const fire = async (name: "session_start" | "session_shutdown") => {
        for (const extension of loaded.extensions) for (const callback of extension.handlers.get(name) ?? []) {
          await callback({ type: name, reason: name === "session_start" ? "startup" : "quit" } as any, ctx);
        }
      };
      try {
        await fire("session_start");
        assert.equal(existsSync(join(cwd, ".pi/tasks")), true); // First activation is already loaded; preserve its old directory.
        assert.equal(existsSync(join(agent, "cache/background-tasks")), startup === 2);
      } finally { await fire("session_shutdown"); }
    }
  }
  assert.equal(messages.length, 2);
  assert.ok(messages.every(message => message.includes("cache patch applied")));
});
