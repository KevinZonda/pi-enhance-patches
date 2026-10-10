import { execFileSync } from "node:child_process";
import test from "node:test";

test("real TUI Proxy: custom/timeout/combined close restores native hide and teardown leaves questionnaires closable in both modes", () => {
  execFileSync(process.execPath, ["poc/ask-proxy-close.ts", "--expect-fixed"], {
    cwd: process.cwd(), timeout: 30000, stdio: "pipe",
  });
});
