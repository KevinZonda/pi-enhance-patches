// Test-only provider for the actual Pi CLI. No HTTP or model API calls.
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const logPath = process.env.PI_POC_LOG;
  if (!logPath) throw new Error("PI_POC_LOG is required");
  const log = (event: string, details: unknown = {}) => appendFileSync(logPath, JSON.stringify({ at: Date.now(), event, details }) + "\n");
  let questionCount = 4;
  let asked = false;
  pi.registerProvider("local-poc", {
    api: "local-poc-api", apiKey: "not-a-real-key", baseUrl: "http://127.0.0.1",
    models: [{ id: "deterministic", name: "Offline PoC", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        const tool = !asked;
        asked = true;
        const message: any = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), stopReason: "pending", content: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        stream.push({ type: "start", partial: message });
        if (tool) {
          const toolCall = { type: "toolCall" as const, id: `poc-${Date.now()}`, name: "ask_user_question", arguments: {
            questions: Array.from({ length: questionCount }, (_, i) => ({ header: ["DeviceName", "Discoverable"][i] ?? `Question ${i + 1}`,
              question: `Local environment question ${i + 1}?`, options: [
                { label: ["系统主机名（Recommended）", "默认关闭（Recommended）"][i] ?? "First (Recommended)", description: "First option" },
                { label: "Second", description: "Second option" },
              ] })),
          } };
          message.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(toolCall.arguments), partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
          message.stopReason = "toolUse";
          log("model-questionnaire", { questionCount });
        } else {
          const text = "POC_TURN_FINISHED: questionnaire returned. Test /poc-ping next.";
          message.content.push({ type: "text", text: "" });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          const chunks = Number(process.env.PI_POC_FOLLOWUP_CHUNKS ?? 0);
          for (let i = 0; i < chunks; i++) {
            const delta = `Offline followup output line ${i + 1}\n`;
            message.content[0].text += delta;
            stream.push({ type: "text_delta", contentIndex: 0, delta, partial: message });
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          message.content[0].text += text;
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: message.content[0].text, partial: message });
          message.stopReason = "stop";
          log("model-followup");
        }
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
  pi.on("session_start", (_event, ctx) => {
    log("session-start", { mode: ctx.mode, tools: pi.getAllTools().map(tool => tool.name) });
    const remove = ctx.ui.onTerminalInput(data => { log("input", { hex: Buffer.from(data).toString("hex") }); return undefined; });
    pi.on("session_shutdown", () => { remove(); log("shutdown"); });
  });
  pi.on("tool_result", event => {
    if (event.toolName !== "ask_user_question") return;
    const details = event.details as any;
    log("questionnaire-result", { timedOut: details?.timedOut, cancelled: details?.cancelled, answerCount: details?.answers?.length });
  });
  pi.on("agent_end", () => log("agent-end"));
  pi.registerCommand("poc-run", { description: "Offline questionnaire environment test", handler: async (args) => {
    const count = Number(args.trim());
    if (![2, 3, 4].includes(count)) throw new Error("Use /poc-run 2, 3, or 4");
    questionCount = count;
    asked = false;
    pi.setActiveTools(["ask_user_question"]);
    log("run", { questionCount });
    pi.sendUserMessage(`Run offline questionnaire with ${count} questions.`);
  } });
  pi.registerCommand("poc-ping", { description: "Check that editor commands still work", handler: async (_args, ctx) => {
    log("ping"); ctx.ui.notify("POC_PING_OK", "info");
  } });
  pi.registerCommand("poc-exit", { description: "Close only this test instance", handler: async (_args, ctx) => ctx.shutdown() });
}
