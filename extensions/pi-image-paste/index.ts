import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir, InteractiveMode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { IMAGE_ENTRY, IMAGE_MARKER, ImageAttachments, installImagePaste, type Attachment, type Clipboard, type PastePrototype } from "./image-paste.ts";

async function loadClipboard(): Promise<Clipboard> {
  // Pi exposes neither clipboard reads nor its paste hook as public extension APIs.
  const root = pathToFileURL(join(getPackageDir(), "dist", "index.js"));
  const [files, images, mime] = await Promise.all([
    import(new URL("./utils/clipboard.js", root).href),
    import(new URL("./utils/clipboard-image.js", root).href),
    import(new URL("./utils/mime.js", root).href),
  ]);
  return {
    readClipboardFilePaths: files.readClipboardFilePaths,
    readClipboardImage: images.readClipboardImage,
    async detectSupportedImageMimeTypeFromFile(path) {
      try { return await mime.detectSupportedImageMimeTypeFromFile(path) ?? undefined; }
      catch { return undefined; } // Leave directories and unreadable non-image files to native paste.
    },
    saveImage(bytes, mimeType) {
      const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.${images.extensionForImageMimeType(mimeType) ?? "png"}`);
      writeFileSync(path, bytes, { mode: 0o600 });
      return path;
    },
  };
}

function isAttachment(value: unknown): value is Attachment {
  if (!value || typeof value !== "object") return false;
  const image = value as Attachment;
  return Number.isSafeInteger(image.id) && image.id > 0 && typeof image.path === "string" &&
    typeof image.mimeType === "string" && image.mimeType.startsWith("image/");
}

export function registerImagePastePatches(pi: ExtensionAPI): void {
  let attachments = new ImageAttachments();
  let dispose: (() => void) | undefined;
  pi.on("session_start", async (_event, ctx) => {
    dispose?.();
    dispose = undefined;
    attachments = new ImageAttachments();
    if (ctx.mode !== "tui") return;
    attachments = new ImageAttachments(ctx.sessionManager.getEntries()
      .filter(entry => entry.type === "custom" && entry.customType === IMAGE_ENTRY)
      .map(entry => (entry as { data?: unknown }).data).filter(isAttachment));
    try {
      const clipboard = await loadClipboard();
      // SAFETY: Pi 1.1.0's private paste method uses this host shape; installer checks the method exists.
      dispose = installImagePaste(InteractiveMode.prototype as unknown as PastePrototype,
        clipboard, ctx.sessionManager.getSessionId(), attachments, image => pi.appendEntry(IMAGE_ENTRY, image));
    } catch (error) {
      ctx.ui.notify(`Image paste patch unavailable; using native paste: ${String(error)}`, "warning");
    }
  });
  pi.on("input", (event, ctx) => {
    if (ctx.mode !== "tui" || event.source !== "interactive" || !event.text.match(IMAGE_MARKER)) return;
    try {
      const images = attachments.resolve(event.text);
      if (ctx.model && !ctx.model.input.includes("image")) throw new Error("Current model does not support images. Select an image-capable model first.");
      return { action: "transform", text: event.text, images: [...(event.images ?? []), ...images] };
    } catch (error) {
      ctx.ui.notify(`Cannot send image: ${error instanceof Error ? error.message : String(error)}`, "error");
      ctx.ui.setEditorText(event.text);
      return { action: "handled" };
    }
  });
  pi.on("session_shutdown", () => { dispose?.(); dispose = undefined; });
}
