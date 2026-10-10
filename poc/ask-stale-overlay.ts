// Run: node poc/ask-stale-overlay.ts
// Real questionnaire + native custom-dialog lifecycle + real TUI input/focus/overlay routing.
// No model calls, real terminal, running-session changes, or installation changes.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ExtensionRunner, InteractiveMode, createEventBus, initTheme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { TuiMainScreen, stripTerminalSequences } from "@earendil-works/pi-tui";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { wrapAskExecute } from "../extensions/rpiv-ask-user-question/ask-timeout.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-ask-overlay-poc-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;
initTheme("dark");
const questions = ["Start Docker", "Validation scope", "Network mode", "Build target"].map((header) => ({
  header, question: `${header}?`, options: [
    { label: "First (Recommended)", description: "First option" },
    { label: "Second", description: "Second option" },
  ],
}));

try {
  const events = createEventBus();
  const blocked: boolean[] = [];
  events.on("rpiv:ask-user:blocked", (event: any) => blocked.push(event.active));
  const loaded = await loadExtensions([resolve("node_modules/@juicesharp/rpiv-ask-user-question/index.ts")], process.cwd(), events);
  assert.deepEqual(loaded.errors, []);
  const runner = Object.assign(Object.create(ExtensionRunner.prototype), { extensions: loaded.extensions });
  const original: ToolDefinition["execute"] = runner.getAllRegisteredTools().find((tool: any) => tool.definition.name === "ask_user_question")!.definition.execute;

  for (const questionCount of [2, 3, 4]) {
    const params = { questions: questions.slice(0, questionCount) };
  for (const wrapped of [false, true]) {
    for (const action of ["Enter", "Ctrl+J", "Esc", "Kitty Enter", "Kitty Esc", "timeout", "timeout-question", "timeout-cancel", "timeout-hidden", "timeout-covered", "timeout-reopen", "abort-covered"] as const) {
      const isTimeout = action.startsWith("timeout");
      if (!wrapped && isTimeout) continue;
      let input!: (data: string) => void;
      const terminal: any = {
        columns: 120, rows: 40, kittyProtocolActive: true,
        start(onInput: (data: string) => void) { input = onInput; },
        stop() {}, write() {}, hideCursor() {}, showCursor() {},
        moveBy() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
        setTitle() {}, setProgress() {}, setProgramStatus() {},
      };
      const tui = new TuiMainScreen(terminal);
      const editorKeys: string[] = [];
      const editor = { getText: () => "", setText() {}, handleInput(data: string) { editorKeys.push(data); }, render: () => ["Editor ready"], invalidate() {} };
      tui.addChild(editor);
      let questionHandle: any;
      const mode = Object.assign(Object.create(InteractiveMode.prototype), {
        ui: tui, editor, keybindings: new KeybindingsManager(),
        editorContainer: { clear() {}, addChild() {} },
      });
      const listeners = new Set<() => void>();
      const ctx: any = {
        hasUI: true, mode: "tui", cwd: process.cwd(), isProjectTrusted: () => true,
        ui: {
          custom: (factory: any, options: any) => (mode as any).showExtensionCustom(factory, {
            ...options,
            onHandle(handle: any) { questionHandle = handle; options?.onHandle?.(handle); },
          }),
          onTerminalInput(listener: any) {
            const remove = tui.addInputListener(listener);
            const cleanup = () => { listeners.delete(cleanup); remove(); };
            listeners.add(cleanup);
            return cleanup;
          },
          notify() {},
        },
      };
      const pending = new Set<() => void>();
      const execute = wrapped ? wrapAskExecute(original, 100, pending) : original;
      const abort = new AbortController();
      let settled = false;
      tui.start();
      tui.setFocus(editor);
      const response = execute("poc", params, abort.signal, undefined, ctx).then(result => { settled = true; return result; });
      try {
        // Dynamic imports can take a turn; bound opening and completion so a stuck PoC cannot hang.
        for (let i = 0; i < 200 && !tui.hasOverlayEntries && !settled; i++) await delay(5);
        assert.equal(settled, false, "questionnaire must open before returning");
        assert.equal(tui.hasOverlayEntries, true, "questionnaire opened");
        const questionnaire: any = tui.getFocusedComponent();
        if (action !== "timeout-question") {
          for (let i = 0; i < questionCount; i++) input("\r");
          const review = questionnaire.render(120).join("\n");
          assert.match(review, /Review your answers/);
          for (const question of params.questions) assert.ok(review.includes(question.header), "review includes every question");
        }
        const before = questionnaire.render(120).join("\n");
        input("\x1b[B");
        assert.notEqual(questionnaire.render(120).join("\n"), before, "Down moves selection");
        if (action !== "timeout-cancel") input("\x1b[A");
        (tui as any).doRender();
        assert.ok(tui.captureRenderState().previousLines.length > 1, "real renderer drew the questionnaire");
        if (action === "timeout-hidden" || action === "timeout-covered") {
          if (action === "timeout-hidden") questionHandle.setHidden(true);
          else tui.showOverlay({ render: () => ["Cover"], invalidate() {}, handleInput() {} });
          await delay(350);
          assert.equal(settled, false, "timeout pauses while hidden or covered");
          if (action === "timeout-hidden") questionHandle.setHidden(false);
          else tui.hideOverlay();
          assert.equal(tui.getFocusedComponent(), questionnaire, "questionnaire regains focus");
        }
        let cover: any;
        if (action === "abort-covered") {
          cover = { render: () => ["Another dialog"], invalidate() {}, handleInput() {} };
          tui.showOverlay(cover);
          if (wrapped) abort.abort();
          else {
            // Unwrapped rpiv does not implement abort; dismiss the cover before testing cancel.
            tui.hideOverlay();
            input("\x1b");
          }
        } else if (!isTimeout) {
          const closeKeys: Partial<Record<typeof action, string>> = { Enter: "\r", "Ctrl+J": "\n", Esc: "\x1b", "Kitty Enter": "\x1b[13;1:1u", "Kitty Esc": "\x1b[27;1:1u" };
          const key = closeKeys[action];
          assert.ok(key, "manual close scenario has a key");
          input(key);
        }
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        const result: any = await Promise.race([
          response,
          new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error(`${action}: completion stuck`)), 2000); }),
        ]).finally(() => clearTimeout(watchdog));
        assert.deepEqual(blocked.splice(0), [true, false], "blocked state cleared");
        assert.equal(listeners.size, 0, "terminal listener removed");
        assert.equal(pending.size, 0, "timeout cancellation removed");
        if (cover && wrapped) {
          assert.equal(tui.getFocusedComponent(), cover, "abort preserves covering dialog");
          tui.hideOverlay();
        }
        assert.equal(tui.hasOverlayEntries, false, "no stale questionnaire overlay");
        assert.equal(tui.getFocusedComponent(), editor, "editor focus restored");
        assert.equal(Boolean(result.details?.timedOut), isTimeout, "only idle timeout is automatic");
        (tui as any).doRender();
        assert.deepEqual(tui.captureRenderState().previousLines.map(line => stripTerminalSequences(line)), ["Editor ready"], "real renderer clears questionnaire lines");
        for (const key of ["\x1b[B", "\r", "\x1b", "\x03"]) input(key);
        assert.deepEqual(editorKeys, ["\x1b[B", "\r", "\x1b", "\x03"], "post-close keys reach the editor, not the questionnaire");
        if (action === "timeout-reopen") {
          const next = execute("poc-next", params, abort.signal, undefined, ctx);
          for (let i = 0; i < 200 && !tui.hasOverlayEntries; i++) await delay(5);
          assert.equal(tui.hasOverlayEntries, true, "next questionnaire opens");
          input("\x1b");
          const nextResult: any = await next;
          assert.equal(nextResult.details.cancelled, true);
          assert.equal(Boolean(nextResult.details.timedOut), false, "Esc closes next questionnaire before timeout");
          assert.equal(tui.hasOverlayEntries, false);
          assert.equal(tui.getFocusedComponent(), editor);
          assert.deepEqual(blocked.splice(0), [true, false]);
          assert.equal(listeners.size, 0);
          assert.equal(pending.size, 0);
        }
        console.log(`${questionCount} questions ${wrapped ? "wrapped" : "plain  "} ${action.padEnd(16)} CLOSED; rendered lines cleared; post-close keys reach editor`);
      } finally {
        for (const cancel of pending) cancel();
        for (const remove of listeners) remove();
        tui.stop();
      }
    }
  }
  }
  console.log("No reproduction with 2/3/4 questions in these isolated cases. This does not cover other installed extensions or actual terminal bytes.");
} finally {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
}
