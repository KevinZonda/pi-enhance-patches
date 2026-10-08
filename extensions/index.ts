import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPermissionSystemPatches } from "./pi-permission-system/index.ts";
import { registerAskUserQuestionPatches } from "./rpiv-ask-user-question/index.ts";

export default function enhancePatches(pi: ExtensionAPI): void {
  registerPermissionSystemPatches(pi);
  registerAskUserQuestionPatches(pi);
}
