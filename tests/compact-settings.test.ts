import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, normalizeConfig, saveConfig } from "../extensions/config.ts";
import { compactThresholdLabel, editSettings } from "../extensions/settings.ts";

test("settings editor saves kind, ratio, count and idle time; applies via reload", async t => {
  const directory = mkdtempSync(join(tmpdir(), "pi-compact-settings-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "settings.json");
  writeFileSync(path, JSON.stringify({ futureSetting: { keep: true } }));
  const choices = [0, "on", 2, 1, "ratio", 2, 3, 4, 5, "off", 6, "off", 7];
  const inputs = ["160000", "80", "15", "60"];
  let reloaded = 0;
  const original = normalizeConfig({});
  const ctx = {
    mode: "tui", hasUI: true,
    ui: {
      select: async (_title: string, options: string[]) => {
        const value = choices.shift();
        return typeof value === "number" ? options[value] : value;
      },
      input: async () => inputs.shift(), notify() {},
    },
    reload: async () => { reloaded++; },
  } as unknown as ExtensionCommandContext;
  await editSettings(ctx, original, path);
  assert.equal(reloaded, 1);
  assert.equal(original.compactWhenAwayEnabled, false, "editing must not mutate active configuration");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(saved.futureSetting, { keep: true });
  assert.equal(saved.compactWhenAwayEnabled, true);
  assert.equal(saved.compactWhenAwayThresholdKind, "ratio");
  assert.equal(saved.compactWhenAwayThresholdTokens, 160_000);
  assert.equal(saved.compactWhenAwayThresholdRatio, 0.8);
  assert.equal(saved.compactWhenAwayIdleMinutes, 15);
  assert.equal(saved.askUserTimeoutMs, 60_000);
  assert.equal(saved.imagePasteEnabled, false);
  assert.equal(saved.backgroundTaskAutopatchEnabled, false);
  assert.equal(compactThresholdLabel(saved), "80% of context window");
  assert.equal(compactThresholdLabel(normalizeConfig({})), "128000 tokens");
});

test("invalid settings are rejected; cancel does not save or reload", async t => {
  const directory = mkdtempSync(join(tmpdir(), "pi-compact-settings-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "settings.json");
  const choices: Array<number | string> = [2, 1, "ratio", 2, 3, 4, 8];
  const inputs = ["-5", "101", "1.5", "-1"];
  const notices: string[] = [];
  const ctx = {
    mode: "tui", hasUI: true,
    ui: {
      select: async (_title: string, options: string[]) => {
        const choice = choices.shift();
        return typeof choice === "number" ? options[choice] : choice;
      },
      input: async () => inputs.shift(), notify: (message: string) => notices.push(message),
    },
    reload: async () => { assert.fail("cancel must not reload"); },
  } as unknown as ExtensionCommandContext;
  await editSettings(ctx, normalizeConfig({}), path);
  assert.equal(notices.length, 4);
  assert.equal(existsSync(path), false);
});

test("malformed configuration is disabled and not overwritten by saving", t => {
  const directory = mkdtempSync(join(tmpdir(), "pi-compact-settings-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "settings.json");
  for (const text of ["broken json", "[]", "null"]) {
    writeFileSync(path, text);
    assert.throws(() => saveConfig(path, { compactWhenAwayEnabled: true }));
    assert.equal(readFileSync(path, "utf8"), text);
  }
  writeFileSync(path, "broken json");
  assert.equal(loadConfig(path).config.compactWhenAwayEnabled, false);
  assert.ok(loadConfig(path).warning);
});
