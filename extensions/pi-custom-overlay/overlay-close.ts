import { InteractiveMode, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";

type Custom = ExtensionUIContext["custom"];
export interface CustomOverlayHost { showExtensionCustom: Custom }
const KEY = Symbol.for("pi.enhance-patches-custom-overlay.owner");
type Host = CustomOverlayHost & { [KEY]?: { dispose(): void } };

/** Pi 1.1.0's native done() pops the top overlay, which may belong to another dialog. */
export function installCustomOverlayClose(
  prototype = InteractiveMode.prototype as unknown as CustomOverlayHost,
): () => void {
  const host = prototype as Host;
  host[KEY]?.dispose();
  const original = host.showExtensionCustom;
  if (typeof original !== "function") return () => {};
  let active = true;

  const installed: Custom = function (this: CustomOverlayHost, factory, options) {
    if (!active || !options?.overlay) return original.call(this, factory, options);
    let handle: OverlayHandle | undefined;
    return original.call(this, (tui, theme, keys, done) => factory(tui, theme, keys, result => {
      // Only intercept the synchronous native close; leave all other TUI calls intact.
      // Before mount, native close must not remove an unrelated existing overlay.
      const descriptor = Object.getOwnPropertyDescriptor(tui, "hideOverlay");
      tui.hideOverlay = () => handle?.hide();
      try { done(result); } finally {
        if (descriptor) Object.defineProperty(tui, "hideOverlay", descriptor);
        else delete (tui as unknown as { hideOverlay?: unknown }).hideOverlay;
      }
    }), {
      ...options,
      onHandle(next) { handle = next; options.onHandle?.(next); },
    }) as ReturnType<Custom>;
  } as Custom;

  const owner = {
    dispose() {
      if (!active) return;
      active = false;
      if (host.showExtensionCustom === installed) host.showExtensionCustom = original;
      if (host[KEY] === owner) delete host[KEY];
    },
  };
  host.showExtensionCustom = installed;
  host[KEY] = owner;
  return () => owner.dispose();
}

export function registerCustomOverlayClose(pi: ExtensionAPI): void {
  const dispose = installCustomOverlayClose();
  pi.on("session_shutdown", () => dispose());
}
