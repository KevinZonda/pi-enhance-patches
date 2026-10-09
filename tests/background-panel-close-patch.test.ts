import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { applyBackgroundPanelClosePatch, BACKGROUND_PANEL_CLOSE_PATCH } from "../extensions/pi-background-tasks/index.ts";

import { copyOriginalBackgroundPackage } from "./background-task-fixture.ts";

const upstream = process.env.PI_BACKGROUND_TASKS_TEST_DIR ?? join(getAgentDir(), "npm/node_modules/pi-background-tasks");
const manifest = join(upstream, "package.json");
const available = existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).version === "2.6.9";
const integration = { skip: available ? false : "Requires pi-background-tasks 2.6.9; set PI_BACKGROUND_TASKS_TEST_DIR" };
const files = ["src/ui/background-tasks-manager.ts", "dist/src/ui/background-tasks-manager.js"];
const snapshot = (target: string) => files.map(file => readFileSync(join(target, file), "utf8"));
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pi-panel-close-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("panel autopatcher rejects absent, malformed and unreviewed packages", async t => {
  const target = fixture(t);
  assert.equal((await applyBackgroundPanelClosePatch(target)).status, "absent");
  for (const value of ["invalid", "null", JSON.stringify({ name: "other", version: "2.6.9" }),
    JSON.stringify({ name: "pi-background-tasks", version: "2.7.0" })]) {
    writeFileSync(join(target, "package.json"), value);
    assert.equal((await applyBackgroundPanelClosePatch(target)).status, "skipped");
  }
  assert.equal(existsSync(join(target, ".pi-enhance-panel-close.lock")), false);
});

test("panel patch is atomic, reversible, idempotent and respects concurrent locks", integration, async t => {
  const target = join(fixture(t), "plugin");
  copyOriginalBackgroundPackage(upstream, target);
  const original = snapshot(target);
  assert.equal((await applyBackgroundPanelClosePatch(target)).status, "applied");
  const patched = snapshot(target);
  assert.equal((await applyBackgroundPanelClosePatch(target)).status, "already_applied");
  assert.deepEqual(snapshot(target), patched);
  const reverse = () => execFileSync("git", ["apply", "--reverse", BACKGROUND_PANEL_CLOSE_PATCH], { cwd: target });
  reverse();
  assert.deepEqual(snapshot(target), original);
  const concurrent = await Promise.all([applyBackgroundPanelClosePatch(target), applyBackgroundPanelClosePatch(target)]);
  assert.equal(concurrent.filter(result => result.status === "applied").length, 1);
  assert.deepEqual(snapshot(target), patched);
  reverse();
  const lock = join(target, ".pi-enhance-panel-close.lock");
  mkdirSync(lock);
  assert.equal((await applyBackgroundPanelClosePatch(target)).status, "skipped");
  assert.deepEqual(snapshot(target), original);
  assert.equal(existsSync(lock), true);
  rmdirSync(lock);
  // A mismatch in dist must not leave src partially patched.
  writeFileSync(join(target, files[1]), original[1].replace("data === 'q'", "data === 'z'"));
  const mismatch = snapshot(target);
  assert.equal((await applyBackgroundPanelClosePatch(target)).status, "skipped");
  assert.deepEqual(snapshot(target), mismatch);
  assert.equal(existsSync(lock), false);
});

const closing = [
  "q", "x", "Q", "X", "\x1b",
  "\x1b[113u", "\x1b[120u", "\x1b[113;1:1u", "\x1b[120;1:1u",
  "\x1b[113;1:2u", "\x1b[120;1:2u", // Kitty repeat
  "\x1b[113;2u", "\x1b[120;2u", // Shift+Q/X
  "\x1b[27;1;113~", "\x1b[27;1;120~", // modifyOtherKeys
  "\x1b[27u", "\x1b[27;1:1u", "\x1b[27;1;27~",
];
const nonClosing = [
  "z", "\x11", "\x18", "\x1bq", "\x1bx",
  "\x1b[113;5u", "\x1b[120;5u", // Ctrl+q/x
  "\x1b[113;3u", "\x1b[120;3u", // Alt+q/x
  "\x1b[27;5;113~", "\x1b[27;3;120~",
  "\x1b[113;1:3u", "\x1b[120;1:3u", "\x1b[27;1:3u", // release, filtered by TUI
];

test("patched src/dist close focused list/detail overlays with Esc/q/x across keyboard protocols", integration, async t => {
  const target = join(fixture(t), "plugin");
  copyOriginalBackgroundPackage(upstream, target);
  assert.equal((await applyBackgroundPanelClosePatch(target)).status, "applied");
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: Object.fromEntries(["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]
      .map(name => [name, fileURLToPath(import.meta.resolve(name))])),
  });
  const task = {
    id: "poc", name: "Close test", command: "true", status: "completed",
    startTime: 0, endTime: 1000, exitCode: 0,
    outputPath: join(target, "absent.log"), outputAbsPath: join(target, "absent.log"),
  };
  for (const file of files) {
    const { BackgroundTasksManager }: any = await jiti.import(join(target, file));
    for (const mode of ["list", "detail"]) {
      for (const data of [...closing, ...nonClosing]) {
        let input!: (data: string) => void;
        const terminal: any = {
          columns: 120, rows: 24, kittyProtocolActive: true,
          start(onInput: typeof input) { input = onInput; },
          stop() {}, write() {}, hideCursor() {}, showCursor() {},
        };
        const tui = new TuiMainScreen(terminal);
        tui.requestRender = () => {};
        Object.defineProperty(tui, "requestImmediateRender", { value: () => {} });
        let closeCount = 0;
        let destructiveActions = 0;
        const manager = new BackgroundTasksManager(tui, { fg: (_color: string, text: string) => text }, () => {
          closeCount++;
          tui.hideOverlay();
        }, {
          initialTaskId: mode === "detail" ? task.id : undefined,
          getTasks: () => [task], markSeen() {}, markFinishedSeen() {}, isSeen: () => false,
          stopTask: async () => { destructiveActions++; },
          stopAllRunning: async () => { destructiveActions++; return { stopped: 0, failures: [] }; },
          rerunTask: async () => { destructiveActions++; return task; }, showOutputPath() {},
        });
        try {
          tui.start();
          tui.showOverlay(manager, {
            anchor: "bottom-center", width: "96%", minWidth: 64,
            maxHeight: "60%", margin: { bottom: 1, left: 1, right: 1 },
          });
          assert.equal(tui.getFocusedComponent(), manager);
          input(data);
          const expected = closing.includes(data);
          const label = `${file} ${mode} ${JSON.stringify(data)}`;
          assert.equal(closeCount, expected ? 1 : 0, label);
          assert.equal(tui.hasOverlayEntries, !expected, label);
          assert.equal(destructiveActions, 0, `closing never stops/reruns tasks: ${label}`);
        } finally {
          manager.dispose();
          tui.stop();
        }
      }
    }
  }
});
