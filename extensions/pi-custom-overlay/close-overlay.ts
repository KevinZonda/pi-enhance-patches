import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";

/** Run Pi's native close against this dialog's handle, then restore its renderer. */
export function closeOverlay<T>(tui: TUI, handle: OverlayHandle | undefined, close: () => T): T {
  // Pi's stable TUI reference forwards method calls with the active renderer as
  // their receiver. Inherited valueOf() returns that receiver. Descriptor/delete
  // operations on the reference itself would instead touch its empty Proxy target.
  // Resolve afresh at close time; do not retain a renderer across mode changes.
  const renderer = tui.valueOf() as TUI;
  const descriptor = Object.getOwnPropertyDescriptor(renderer, "hideOverlay");
  renderer.hideOverlay = () => handle?.hide();
  try {
    return close();
  } finally {
    if (descriptor) Object.defineProperty(renderer, "hideOverlay", descriptor);
    else delete (renderer as unknown as { hideOverlay?: unknown }).hideOverlay;
  }
}
