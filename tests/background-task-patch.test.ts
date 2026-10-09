import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { createEventBus, getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

const upstream = process.env.PI_BACKGROUND_TASKS_TEST_DIR ?? join(getAgentDir(), "npm/node_modules/pi-background-tasks");
const manifest = join(upstream, "package.json");
const available = existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).version === "2.6.9";

test("manual cache patch applies/reverses on 2.6.9 and preserves real background task cwd/logs", {
  skip: available ? false : "Requires pi-background-tasks 2.6.9; set PI_BACKGROUND_TASKS_TEST_DIR to its package root",
}, async t => {
  const dir = mkdtempSync(join(tmpdir(), "pi-background-patch-"));
  // Terminal publication precedes the final metadata write; clean only after pending I/O drains.
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "plugin");
  cpSync(upstream, target, { recursive: true });
  const patch = resolve("patches/pi-background-tasks-2.6.9-global-cache.patch");
  const files = ["src/core/registry.ts", "dist/src/core/registry.js", "src/extension.ts", "dist/src/extension.js"];
  const originals = files.map(file => readFileSync(join(target, file), "utf8"));
  const apply = (...args: string[]) => execFileSync("git", ["apply", ...args, patch], { cwd: target, stdio: "pipe" });
  const names = ["PI_CODING_AGENT_DIR", "PI_BG_FEATURES", "PI_BG_DISABLE_UPDATE_CHECK"] as const;
  const previous = names.map(name => process.env[name]);
  const agentDir = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_BG_FEATURES = "process";
  process.env.PI_BG_DISABLE_UPDATE_CHECK = "1";
  t.after(() => {
    names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
  });
  apply("--check");
  apply();
  assert.throws(() => apply("--check")); // Never silently apply twice.
  apply("--reverse", "--check");
  const projectDirs: string[] = [];
  for (const project of ["project one", "project two"]) {
    const cwd = join(dir, project);
    mkdirSync(cwd);
    const events = createEventBus();
    const loaded = await loadExtensions([join(target, "dist/extensions/background-tasks.js")], cwd, events);
    assert.deepEqual(loaded.errors, []);
    const ctx: any = {
      mode: "print", hasUI: false, cwd, ui: {},
      sessionManager: { getSessionId: () => "patch-test" }, modelRegistry: { getAll: () => [] },
    };
    const fire = async (name: "session_start" | "session_shutdown") => {
      for (const extension of loaded.extensions) for (const handler of extension.handlers.get(name) ?? []) {
        await handler({ type: name, reason: name === "session_start" ? "startup" : "quit" } as any, ctx);
      }
    };
    let terminal!: (value: any) => void;
    const finished = new Promise<any>(resolve => { terminal = resolve; });
    const unsubscribe = events.on("pi-background-tasks:terminal:v1", terminal);
    try {
      await fire("session_start");
      const tools = [...loaded.extensions.flatMap(extension => [...extension.tools.values()])];
      const run = tools.find(tool => tool.definition.name === "bg_run")!.definition;
      assert.match(run.description, /cache\/background-tasks/);
      const started: any = await run.execute("run", {
        name: "Cache cwd check", command: `"${process.execPath}" -e "process.stdout.write(process.cwd())"`,
        isAgent: false, notifyOnCompletion: false, triggerOnCompletion: false,
      }, undefined, undefined, ctx);
      const result = await finished;
      assert.equal(result.task.id, started.details.task.id);
      assert.equal(result.task.status, "completed");
      const projectId = createHash("sha256").update(realpathSync(cwd)).digest("hex");
      const expected = join(agentDir, "cache", "background-tasks", projectId, `patch-test-${process.pid}`);
      assert.equal(dirname(result.task.outputPath), expected);
      assert.equal(readFileSync(result.task.outputPath, "utf8"), realpathSync(cwd));
      const metadata = JSON.parse(readFileSync(join(expected, `${result.task.id}.json`), "utf8"));
      assert.equal(metadata.cwd, cwd);
      assert.equal(metadata.status, "completed");
      const logs: any = await tools.find(tool => tool.definition.name === "bg_logs")!.definition
        .execute("logs", { taskId: result.task.id }, undefined, undefined, ctx);
      assert.ok(logs.content.some((block: any) => block.text?.includes(realpathSync(cwd))));
      assert.equal(existsSync(join(cwd, ".pi")), false);
      if (process.platform !== "win32") assert.equal(statSync(expected).mode & 0o777, 0o700);
      projectDirs.push(dirname(expected));
    } finally {
      unsubscribe();
      await fire("session_shutdown");
    }
  }
  assert.notEqual(projectDirs[0], projectDirs[1]);
  apply("--reverse");
  files.forEach((file, i) => assert.equal(readFileSync(join(target, file), "utf8"), originals[i]));
});
