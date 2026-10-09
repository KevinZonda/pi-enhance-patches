import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExtensionRunner, InteractiveMode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { IMAGE_ENTRY, ImageAttachments, installImagePaste, type Attachment, type Clipboard, type PasteHost, type PastePrototype } from "../extensions/pi-image-paste/image-paste.ts";
import { registerImagePastePatches } from "../extensions/pi-image-paste/index.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=", "base64");
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pi-image-paste-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "image with spaces.png");
  writeFileSync(path, png);
  let text = "";
  let nativeCalls = 0;
  const errors: string[] = [];
  const saved: Attachment[] = [];
  const attachments = new ImageAttachments();
  const prototype: PastePrototype = { async handleClipboardPaste() { nativeCalls++; } };
  const mode: PasteHost & PastePrototype = Object.assign(Object.create(prototype), {
    editor: { getText: () => text, getCursor: () => ({ line: 0, col: text.length }), insertTextAtCursor: (value: string) => { text += value; } },
    isBashMode: false, session: { sessionId: "one" }, ui: { requestRender() {} }, showError: (error: string) => errors.push(error),
  });
  const clipboard: Clipboard = {
    readClipboardFilePaths: async () => null,
    readClipboardImage: async () => ({ bytes: png, mimeType: "image/png" }),
    detectSupportedImageMimeTypeFromFile: async value => value === path ? "image/png" : undefined,
    saveImage: () => path,
  };
  const dispose = installImagePaste(prototype, clipboard, "one", attachments, image => saved.push(image));
  t.after(dispose);
  return { path, mode, clipboard, prototype, attachments, saved, errors, dispose,
    get text() { return text; }, set text(value: string) { text = value; }, get nativeCalls() { return nativeCalls; } };
}

test("concurrent screenshot pastes get ordered markers, spaces, and actual image bytes", async t => {
  const h = fixture(t);
  h.text = "看看";
  await Promise.all([h.mode.handleClipboardPaste(), h.mode.handleClipboardPaste()]);
  assert.equal(h.text, "看看 [Image #1 (1x1)] [Image #2 (1x1)]");
  assert.equal(h.saved.length, 2);
  assert.deepEqual(h.attachments.resolve(h.text), [1, 2].map(() => ({ type: "image", data: png.toString("base64"), mimeType: "image/png" })));
  assert.deepEqual(h.attachments.resolve("deleted all markers"), []);
  assert.equal(h.attachments.resolve("[Image #2] [Image #2 (1x1)]").length, 1);
  assert.deepEqual(h.attachments.resolve("[Image #1 (708x172)]"), h.attachments.resolve("[Image #1]"));
  assert.equal(h.attachments.resolve("[Image #1]").length, 1); // History resend remains usable.
});

test("copied images and ordinary files can be pasted together", async t => {
  const h = fixture(t);
  h.clipboard.readClipboardFilePaths = async () => [h.path, "/tmp/notes.txt"];
  await h.mode.handleClipboardPaste();
  assert.equal(h.text, "[Image #1 (1x1)]\n/tmp/notes.txt");
  assert.equal(h.saved[0].path, h.path);
  assert.equal(h.nativeCalls, 0);
});

test("dimension header produces the requested 708x172 marker and unknown dimensions fall back", async t => {
  const h = fixture(t);
  // Synthetic PNG header: dimension display reads metadata, not decoded pixels.
  const header = Buffer.from(png);
  header.writeUInt32BE(708, 16);
  header.writeUInt32BE(172, 20);
  writeFileSync(h.path, header);
  await h.mode.handleClipboardPaste();
  assert.equal(h.text, "[Image #1 (708x172)]");
  h.text = "";
  h.clipboard.readClipboardImage = async () => ({ bytes: header, mimeType: "image/bmp" });
  await h.mode.handleClipboardPaste();
  assert.equal(h.text, "[Image #2]");
  assert.equal(h.errors.length, 0);
});

test("text, non-images, shell mode and other sessions use native paste", async t => {
  const h = fixture(t);
  h.clipboard.readClipboardFilePaths = async () => ["/tmp/folder"];
  await h.mode.handleClipboardPaste();
  h.clipboard.readClipboardFilePaths = async () => null;
  h.clipboard.readClipboardImage = async () => null;
  await h.mode.handleClipboardPaste();
  h.mode.isBashMode = true;
  await h.mode.handleClipboardPaste();
  h.mode.isBashMode = false;
  h.mode.session.sessionId = "two";
  await h.mode.handleClipboardPaste();
  assert.equal(h.nativeCalls, 4);
  assert.equal(h.saved.length, 0);
});

