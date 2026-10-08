import { InteractiveMode, initTheme, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";

initTheme("dark");
export async function flush(): Promise<void> { for (let i = 0; i < 20; i++) await Promise.resolve(); }

/** Use Pi's real custom-dialog close implementation with an in-memory overlay stack. */
export function host() {
  const stack: Array<{ component: any; hidden: boolean; handle: any }> = [];
  const listeners = new Set<(data: string) => any>();
  const tui: any = {
    terminal: { columns: 100, rows: 40, write() {} },
    requestRender() {}, stop() {}, start() {}, setFocus() {},
    hideOverlay() { stack.pop(); },
    showOverlay(component: any) {
      const entry = { component, hidden: false, handle: {} as any };
      entry.handle = {
        hide() { const index = stack.indexOf(entry); if (index >= 0) stack.splice(index, 1); },
        setHidden(hidden: boolean) { entry.hidden = hidden; },
        isHidden: () => entry.hidden,
        isFocused: () => stack.at(-1) === entry,
      };
      stack.push(entry);
      return entry.handle;
    },
  };
  const editor = { getText: () => "draft", setText() {} };
  const mode = Object.assign(Object.create(InteractiveMode.prototype), {
    ui: tui, editor, keybindings: new KeybindingsManager(),
    editorContainer: { clear() {}, addChild() {} },
  });
  const ui = {
    custom: (factory: any, options: any) => mode.showExtensionCustom(factory, options),
    onTerminalInput(listener: (data: string) => any) { listeners.add(listener); return () => listeners.delete(listener); },
    notify() {},
  };
  const ctx = { hasUI: true, mode: "tui", ui, cwd: process.cwd(), isProjectTrusted: () => true } as unknown as ExtensionToolContext;
  return { ctx, tui, stack, listeners };
}

export const simpleExecute: ToolDefinition["execute"] = async (_id, _params, _signal, _update, ctx) => {
  const remove = ctx.ui.onTerminalInput(() => undefined);
  try {
    const result = await ctx.ui.custom<any>((tui, _theme, _keys, done) => ({
      render: () => ["Question"], invalidate() {},
      handleInput(data: string) {
        if (data === "yes") done({ answers: ["yes"], cancelled: false });
        if (data === "esc") done({ answers: [], cancelled: true });
        if (data === "editor") tui.stop();
        if (data === "resume") tui.start();
      },
    }), { overlay: true });
    return { content: [{ type: "text", text: result?.cancelled ? "User declined to answer questions" : "Answered" }], details: result };
  } finally { remove(); }
};
