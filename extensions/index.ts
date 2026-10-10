import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPermissionSystemPatches } from "./pi-permission-system/index.ts";
import { registerAskUserQuestionPatches } from "./rpiv-ask-user-question/index.ts";
import { registerImagePastePatches } from "./pi-image-paste/index.ts";
import { registerBackgroundTaskPatches } from "./pi-background-tasks/index.ts";
import { registerSubagentPatches } from "./gotgenes-pi-subagents/index.ts";
import { registerCompactWhenAway } from "./compact-when-away/compact.ts";
import { loadConfig } from "./config.ts";
import { registerSettings } from "./settings.ts";
import { registerCustomOverlayClose } from "./pi-custom-overlay/overlay-close.ts";

export default function enhancePatches(pi: ExtensionAPI): void {
  const path = join(getAgentDir(), "pi-enhance-patches.json");
  const { config, warning } = loadConfig(path);
  if (warning) pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.notify(warning, "warning");
    else console.error(warning);
  });
  registerPermissionSystemPatches(pi);
  registerCustomOverlayClose(pi);
  registerAskUserQuestionPatches(pi, config);
  registerImagePastePatches(pi, config.imagePasteEnabled);
  registerBackgroundTaskPatches(pi, config.backgroundTaskAutopatchEnabled);
  registerSubagentPatches(pi, config.subagentNotificationAutopatchEnabled);
  registerCompactWhenAway(pi, config);
  registerSettings(pi, config, path);
}
