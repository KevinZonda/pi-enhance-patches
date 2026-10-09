import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { CompactOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCompactWhenAway } from "../extensions/compact-when-away/compact.ts";
import { normalizeConfig } from "../extensions/config.ts";

const TEN_MINUTES = 600_000;

function harness(t: TestContext, options: Record<string, unknown> = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => void>>();
  let input: (() => unknown) | undefined;
  let unsubscribed = 0;
  const calls: CompactOptions[] = [];
  const notices: string[] = [];
  const state = { tokens: 128_000 as number | null, contextWindow: 200_000, idle: true, pending: false, draft: "" };
  const ctx = {
    mode: "tui", hasUI: true,
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
    getContextUsage: () => ({ tokens: state.tokens, contextWindow: state.contextWindow }),
    compact: (options: CompactOptions) => { calls.push(options); },
    ui: {
      notify: (message: string) => { notices.push(message); },
      getEditorText: () => state.draft,
      onTerminalInput: (handler: () => unknown) => {
        input = handler;
        return () => { input = undefined; unsubscribed++; };
      },
    },
  } as unknown as ExtensionContext;
  registerCompactWhenAway({
    on(name: string, handler: (event: any, ctx: ExtensionContext) => void) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  } as unknown as ExtensionAPI, normalizeConfig({ compactWhenAwayEnabled: true, ...options }));
  const fire = (name: string, event: unknown = {}, context = ctx) => {
    for (const handler of handlers.get(name) ?? []) handler(event, context);
  };
  fire("session_start");
  t.after(() => fire("session_shutdown"));
  return {
    ctx, state, calls, notices, fire,
    type: () => input?.(),
    tick: (ms: number) => t.mock.timers.tick(ms),
    finish: () => { fire("agent_start"); fire("agent_settled", { aborted: false }); },
    get unsubscribed() { return unsubscribed; },
  };
}

test("away compaction defaults are opt-in, 128,000 tokens and 10 minutes", () => {
  const defaults = normalizeConfig({});
  assert.equal(defaults.compactWhenAwayEnabled, false);
  assert.equal(defaults.compactWhenAwayThresholdKind, "count");
  assert.equal(defaults.compactWhenAwayThresholdRatio, 0.7);
  assert.equal(defaults.compactWhenAwayThresholdTokens, 128_000);
  assert.equal(defaults.compactWhenAwayIdleMinutes, 10);
  for (const invalid of [0, -1, NaN, Infinity, "10", null]) {
    const config = normalizeConfig({ compactWhenAwayThresholdTokens: invalid, compactWhenAwayIdleMinutes: invalid });
    assert.equal(config.compactWhenAwayThresholdTokens, 128_000);
    assert.equal(config.compactWhenAwayIdleMinutes, 10);
  }
  assert.equal(normalizeConfig({ compactWhenAwayIdleMinutes: 999999 }).compactWhenAwayIdleMinutes, 1440);
});

test("ratio threshold uses the current model window and includes the boundary", t => {
  const h = harness(t, { compactWhenAwayThresholdKind: "ratio", compactWhenAwayThresholdRatio: 0.8 });
  h.state.tokens = 159_999;
  h.finish();
  h.tick(TEN_MINUTES);
  assert.equal(h.calls.length, 0);
  h.state.tokens = 160_000;
  h.finish();
  h.tick(TEN_MINUTES);
  assert.equal(h.calls.length, 1);
  h.finish();
  h.state.contextWindow = 1_000_000;
  h.tick(TEN_MINUTES);
  assert.equal(h.calls.length, 1, "window is read again at trigger time");
  h.state.tokens = 800_000;
  h.finish();
  h.tick(TEN_MINUTES);
  assert.equal(h.calls.length, 2);
});

test("ratio skips unknown or invalid model windows", t => {
  const h = harness(t, { compactWhenAwayThresholdKind: "ratio" });
  for (const window of [0, -1, NaN, Infinity, undefined]) {
    h.state.contextWindow = window as number;
    h.finish();
    h.tick(TEN_MINUTES);
    assert.equal(h.calls.length, 0);
  }
});

test("ratio and kind validation preserve old count configuration", () => {
  for (const ratio of [0, -1, 1.01, NaN, Infinity, "0.8"]) {
    assert.equal(normalizeConfig({ compactWhenAwayThresholdRatio: ratio }).compactWhenAwayThresholdRatio, 0.7);
  }
  assert.equal(normalizeConfig({ compactWhenAwayThresholdRatio: 1 }).compactWhenAwayThresholdRatio, 1);
  assert.equal(normalizeConfig({ compactWhenAwayThresholdKind: "invalid" }).compactWhenAwayThresholdKind, "count");
  assert.equal(normalizeConfig({ compactWhenAwayThresholdTokens: 150_000 }).compactWhenAwayThresholdKind, "count");
});

test("only a settled run arms compaction; inclusive token/time boundaries", t => {
  const h = harness(t);
  h.tick(TEN_MINUTES);
  assert.equal(h.calls.length, 0, "loading history does not arm");
  h.fire("agent_start");
  h.fire("agent_end");
  h.tick(TEN_MINUTES);
  assert.equal(h.calls.length, 0, "agent_end may precede retries and continuations");
  h.fire("agent_settled", { aborted: false });
  h.tick(TEN_MINUTES - 1);
  assert.equal(h.calls.length, 0);
  h.tick(1);
  assert.equal(h.calls.length, 1);
  h.calls[0].onComplete?.({} as any);
  h.tick(TEN_MINUTES * 2);
  assert.equal(h.calls.length, 1, "no repetition without new dialogue");
  h.finish();
  h.tick(TEN_MINUTES);
  assert.equal(h.calls.length, 2);
});

