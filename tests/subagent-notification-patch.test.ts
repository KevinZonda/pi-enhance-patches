import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createJiti } from "jiti";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { AgentSession } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js";

const upstream = process.env.PI_SUBAGENTS_TEST_DIR ?? join(getAgentDir(), "npm/node_modules/@gotgenes/pi-subagents");
const manifest = join(upstream, "package.json");
const available = existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).version === "23.4.0";

test("23.4.0 notification patch preserves wakeups and rejects stale runs/consumed outcomes", {
  skip: available ? false : "Requires @gotgenes/pi-subagents 23.4.0; set PI_SUBAGENTS_TEST_DIR",
}, async t => {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagent-patch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "plugin");
  cpSync(upstream, target, { recursive: true });
  const patch = resolve("patches/gotgenes-pi-subagents-23.4.0-stale-notifications.patch");
  const files = ["src/index.ts", "src/observation/notification.ts"];
  const originals = files.map(file => readFileSync(join(target, file), "utf8"));
  const apply = (...args: string[]) => execFileSync("git", ["apply", ...args, patch], { cwd: target, stdio: "pipe" });
  apply("--check");
  apply();
  assert.throws(() => apply("--check"));
  apply("--reverse", "--check");
  const jiti = createJiti(import.meta.url);
  const { NotificationManager }: any = await jiti.import(join(target, files[1]));
  const { SubagentState }: any = await jiti.import(join(target, "src/lifecycle/subagent-state.ts"));
  function child(id: string) {
    const state = new SubagentState({ status: "running" });
    let controller = new AbortController();
    return new Proxy(state, { get(target, key) {
      if (key === "id") return id;
      if (key === "description") return id;
      if (key === "abortController") return controller;
      if (key === "getContextPercent") return () => 0;
      if (key === "resumeForTest") return () => { controller = new AbortController(); target.resetForResume(Date.now()); };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    }});
  }
  const managers: any[] = [];
  const make = (send: any, idle = () => true) => {
    const manager = new NotificationManager(send, idle);
    managers.push(manager);
    return manager;
  };
  t.after(() => managers.forEach(manager => manager.dispose()));

  await t.test("finished and collected before flush sends nothing", async () => {
    const sent: any[] = [];
    const manager = make((m: any) => sent.push(m));
    const record = child("collected");
    manager.onParentAgentStart();
    manager.sendUpdate(record, "old update");
    record.markCompleted("done");
    manager.sendCompletion(record);
    record.markConsumed();
    manager.onParentAgentSettled();
    await delay(80);
    assert.equal(sent.length, 0);
  });
  await t.test("resume cannot resurrect old progress or completion; new result still wakes", async () => {
    const sent: any[] = [];
    const manager = make((m: any, options: any) => sent.push({ m, options }));
    const record = child("resumed");
    manager.onParentAgentStart();
    manager.sendUpdate(record, "old update");
    record.markCompleted("old result");
    manager.sendCompletion(record);
    record.markConsumed();
    record.resumeForTest();
    manager.onParentAgentSettled();
    await delay(80);
    assert.equal(sent.length, 0);
    record.markCompleted("new result");
    manager.sendCompletion(record);
    await delay(80);
    assert.equal(sent.length, 1);
    assert.match(sent[0].m.content, /new result/);
    assert.equal(sent[0].options.triggerTurn, true);
  });
  await t.test("live progress, uncollected completion, claim, and workspace notice retain behavior", async () => {
    const sent: any[] = [];
    const manager = make((m: any, options: any) => sent.push({ m, options }));
    const record = child("live");
    record.recordUpdate("current update");
    manager.sendUpdate(record, "current update");
    await delay(80);
    assert.equal(sent[0].m.customType, "subagent-update");
    assert.equal(sent[0].options.triggerTurn, true);
    assert.deepEqual(record.runUpdates, []);
    manager.onParentAgentStart();
    record.recordUpdate("owed update");
    manager.sendUpdate(record, "owed update");
    record.markCompleted("done");
    manager.sendCompletion(record);
    manager.onParentAgentSettled();
    await delay(80);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].m.customType, "subagent-notification");
    assert.match(sent[1].m.content, /owed update/);
    assert.doesNotMatch(sent[1].m.content, /current update/);
    const held = child("claimed");
    manager.onParentAgentStart();
    held.markCompleted("held");
    manager.sendCompletion(held);
    const claim = held.claim();
    manager.onParentAgentSettled();
    await delay(80);
    assert.equal(sent.length, 2);
    claim.release();
    manager.sendWorkspaceNotice(record, "artifact retained");
    assert.equal(sent[2].m.customType, "subagent-workspace-notice");
    assert.equal(sent[2].options.triggerTurn, false);
  });
  await t.test("real Pi settled dispatch does not receive a batch of unrecallable prompts", async () => {
    const session: any = Object.create(AgentSession.prototype);
    session._isAgentRunActive = true;
    session._isEmittingAgentSettled = false;
    session._deferredSettledActions = [];
    session._emit = () => {};
    session._resolveIdleWaitIfIdle = () => {};
    const records = [child("A"), child("B"), child("C")];
    const runs: string[] = [];
    const manager = make((m: any, options: any) => { void session.sendCustomMessage(m, options); }, () => !session.isStreaming);
    session._runAgentPrompt = async (m: any) => {
      session._isAgentRunActive = true;
      manager.onParentAgentStart();
      runs.push(m.customType);
      // Stand in for a parent that collects all results on its first wakeup.
      records.forEach(record => { record.markCompleted("done"); record.markConsumed(); });
      await delay(10);
      await session._emitAgentSettled();
    };
    session._extensionRunner = { emit: async () => manager.onParentAgentSettled() };
    manager.onParentAgentStart();
    records.forEach(record => manager.sendUpdate(record, "old progress"));
    await session._emitAgentSettled();
    assert.equal(session._deferredSettledActions.length, 0);
    await delay(120);
    assert.deepEqual(runs, ["subagent-update"]);
  });
  await t.test("busy parent delays delivery; shutdown/reload cancels pending timers", async () => {
    const sent: any[] = [];
    let idle = false;
    const manager = make((m: any) => sent.push(m), () => idle);
    const record = child("busy");
    record.markCompleted("done");
    manager.sendCompletion(record);
    await delay(80);
    assert.equal(sent.length, 0);
    idle = true;
    await delay(80);
    assert.equal(sent.length, 1);
    manager.sendUpdate(child("shutdown"), "must not arrive");
    manager.dispose();
    await delay(80);
    assert.equal(sent.length, 1);
  });
  apply("--reverse");
  files.forEach((file, i) => assert.equal(readFileSync(join(target, file), "utf8"), originals[i]));
});
