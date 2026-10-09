import { readFileSync } from "node:fs";
import type { ImageContent } from "@earendil-works/pi-ai";

export const IMAGE_ENTRY = "pi-enhance-patches-image";
export type Attachment = { id: number; path: string; mimeType: string };

export class ImageAttachments {
  readonly images = new Map<number, Attachment>();
  constructor(entries: Attachment[] = []) {
    for (const entry of entries) this.images.set(entry.id, entry);
  }
  add(path: string, mimeType: string): Attachment {
    const id = Math.max(0, ...this.images.keys()) + 1;
    const attachment = { id, path, mimeType };
    this.images.set(id, attachment);
    return attachment;
  }
  resolve(text: string): ImageContent[] {
    const ids = new Set([...text.matchAll(/\[Image #(\d+)\]/g)].map(match => Number(match[1])));
    return [...ids].map(id => {
      const image = this.images.get(id);
      if (!image) throw new Error(`Unknown image attachment [Image #${id}]. Paste the image again.`);
      return { type: "image", data: readFileSync(image.path).toString("base64"), mimeType: image.mimeType };
    });
  }
}

export interface PasteHost {
  editor: { getText(): string; getCursor?(): { line: number; col: number }; insertTextAtCursor?(text: string): void };
  isBashMode: boolean;
  session: { sessionId: string };
  ui: { requestRender(): void };
  showError(message: string): void;
}
export type PastePrototype = { handleClipboardPaste(this: PasteHost): Promise<void> };
export interface Clipboard {
  readClipboardFilePaths(): Promise<string[] | null>;
  readClipboardImage(): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
  detectSupportedImageMimeTypeFromFile(path: string): Promise<string | undefined>;
  saveImage(bytes: Uint8Array, mimeType: string): string;
}
const KEY = Symbol.for("pi.enhance-patches-image.owner");

/** Keep native text/file and shell paste; only image clipboard data becomes a marker. */
export function installImagePaste(prototype: PastePrototype, clipboard: Clipboard, sessionId: string,
  attachments: ImageAttachments, persist: (image: Attachment) => void): () => void {
  const host = prototype as PastePrototype & { [KEY]?: { dispose(): void } };
  host[KEY]?.dispose();
  const original = prototype.handleClipboardPaste;
  if (typeof original !== "function") throw new Error("Incompatible Pi clipboard paste hook");
  let active = true;
  let queue = Promise.resolve();
  const installed = function (this: PasteHost): Promise<void> {
    if (!active || this.session.sessionId !== sessionId || this.isBashMode) return original.call(this);
    const editor = this.editor;
    const paste = async () => {
      try {
        const filePaths = await clipboard.readClipboardFilePaths();
        let parts: Array<{ path: string; mimeType?: string }>;
        if (filePaths?.length) {
          if (filePaths.some(path => /\p{Cc}/u.test(path))) throw new Error("Clipboard file path contains control characters");
          parts = await Promise.all(filePaths.map(async path => ({ path,
            mimeType: await clipboard.detectSupportedImageMimeTypeFromFile(path) })));
          if (!active || this.session.sessionId !== sessionId || this.editor !== editor) return;
          if (!parts.some(part => part.mimeType)) { await original.call(this); return; }
        } else {
          const image = await clipboard.readClipboardImage();
          if (!active || this.session.sessionId !== sessionId || this.editor !== editor) return;
          if (!image) { await original.call(this); return; }
          parts = [{ path: clipboard.saveImage(image.bytes, image.mimeType), mimeType: image.mimeType }];
        }
        if (!active || this.session.sessionId !== sessionId || this.editor !== editor) return;
        const text = parts.map(part => {
          if (!part.mimeType) return part.path;
          const attachment = attachments.add(part.path, part.mimeType);
          persist(attachment);
          return `[Image #${attachment.id}]`;
        }).join("\n");
        const cursor = editor.getCursor?.();
        const line = cursor ? (editor.getText().split("\n")[cursor.line] ?? "") : "";
        const before = cursor && cursor.col > 0 ? line[cursor.col - 1] : "";
        const after = cursor ? line[cursor.col] : "";
        editor.insertTextAtCursor?.(`${before && !/\s/.test(before) ? " " : ""}${text}${after && !/\s/.test(after) ? " " : ""}`);
        this.ui.requestRender();
      } catch (error) {
        this.showError(`Failed to paste image: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    queue = queue.then(paste);
    return queue;
  };
  const owner = { dispose() {
    active = false;
    if (prototype.handleClipboardPaste === installed) prototype.handleClipboardPaste = original;
    if (host[KEY] === owner) delete host[KEY];
  } };
  prototype.handleClipboardPaste = installed;
  host[KEY] = owner;
  return () => owner.dispose();
}
