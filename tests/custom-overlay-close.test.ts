import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen, TuiMainScreen, type OverlayHandle } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { installCustomOverlayClose, registerCustomOverlayClose, type CustomOverlayHost } from "../extensions/pi-custom-overlay/overlay-close.ts";

initTheme("dark");

function fixture(fullscreen = false) {
  const terminal: any = {
    columns: 120, rows: 40, kittyProtocolActive: true,
    start() {}, stop() {}, write() {}, hideCursor() {}, showCursor() {},
  };
  const tui = fullscreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
  // Test native lifecycle and focus, without scheduling terminal drawing.
  tui.requestRender = () => {};
  const editor = { getText: () => "draft", setText() {}, render: () => ["Editor"], invalidate() {} };
  tui.addChild(editor);
  tui.setFocus(editor);
  const host = Object.assign(Object.create(InteractiveMode.prototype), {
    ui: tui, editor, keybindings: new KeybindingsManager(),
    editorContainer: { clear() {}, addChild() {} },
  }) as CustomOverlayHost;
  const original = host.showExtensionCustom;
  const restore = installCustomOverlayClose(host);
  return { tui, editor, host, original, restore };
}

for (const fullscreen of [false, true]) {
  test(`${fullscreen ? "fullscreen" : "main"}: close underlying overlay and preserve covering dialog/focus`, async () => {
    const h = fixture(fullscreen);
    let done!: (value: string) => void;
    let disposed = 0;
    let onHandleCalls = 0;
    const shell = { render: () => ["Shell"], invalidate() {}, dispose() { disposed++; } };
    const options = { overlay: true, overlayOptions: () => ({ width: "80%" as const }), onHandle(handle: OverlayHandle) { onHandleCalls++; handle.focus(); } };
    try {
      const response = h.host.showExtensionCustom<string>((_tui, _theme, _keys, close) => { done = close; return shell; }, options);
      await delay(0);
      assert.equal(onHandleCalls, 1);
      assert.equal(h.tui.getFocusedComponent(), shell);
      const cover = { render: () => ["Cover"], invalidate() {} };
      const coverHandle = h.tui.showOverlay(cover);
      done("exited"); done("duplicate");
      assert.equal(await response, "exited");
      assert.equal(disposed, 1);
      assert.equal(h.tui.getFocusedComponent(), cover);
      assert.equal(h.tui.hasOverlayEntries, true);
      coverHandle.hide();
      assert.equal(h.tui.hasOverlayEntries, false, "no underlying stale shell");
      assert.equal(h.tui.getFocusedComponent(), h.editor);
      assert.equal(Object.hasOwn(h.tui, "hideOverlay"), false);
      assert.equal(options.onHandle instanceof Function, true);
    } finally { h.restore(); }
  });
}

for (const asynchronous of [false, true]) {
  test(`completion before ${asynchronous ? "async" : "sync"} factory mounts preserves existing overlay`, async () => {
    const h = fixture();
    const existing = { render: () => ["Existing"], invalidate() {} };
    const handle = h.tui.showOverlay(existing);
    try {
      let mounted = false;
      const response = h.host.showExtensionCustom((_tui, _theme, _keys, done) => {
        const component = { render: () => ["Never mounted"], invalidate() {} };
        if (asynchronous) return delay(0).then(() => { done(42); return component; });
        done(42); return component;
      }, { overlay: true, onHandle() { mounted = true; } });
      assert.equal(await response, 42);
      await delay(0);
      assert.equal(mounted, false);
      assert.equal(h.tui.getFocusedComponent(), existing);
      handle.hide();
      assert.equal(h.tui.hasOverlayEntries, false);
    } finally { h.restore(); }
  });
}

test("inline dialogs retain native editor restoration and do not remove an overlay", async () => {
  const h = fixture();
  const existing = { render: () => ["Existing"], invalidate() {} };
  const handle = h.tui.showOverlay(existing);
  let done!: (value: number) => void;
  try {
    const result = h.host.showExtensionCustom<number>((_tui, _theme, _keys, close) => {
      done = close; return { render: () => ["Inline"], invalidate() {} };
    });
    await delay(0); done(1);
    assert.equal(await result, 1);
    assert.equal(h.tui.getFocusedComponent(), existing, "native TUI preserves the visible capturing overlay's focus");
    assert.equal(h.tui.hasOverlayEntries, true);
    handle.hide(); assert.equal(h.tui.hasOverlayEntries, false);
  } finally { h.restore(); }
});

test("reinstall/shutdown ownership and an already open dialog's scoped close survive restoration", async () => {
  const h = fixture();
  let done!: (value: boolean) => void;
  const firstInstalled = h.host.showExtensionCustom;
  const response = h.host.showExtensionCustom<boolean>((_tui, _theme, _keys, close) => {
    done = close; return { render: () => ["Shell"], invalidate() {} };
  }, { overlay: true });
  await delay(0);
  const secondRestore = installCustomOverlayClose(h.host);
  const secondInstalled = h.host.showExtensionCustom;
  assert.notEqual(secondInstalled, firstInstalled);
  h.restore(); assert.equal(h.host.showExtensionCustom, secondInstalled);
  secondRestore(); assert.equal(h.host.showExtensionCustom, h.original);
  const cover = { render: () => ["Cover"], invalidate() {} };
  const coverHandle = h.tui.showOverlay(cover);
  done(true); assert.equal(await response, true);
  assert.equal(h.tui.getFocusedComponent(), cover);
  coverHandle.hide(); assert.equal(h.tui.hasOverlayEntries, false);
  secondRestore();
});

test("native close failure restores the TUI method's original own descriptor", async () => {
  const h = fixture();
  const hide = h.tui.hideOverlay.bind(h.tui);
  Object.defineProperty(h.tui, "hideOverlay", { value: hide, writable: true, configurable: true, enumerable: false });
  const before = Object.getOwnPropertyDescriptor(h.tui, "hideOverlay");
  let done!: (value: boolean) => void;
  const failure = new Error("handle close failed");
  let handle!: OverlayHandle;
  try {
    // Native host calls the onHandle callback with the same handle retained by the patch.
    void h.host.showExtensionCustom<boolean>((_tui, _theme, _keys, close) => {
      done = close; return { render: () => ["Shell"], invalidate() {} };
    }, { overlay: true, onHandle(next) { handle = next; } });
    await delay(0);
    const realHide = handle.hide;
    handle.hide = () => { throw failure; };
    assert.throws(() => done(true), failure);
    assert.deepEqual(Object.getOwnPropertyDescriptor(h.tui, "hideOverlay"), before);
    handle.hide = realHide; handle.hide();
  } finally { h.restore(); }
});

test("extension shutdown unregisters the native host patch", () => {
  const host = InteractiveMode.prototype as unknown as CustomOverlayHost;
  const original = host.showExtensionCustom;
  let shutdown!: () => void;
  registerCustomOverlayClose({ on(name: string, listener: () => void) { assert.equal(name, "session_shutdown"); shutdown = listener; } } as any);
  assert.notEqual(host.showExtensionCustom, original);
  shutdown(); assert.equal(host.showExtensionCustom, original);
});
