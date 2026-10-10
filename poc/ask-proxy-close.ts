// Run: node poc/ask-proxy-close.ts
// Actual Pi TUI reference Proxy, native custom lifecycle, and real rpiv questionnaire.
// No production edits or model calls. The final scenario deliberately removes wrappers.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ExtensionRunner, InteractiveMode, createEventBus, initTheme } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen, TuiMainScreen, stripTerminalSequences } from "@earendil-works/pi-tui";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { createInteractiveTuiReference } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/tui-renderer.js";
import { installCustomOverlayClose } from "../extensions/pi-custom-overlay/overlay-close.ts";
import { wrapAskExecute } from "../extensions/rpiv-ask-user-question/ask-timeout.ts";

initTheme("dark");
const expectFixed = !process.argv.includes("--expect-bug");
const loaded = await loadExtensions([resolve("node_modules/@juicesharp/rpiv-ask-user-question/index.ts")], process.cwd(), createEventBus());
assert.deepEqual(loaded.errors, []);
const runner = Object.assign(Object.create(ExtensionRunner.prototype), { extensions: loaded.extensions });
const execute = runner.getAllRegisteredTools().find((tool: any) => tool.definition.name === "ask_user_question")!.definition.execute;
const params = { questions: ["DeviceName", "Discoverable"].map(header => ({
  header, question: `${header}?`, options: [
    { label: "Default (Recommended)", description: "Default" },
    { label: "Second", description: "Second" },
  ],
})) };

for (const fullscreen of [false, true]) {
  for (const patch of ["none", "custom", "timeout", "both"] as const) {
    let input!: (data: string) => void;
    const terminal: any = {
      columns: 120, rows: 40, kittyProtocolActive: true,
      start(onInput: (data: string) => void) { input = onInput; },
      stop() {}, write() {}, hideCursor() {}, showCursor() {}, moveBy() {},
      clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
    };
    const renderer = fullscreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
    const reference = createInteractiveTuiReference(() => renderer);
    const nativeHide = renderer.hideOverlay;
    const editor = { getText: () => "", setText() {}, render: () => ["Editor"], invalidate() {} };
    renderer.addChild(editor);
    const mode = Object.assign(Object.create(InteractiveMode.prototype), {
      ui: reference, editor, keybindings: new KeybindingsManager(),
      editorContainer: { clear() {}, addChild() {} },
    });
    const restore = patch === "custom" || patch === "both" ? installCustomOverlayClose(mode) : () => {};
    const ctx: any = {
      hasUI: true, mode: "tui", cwd: process.cwd(), isProjectTrusted: () => true,
      ui: {
        custom: (factory: any, options: any) => mode.showExtensionCustom(factory, options),
        onTerminalInput: (listener: any) => renderer.addInputListener(listener), notify() {},
      },
    };
    const pending = new Set<() => void>();
    const firstExecute = patch === "timeout" || patch === "both" ? wrapAskExecute(execute, 60000, pending) : execute;
    renderer.start();
    renderer.setFocus(editor);
    const submit = async (tool: typeof execute) => {
      const response = tool("proxy-poc", params, undefined, undefined, ctx);
      for (let i = 0; i < 200 && !renderer.hasOverlayEntries; i++) await delay(5);
      assert.equal(renderer.hasOverlayEntries, true);
      input("\r"); input("\r");
      assert.match(renderer.getFocusedComponent()!.render(120).join("\n"), /Ready to submit/);
      input("\r");
      const result: any = await response;
      assert.equal(result.details.cancelled, false);
      assert.equal(result.details.answers.length, 2);
      await delay(50);
    };
    try {
      await submit(firstExecute);
      assert.equal(renderer.hasOverlayEntries, false, "initial questionnaire closes normally");
      const leaked = renderer.hideOverlay !== nativeHide;
      assert.equal(leaked, !expectFixed && patch !== "none", "patched close must restore the actual renderer method");
      if (expectFixed && (patch === "timeout" || patch === "both")) {
        const controller = new AbortController();
        const abortResponse = firstExecute("abort-proxy", params, controller.signal, undefined, ctx);
        for (let i = 0; i < 200 && !renderer.hasOverlayEntries; i++) await delay(5);
        assert.equal(renderer.hasOverlayEntries, true);
        const cover = { render: () => ["Cover during abort"], invalidate() {} };
        reference.showOverlay(cover);
        controller.abort();
        assert.equal((await abortResponse as any).details.cancelled, true);
        assert.equal(renderer.getFocusedComponent(), cover, "abort preserves covering overlay");
        assert.equal(renderer.hideOverlay, nativeHide, "abort restores native method");
        reference.hideOverlay();
        assert.equal(renderer.hasOverlayEntries, false);
        const idleResponse = wrapAskExecute(execute, 50, pending)("idle-proxy", params, undefined, undefined, ctx);
        await delay(150);
        assert.equal((await idleResponse as any).details.timedOut, true);
        assert.equal(renderer.hasOverlayEntries, false, "idle timeout closes through real Proxy");
        assert.equal(renderer.hideOverlay, nativeHide, "idle timeout restores native method");
        assert.equal(pending.size, 0);
      }
      const component = { render: () => ["Unrelated overlay"], invalidate() {} };
      const handle = reference.showOverlay(component);
      reference.hideOverlay();
      const unrelatedStuck = renderer.hasOverlayEntries;
      assert.equal(unrelatedStuck, leaked, "native hide targets an already removed old handle");
      handle.hide();
      // Lifecycle test: unregister wrappers, without replacing the renderer.
      // This establishes consequences of incomplete teardown; it does not claim
      // a normal /reload necessarily leaves the next questionnaire unwrapped.
      restore();
      await submit(execute);
      const staleQuestionnaire = renderer.hasOverlayEntries;
      assert.equal(staleQuestionnaire, leaked, "native questionnaire resolves while its overlay remains");
      if (staleQuestionnaire) {
        const painted = fullscreen ? (renderer as any).previousScreen : (renderer as TuiMainScreen).captureRenderState().previousLines;
        assert.match(painted.map((line: string) => stripTerminalSequences(line)).join("\n"), /Ready to submit/);
        assert.notEqual(renderer.getFocusedComponent(), editor);
      }
      console.log(JSON.stringify({ mode: fullscreen ? "fullscreen" : "main", patch,
        initialSubmitClosed: true, referenceHasOwnHide: Object.hasOwn(reference, "hideOverlay"),
        rendererHasOwnHide: Object.hasOwn(renderer, "hideOverlay"), leaked,
        unrelatedNativeHideStuck: unrelatedStuck, unwrappedQuestionnaireReturnedButStuck: staleQuestionnaire }));
    } finally {
      restore();
      for (const cancel of pending) cancel();
      // Cleanup uses the real native method, avoiding the leaked no-op.
      while (renderer.hasOverlayEntries) nativeHide.call(renderer);
      renderer.stop();
    }
  }
}
