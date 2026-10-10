import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { applyInteractiveShellAbortPatch, INTERACTIVE_SHELL_ABORT_PATCH, registerInteractiveShellPatches } from "../extensions/pi-interactive-shell/index.ts";

const exec = promisify(execFile);
const upstream = process.env.PI_INTERACTIVE_SHELL_TEST_DIR ?? join(getAgentDir(), "npm/node_modules/pi-interactive-shell");
const available = existsSync(join(upstream, "package.json")) && JSON.parse(readFileSync(join(upstream, "package.json"), "utf8")).version === "0.17.0";
const integration = { skip: available ? false : "Requires installed pi-interactive-shell 0.17.0" };
const files = ["index.ts", "overlay-component.ts", "headless-monitor.ts", "session-manager.ts"];

function copyOriginal(target: string): void {
  mkdirSync(target, { recursive: true });
  for (const file of [...files, "package.json"]) copyFileSync(join(upstream, file), join(target, file));
  try { execFileSync("git", ["apply", "--reverse", "--check", INTERACTIVE_SHELL_ABORT_PATCH], { cwd: target, stdio: "ignore" }); }
  catch { return; }
  execFileSync("git", ["apply", "--reverse", INTERACTIVE_SHELL_ABORT_PATCH], { cwd: target });
}
const snapshot = (target: string) => files.map(file => readFileSync(join(target, file), "utf8"));

test("cancellation autopatch skips unsupported/missing installations", async t => {
  const dir = mkdtempSync(join(tmpdir(), "pi-shell-abort-version-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal((await applyInteractiveShellAbortPatch(join(dir, "absent"))).status, "absent");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pi-interactive-shell", version: "0.18.0" }));
  assert.equal((await applyInteractiveShellAbortPatch(dir)).status, "skipped");
});

test("cancellation patch is atomic, reversible, idempotent and respects locks/source mismatch", integration, async t => {
  const dir = mkdtempSync(join(tmpdir(), "pi-shell-abort-apply-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  copyOriginal(dir); const before = snapshot(dir);
  const lock = join(dir, ".pi-enhance-abort.lock"); mkdirSync(lock);
  assert.equal((await applyInteractiveShellAbortPatch(dir)).status, "skipped");
  assert.deepEqual(snapshot(dir), before); assert.equal(existsSync(lock), true); rmdirSync(lock);
  writeFileSync(join(dir, "index.ts"), before[0].replace("async execute(_toolCallId, params, _signal, onUpdate, ctx)", "async execute(callId, params, _signal, onUpdate, ctx)"));
  const changed = snapshot(dir);
  assert.equal((await applyInteractiveShellAbortPatch(dir)).status, "skipped");
  assert.deepEqual(snapshot(dir), changed); assert.equal(existsSync(lock), false);
  writeFileSync(join(dir, "index.ts"), before[0]);
  assert.equal((await applyInteractiveShellAbortPatch(dir)).status, "applied");
  assert.equal((await applyInteractiveShellAbortPatch(dir)).status, "already_applied");
  execFileSync("git", ["apply", "--reverse", INTERACTIVE_SHELL_ABORT_PATCH], { cwd: dir });
  assert.deepEqual(snapshot(dir), before);
});

test("startup requires loaded shell, honors environment off, and notifies once after apply", integration, async t => {
  const dir = mkdtempSync(join(tmpdir(), "pi-shell-abort-startup-"));
  const priorAgent = process.env.PI_CODING_AGENT_DIR;
  const priorOff = process.env.PI_ENHANCE_INTERACTIVE_SHELL_AUTOPATCH;
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_ENHANCE_INTERACTIVE_SHELL_AUTOPATCH;
  t.after(() => {
    if (priorAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgent;
    if (priorOff === undefined) delete process.env.PI_ENHANCE_INTERACTIVE_SHELL_AUTOPATCH; else process.env.PI_ENHANCE_INTERACTIVE_SHELL_AUTOPATCH = priorOff;
    rmSync(dir, { recursive: true, force: true });
  });
  const target = join(dir, "npm/node_modules/pi-interactive-shell"); copyOriginal(target);
  const original = snapshot(target); let loaded = false; let start: any;
  const notices: string[] = [];
  registerInteractiveShellPatches({ on(_event: string, handler: any) { start = handler; }, getAllTools: () => loaded ? [{ name: "interactive_shell" }] : [] } as any);
  const ctx = { hasUI: true, ui: { notify(message: string) { notices.push(message); } } };
  await start({}, ctx); assert.deepEqual(snapshot(target), original);
  loaded = true; process.env.PI_ENHANCE_INTERACTIVE_SHELL_AUTOPATCH = "0";
  await start({}, ctx); assert.deepEqual(snapshot(target), original);
  delete process.env.PI_ENHANCE_INTERACTIVE_SHELL_AUTOPATCH;
  await start({}, ctx); await start({}, ctx);
  assert.equal(notices.length, 1); assert.match(notices[0], /reload or restart/);
});

test("actual shell tool + native editor Esc: baseline stalls, patch cancels queries/PTYS and releases waits", integration, async () => {
  const cwd = resolve(".");
  const before = await exec(process.execPath, ["poc/interactive-shell-abort.mjs", "--baseline"], { cwd, timeout: 20000 });
  assert.match(before.stdout, /BASELINE REPRODUCED/);
  const after = await exec(process.execPath, ["poc/interactive-shell-abort.mjs"], { cwd, timeout: 20000, maxBuffer: 1024 * 1024 });
  assert.match(after.stdout, /All cancellation PoC assertions passed/);
  assert.match(after.stdout, /process preserved/);
  assert.match(after.stdout, /PATCHED main/);
  assert.match(after.stdout, /PATCHED fullscreen/);
  assert.match(after.stdout, /non-blocking attach survives/);
});
