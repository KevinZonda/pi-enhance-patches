import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, normalizeConfig, saveConfig } from "../extensions/config.ts";
import { registerSettings } from "../extensions/settings.ts";
import { registerImagePastePatches } from "../extensions/pi-image-paste/index.ts";
import { registerBackgroundTaskPatches } from "../extensions/pi-background-tasks/index.ts";

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pi-enhance-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, "pi-enhance-patches.json") };
}

test("one configuration defines all enhancement defaults", () => {
  const config = normalizeConfig({});
  assert.equal(config.askUserTimeoutMs, 0);
  assert.equal(config.imagePasteEnabled, true);
  assert.equal(config.backgroundTaskAutopatchEnabled, true);
  assert.equal(config.compactWhenAwayEnabled, false);
  assert.equal(config.compactWhenAwayThresholdKind, "count");
  assert.equal(config.compactWhenAwayThresholdTokens, 128_000);
  assert.equal(config.compactWhenAwayThresholdRatio, 0.7);
  assert.equal(config.compactWhenAwayIdleMinutes, 10);
});

test("legacy settings are read without writes and saved together on apply", t => {
  const { dir, path } = fixture(t);
  const asks = join(dir, "pi-enhance-patches-asks.json");
  const compact = join(dir, "pi-enhance-patches-compact.json");
  writeFileSync(asks, JSON.stringify({ askUserTimeoutMs: 30000, imagePasteEnabled: false }));
  writeFileSync(compact, JSON.stringify({ compactWhenAwayEnabled: true,
    compactWhenAwayThresholdKind: "ratio", compactWhenAwayThresholdRatio: 0.8, compactWhenAwayIdleMinutes: 15 }));
  const config = loadConfig(path).config;
  assert.equal(config.askUserTimeoutMs, 30000);
  assert.equal(config.compactWhenAwayEnabled, true);
  assert.equal(config.compactWhenAwayThresholdKind, "ratio");
  assert.equal(config.compactWhenAwayThresholdRatio, 0.8);
  assert.equal(config.compactWhenAwayIdleMinutes, 15);
  assert.equal(config.imagePasteEnabled, true, "legacy files only supply their own settings");
  assert.equal(existsSync(path), false);
  const originalAsks = readFileSync(asks, "utf8");
  saveConfig(path, config);
  writeFileSync(compact, JSON.stringify({ compactWhenAwayThresholdRatio: 0.9 }));
  assert.deepEqual(loadConfig(path).config, config, "saved unified values supersede legacy files");
  assert.equal(readFileSync(asks, "utf8"), originalAsks);
});

test("unified false and zero values win over legacy settings while missing keys fall back", t => {
  const { dir, path } = fixture(t);
  writeFileSync(join(dir, "pi-enhance-patches-asks.json"), JSON.stringify({ askUserTimeoutMs: 60000 }));
  writeFileSync(join(dir, "pi-enhance-patches-compact.json"), JSON.stringify({ compactWhenAwayEnabled: true, compactWhenAwayIdleMinutes: 20 }));
  writeFileSync(path, JSON.stringify({ askUserTimeoutMs: 0, compactWhenAwayEnabled: false, imagePasteEnabled: false }));
  const config = loadConfig(path).config;
  assert.equal(config.askUserTimeoutMs, 0);
  assert.equal(config.compactWhenAwayEnabled, false);
  assert.equal(config.compactWhenAwayIdleMinutes, 20);
  assert.equal(config.imagePasteEnabled, false);
});

test("malformed central config does not activate legacy opt-in features", t => {
  const { dir, path } = fixture(t);
  writeFileSync(join(dir, "pi-enhance-patches-compact.json"), JSON.stringify({ compactWhenAwayEnabled: true }));
  writeFileSync(path, "invalid JSON");
  const result = loadConfig(path);
  assert.equal(result.config.compactWhenAwayEnabled, false);
  assert.ok(result.warning);
  assert.throws(() => saveConfig(path, result.config));
  assert.equal(readFileSync(path, "utf8"), "invalid JSON");
});

test("broken legacy configs warn only when their values are needed", t => {
  const { dir, path } = fixture(t);
  writeFileSync(join(dir, "pi-enhance-patches-asks.json"), "invalid JSON");
  assert.ok(loadConfig(path).warning);
  saveConfig(path, normalizeConfig({}));
  assert.equal(loadConfig(path).warning, undefined);
});

test("a single settings command shows the unified configuration", async () => {
  const commands = new Map<string, any>();
  registerSettings({ registerCommand: (name: string, command: any) => commands.set(name, command) } as unknown as ExtensionAPI,
    normalizeConfig({}), "/tmp/pi-enhance-patches.json");
  assert.deepEqual([...commands.keys()], ["enhance-patches"]);
  const notices: string[] = [];
  const ctx = { ui: { notify: (message: string) => notices.push(message) } } as unknown as ExtensionCommandContext;
  await commands.get("enhance-patches").handler("show", ctx);
  assert.match(notices[0], /pi-enhance-patches\.json/);
  assert.match(notices[0], /Questionnaire idle timeout: off/);
  assert.match(notices[0], /Image paste markers: on/);
});

test("disabled image paste and background autopatch do not install hooks", () => {
  const pi = { on() { assert.fail("disabled module installed an event handler"); } } as unknown as ExtensionAPI;
  registerImagePastePatches(pi, false);
  registerBackgroundTaskPatches(pi, false);
});