test("below-threshold and unknown context do not compact; threshold is checked at firing", t => {
  const h = harness(t);
  for (const tokens of [127_999, null, NaN]) {
    h.state.tokens = tokens;
    h.finish();
    h.tick(TEN_MINUTES);
    assert.equal(h.calls.length, 0);
  }
  h.finish();
  h.state.tokens = 128_001;
  h.tick(TEN_MINUTES);
  assert.equal(h.calls.length, 1);
});

test("terminal input resets idle time and is never consumed", t => {
  const h = harness(t);
  h.finish();
  h.tick(TEN_MINUTES - 1);
  assert.equal(h.type(), undefined);
  h.tick(TEN_MINUTES - 1);
  assert.equal(h.calls.length, 0);
  h.tick(1);
  assert.equal(h.calls.length, 1);
});

test("draft, pending messages and a busy runtime defer compaction", t => {
  const h = harness(t);
  h.finish();
  h.state.draft = "unfinished prompt";
  h.tick(TEN_MINUTES);
  assert.equal(h.calls.length, 0);
  h.state.draft = "";
  h.state.pending = true;
  h.tick(1000);
  assert.equal(h.calls.length, 0);
  h.state.pending = false;
  h.state.idle = false;
  h.tick(1000);
  assert.equal(h.calls.length, 0);
  h.state.idle = true;
  h.tick(1000);
  assert.equal(h.calls.length, 1);
});

test("tool execution and blocking UI prompts defer until another full idle period", t => {
  const h = harness(t);
  h.finish();
  h.fire("tool_execution_start", { toolCallId: "a" });
  h.tick(TEN_MINUTES);
  assert.equal(h.calls.length, 0);
  h.fire("tool_execution_end", { toolCallId: "a" });
  h.fire("ui_prompt_start");
  h.tick(TEN_MINUTES);
  assert.equal(h.calls.length, 0);
  h.fire("ui_prompt_end");
  h.tick(TEN_MINUTES - 1);
  assert.equal(h.calls.length, 0);
  h.tick(1);
  assert.equal(h.calls.length, 1);
});

test("submissions, navigation, shell commands and compaction consume the idle period", t => {
  const h = harness(t);
  for (const event of ["input", "session_before_switch", "session_before_fork", "session_before_tree",
    "session_tree", "user_bash", "session_before_compact", "session_compact", "session_compact_failed"]) {
    h.finish();
    h.fire(event);
    h.tick(TEN_MINUTES);
    assert.equal(h.calls.length, 0, event);
  }
  h.fire("agent_settled", { aborted: false });
  h.tick(TEN_MINUTES);
  assert.equal(h.calls.length, 0, "auto-compaction before settlement must not rearm");
  h.fire("agent_start");
  h.fire("agent_settled", { aborted: true });
  h.tick(TEN_MINUTES);
  assert.equal(h.calls.length, 0, "aborted run");
});

test("failures and cancellations do not retry until new dialogue", t => {
  const h = harness(t);
  h.finish();
  h.tick(TEN_MINUTES);
  h.calls[0].onError?.(new Error("Compaction cancelled"));
  h.type();
  h.tick(TEN_MINUTES * 2);
  assert.equal(h.calls.length, 1);
  assert.match(h.notices.at(-1)!, /Compaction cancelled/);
  h.finish();
  h.tick(TEN_MINUTES);
  assert.equal(h.calls.length, 2);
});

test("reload/shutdown cancels timers and unsubscribes input; stale callbacks are ignored", t => {
  const h = harness(t);
  h.finish();
  h.tick(TEN_MINUTES);
  h.fire("session_shutdown");
  const noticeCount = h.notices.length;
  h.calls[0].onError?.(new Error("old session"));
  assert.equal(h.notices.length, noticeCount);
  h.fire("session_start", {}, { ...h.ctx, ui: { ...h.ctx.ui } });
  h.finish();
  h.fire("session_shutdown");
  h.tick(TEN_MINUTES);
  assert.equal(h.calls.length, 1);
  assert.equal(h.unsubscribed, 2);
});

test("disabled feature does not compact", t => {
  const h = harness(t, { compactWhenAwayEnabled: false });
  h.finish();
  h.tick(TEN_MINUTES);
  assert.equal(h.calls.length, 0);
});

test("print, JSON and RPC modes do not compact", t => {
  const enabled = harness(t);
  for (const mode of ["print", "rpc", "json"] as const) {
    enabled.fire("session_start", {}, { ...enabled.ctx, mode });
    enabled.finish();
    enabled.tick(TEN_MINUTES);
  }
  assert.equal(enabled.calls.length, 0);
});

test("a synchronous compaction error consumes the attempt", t => {
  const h = harness(t);
  h.ctx.compact = () => { throw new Error("runtime unavailable"); };
  h.finish();
  h.tick(TEN_MINUTES);
  assert.match(h.notices.at(-1)!, /runtime unavailable/);
  const count = h.notices.length;
  h.type();
  h.tick(TEN_MINUTES);
  assert.equal(h.notices.length, count);
});

test("configured threshold and idle duration are honored", t => {
  const h = harness(t, { compactWhenAwayThresholdTokens: 200_000, compactWhenAwayIdleMinutes: 2 });
  h.state.tokens = 200_000;
  h.finish();
  h.tick(120_000 - 1);
  assert.equal(h.calls.length, 0);
  h.tick(1);
  assert.equal(h.calls.length, 1);
});