test("clipboard errors and malicious file paths leave the draft intact", async t => {
  const h = fixture(t);
  h.text = "draft";
  h.clipboard.readClipboardFilePaths = async () => ["/tmp/a\nfile.png"];
  await h.mode.handleClipboardPaste();
  h.clipboard.readClipboardFilePaths = async () => { throw new Error("clipboard denied"); };
  await h.mode.handleClipboardPaste();
  assert.equal(h.text, "draft");
  assert.equal(h.errors.length, 2);
  assert.equal(h.saved.length, 0);
});

test("shutdown cancels an in-flight paste and restores the original hook", async t => {
  const h = fixture(t);
  let finish!: (paths: null) => void;
  h.clipboard.readClipboardFilePaths = () => new Promise(resolve => { finish = resolve; });
  const paste = h.mode.handleClipboardPaste();
  await Promise.resolve();
  h.dispose();
  finish(null);
  await paste;
  assert.equal(h.text, "");
  assert.equal(h.saved.length, 0);
  await h.mode.handleClipboardPaste();
  assert.equal(h.nativeCalls, 1);
});

test("old shutdown cannot remove a replacement patch", async t => {
  const h = fixture(t);
  const replacement = installImagePaste(h.prototype, h.clipboard, "one", h.attachments, image => h.saved.push(image));
  t.after(replacement);
  h.dispose();
  await h.mode.handleClipboardPaste();
  assert.equal(h.text, "[Image #1 (1x1)]");
});

test("real input event chain restores mappings, attaches images and blocks missing/unsupported images", async t => {
  const h = fixture(t);
  const nativePaste = (InteractiveMode.prototype as any).handleClipboardPaste;
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  registerImagePastePatches({
    on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    appendEntry() {},
  } as any as ExtensionAPI);
  let draft = "";
  const notifications: string[] = [];
  const ctx = {
    mode: "tui", model: { input: ["text", "image"] },
    sessionManager: { getSessionId: () => "one", getEntries: () => [
      { type: "custom", customType: IMAGE_ENTRY, data: { id: 3, path: h.path, mimeType: "image/png" } },
      { type: "custom", customType: IMAGE_ENTRY, data: { id: -1 } },
    ] },
    ui: { notify: (message: string) => notifications.push(message), setEditorText: (value: string) => { draft = value; } },
  };
  const fire = async (name: string) => { for (const handler of handlers.get(name) ?? []) await handler({}, ctx); };
  const runner = Object.assign(Object.create(ExtensionRunner.prototype), {
    extensions: [{ path: "image-paste", handlers }], createContext: () => ctx,
    emitError(error: unknown) { throw error; },
  });
  try {
    await fire("session_start");
    assert.notEqual((InteractiveMode.prototype as any).handleClipboardPaste, nativePaste);
    const existing = { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" };
    const sent = await runner.emitInput("看 [Image #3]", [existing], "interactive");
    assert.equal(sent.action, "transform");
    assert.deepEqual(sent.images, [existing, existing]);
    assert.equal(sent.text, "看 [Image #3]");
    const withResolution = await runner.emitInput("看 [Image #3 (708x172)]", undefined, "interactive");
    assert.equal(withResolution.action, "transform");
    assert.deepEqual(withResolution.images, [existing]);
    assert.equal((await runner.emitInput("text", undefined, "interactive")).action, "continue");
    assert.equal((await runner.emitInput("[Image #3]", undefined, "rpc")).action, "continue");
    assert.equal((await runner.emitInput("[Image #99]", undefined, "interactive")).action, "handled");
    assert.equal(draft, "[Image #99]");
    ctx.model.input = ["text"];
    assert.equal((await runner.emitInput("[Image #3]", undefined, "interactive")).action, "handled");
    ctx.model.input = ["text", "image"];
    rmSync(h.path);
    assert.equal((await runner.emitInput("[Image #3]", undefined, "interactive")).action, "handled");
    assert.equal(notifications.length, 3);
    await fire("session_shutdown");
    ctx.mode = "rpc";
    ctx.sessionManager.getEntries = () => { throw new Error("non-TUI must not read attachment records"); };
    await fire("session_start");
    assert.equal((await runner.emitInput("[Image #99]", undefined, "interactive")).action, "continue");
    assert.equal(notifications.length, 3);
  } finally {
    await fire("session_shutdown");
    assert.equal((InteractiveMode.prototype as any).handleClipboardPaste, nativePaste);
  }
});

test("restored attachment numbers never alias a new paste", async t => {
  const h = fixture(t);
  const restored = new ImageAttachments([{ id: 7, path: h.path, mimeType: "image/png" }]);
  assert.equal(restored.add(h.path, "image/png").id, 8);
  assert.throws(() => restored.resolve("[Image #1]"), /Unknown image/);
});
