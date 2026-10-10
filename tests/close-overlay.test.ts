import assert from "node:assert/strict";
import test from "node:test";
import { TuiMainScreen, type TUI } from "@earendil-works/pi-tui";
import { createInteractiveTuiReference } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/tui-renderer.js";
import { closeOverlay } from "../extensions/pi-custom-overlay/close-overlay.ts";

function renderer() {
  const tui = new TuiMainScreen({ columns: 80, rows: 24, hideCursor() {} } as any);
  tui.requestRender = () => {};
  return tui;
}

for (const proxy of [false, true]) {
  test(`${proxy ? "Proxy" : "raw"}: nested close exceptions restore the original descriptor and keep unrelated overlays`, () => {
    const tui = renderer();
    const nativeHide = tui.hideOverlay;
    Object.defineProperty(tui, "hideOverlay", { value: nativeHide, writable: true, configurable: true, enumerable: false });
    const descriptor = Object.getOwnPropertyDescriptor(tui, "hideOverlay");
    const reference = proxy ? createInteractiveTuiReference(() => tui) : tui;
    const component = { render: () => ["Overlay"], invalidate() {} };
    const handle = tui.showOverlay(component);
    const cover = { render: () => ["Cover"], invalidate() {} };
    tui.showOverlay(cover);
    const failure = new Error("nested close failed");
    assert.throws(() => closeOverlay(reference, handle, () => {
      const outer = tui.hideOverlay;
      assert.throws(() => closeOverlay(reference, undefined, () => { throw failure; }), failure);
      assert.equal(tui.hideOverlay, outer);
      reference.hideOverlay();
      throw failure;
    }), failure);
    assert.deepEqual(Object.getOwnPropertyDescriptor(tui, "hideOverlay"), descriptor);
    assert.equal(tui.getFocusedComponent(), cover);
    reference.hideOverlay();
    assert.equal(tui.hasOverlayEntries, false);
  });
}

test("stable TUI reference resolves the current renderer when closed and leaves native routing intact after another switch", () => {
  const first = renderer(), second = renderer(), third = renderer();
  const originals = [first, second, third].map(tui => tui.hideOverlay);
  let current: TUI = first;
  const reference = createInteractiveTuiReference(() => current);
  current = second;
  const handle = reference.showOverlay({ render: () => ["Second"], invalidate() {} });
  closeOverlay(reference, handle, () => reference.hideOverlay());
  assert.equal(second.hasOverlayEntries, false);
  assert.deepEqual([first, second, third].map(tui => tui.hideOverlay), originals);
  current = third;
  reference.showOverlay({ render: () => ["Third"], invalidate() {} });
  reference.hideOverlay();
  assert.equal(third.hasOverlayEntries, false);
  assert.equal(Object.hasOwn(second, "hideOverlay"), false);
});
