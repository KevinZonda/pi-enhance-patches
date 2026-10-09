import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installAskTimeout } from "./ask-timeout.ts";
import type { Config } from "../config.ts";

export function registerAskUserQuestionPatches(pi: ExtensionAPI, config: Pick<Config, "askUserTimeoutMs">): void {
  const dispose = config.askUserTimeoutMs > 0 ? installAskTimeout(config.askUserTimeoutMs) : undefined;
  pi.on("session_shutdown", () => dispose?.());
}
