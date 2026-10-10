// Run: node poc/interactive-shell-abort.mjs [--baseline]
// Loads a disposable copy of the installed plugin and executes its real tool.
// No model calls, sudo, VPN, or changes to real sessions/installations.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import ts from 'typescript';
import { InteractiveMode, initTheme } from '@earendil-works/pi-coding-agent';
import { TuiAltScreen, TuiMainScreen } from '@earendil-works/pi-tui';
import { CustomEditor } from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-editor.js';
import { getEditorTheme } from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { KeybindingsManager } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js';
import { installCustomOverlayClose } from '../extensions/pi-custom-overlay/overlay-close.ts';

const baseline = process.argv.includes('--baseline');
const root = process.env.PI_INTERACTIVE_SHELL_TEST_DIR ?? join(homedir(), '.pi/agent/npm/node_modules/pi-interactive-shell');
const work = realpathSync(mkdtempSync(join(tmpdir(), 'pi-shell-abort-poc-')));
const target = join(work, 'plugin');
cpSync(root, target, { recursive: true });
const patch = fileURLToPath(new URL('../patches/pi-interactive-shell-0.17.0-abort.patch', import.meta.url));
try { execFileSync('git', ['apply', '--reverse', '--check', patch], { cwd: target, stdio: 'ignore' });
  execFileSync('git', ['apply', '--reverse', patch], { cwd: target }); } catch {}
if (!baseline) execFileSync('git', ['apply', patch], { cwd: target });
const priorAgent = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(work, 'agent');
mkdirSync(process.env.PI_CODING_AGENT_DIR);
const peers = new Map(['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']
  .map(name => [name, import.meta.resolve(name)]));
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (peers.has(specifier)) return next(peers.get(specifier), context);
    if (!specifier.startsWith('.') && !specifier.startsWith('/') && context.parentURL?.startsWith(pathToFileURL(target + '/').href)) {
      return next(specifier, { ...context, parentURL: context.parentURL.replace(pathToFileURL(target).href, pathToFileURL(root).href) });
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.ts') && url.startsWith(pathToFileURL(target + '/').href)) {
      return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
      }).outputText };
    }
    return next(url, context);
  },
});
const load = name => import(pathToFileURL(join(target, name)).href);
const { default: plugin, waitForSessionCompletion } = await load('index.ts');
const { sessionManager } = await load('session-manager.ts');
const { PtyTerminalSession } = await load('pty-session.ts');
const { InteractiveShellOverlay } = await load('overlay-component.ts');
const { HeadlessDispatchMonitor } = await load('headless-monitor.ts');
const tools = new Map(); const handlers = new Map();
plugin({ registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, registerShortcut() {},
  on(event, listener) { handlers.set(event, listener); }, events: { emit() {} }, sendMessage() {} });
const execute = tools.get('interactive_shell').execute;
initTheme('dark');

async function until(check, label) {
  for (let i = 0; i < 300; i++) { if (check()) return; await delay(5); }
  throw new Error(`Timeout: ${label}`);
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('cancel did not return within 500ms')), 500); })]); }
  finally { clearTimeout(timer); }
}
function uiHost(fullscreen, controller) {
  let input, overlayHandle;
  const terminal = { columns: 120, rows: 40, kittyProtocolActive: true, start(fn) { input = fn; }, stop() {}, write() {}, hideCursor() {}, showCursor() {} };
  const tui = fullscreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
  tui.requestRender = () => {}; tui.requestImmediateRender = () => {};
  const editor = new CustomEditor(tui, getEditorTheme(), new KeybindingsManager());
  const host = Object.assign(Object.create(InteractiveMode.prototype), { ui: tui, defaultEditor: editor, editor,
    keybindings: new KeybindingsManager(), editorContainer: { clear() {}, addChild() {} },
    clearAllQueues: () => ({ steering: [], followUp: [] }), updatePendingMessagesDisplay() {} });
  Object.defineProperty(host, 'session', { value: { isStreaming: true, abort() { controller.abort(); } } });
  const restore = installCustomOverlayClose(host);
  host.setupKeyHandlers(); tui.addChild(editor); tui.start(); tui.setFocus(editor);
  const ctx = { hasUI: true, mode: 'tui', cwd: work, isProjectTrusted: () => true, sessionManager: { getSessionId: () => 'poc' },
    ui: { custom: (factory, options) => host.showExtensionCustom(factory, { ...options,
      onHandle(handle) { overlayHandle = handle; options?.onHandle?.(handle); } }), confirm: async () => true, select: async () => undefined } };
  return { ctx, tui, editor, input: data => input(data), unfocus: () => overlayHandle.unfocus(), dispose() { restore(); tui.stop(); } };
}

try {
  // Actual tool query: cancelling a rate-limited read must not kill its process.
  const callbacks = new Set(); let killed = 0; let reads = 0;
  const session = { id: 'query-poc', command: 'test', getResult: () => undefined, getStatus: () => 'running', getRuntime: () => 1,
    getOutput(options) { reads++; return options?.skipRateLimit ? { output: 'alive', totalBytes: 5, truncated: false } : { rateLimited: true, waitSeconds: 1 }; },
    onComplete(cb) { callbacks.add(cb); return () => callbacks.delete(cb); }, kill() { killed++; }, write() {}, background() {} };
  sessionManager.registerActive(session);
  const controller = new AbortController();
  const h = uiHost(true, controller);
  let settled = false;
  const pending = execute('query', { sessionId: session.id }, controller.signal, undefined, h.ctx).then(
    result => { settled = true; return { result }; }, error => { settled = true; return { error }; });
  await until(() => callbacks.size > 0, 'query waiting');
  const start = performance.now(); h.input('\x1b');
  if (baseline) {
    await delay(100); assert.equal(settled, false, 'baseline ignores Esc cancellation');
    for (const callback of [...callbacks]) callback();
    assert.ok((await pending).result);
    console.log('BASELINE REPRODUCED: Esc reaches abort but tool query stays pending');
  } else {
    const outcome = await bounded(pending);
    assert.equal(outcome.error?.name, 'AbortError');
    assert.equal(callbacks.size, 0); assert.equal(reads, 1, 'no late drain/read after abort');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    console.log(`PATCHED: native fullscreen Esc cancels real query in ${Math.round(performance.now() - start)}ms; process preserved; callbacks/listeners cleared`);
  }
  assert.equal(killed, 0); sessionManager.unregisterActive(session.id, true); h.dispose();

  if (!baseline) {
    for (const fullscreen of [false, true]) {
      // Actual PTY, tool attach, native editor Esc -> tool AbortSignal -> shell kill/close.
      const abort = new AbortController(); const host = uiHost(fullscreen, abort);
      const pty = new PtyTerminalSession({ command: "printf 'POC_READY\\n'; sleep 30", shellConfig: { shell: '/bin/sh', args: ['-c'] }, cwd: work, cols: 100, rows: 20 });
      await until(() => pty.getViewportLines().join('\n').includes('POC_READY'), 'test process ready');
      const pid = pty.pid;
      const id = sessionManager.add('sleep 30', pty, 'blocking-poc', undefined, { noAutoCleanup: true });
      try {
        const response = execute('attach', { attach: id }, abort.signal, undefined, host.ctx);
        await until(() => host.tui.hasOverlayEntries, 'blocking attach');
        const shell = host.tui.getFocusedComponent();
        const cover = { render: () => ['Other overlay'], invalidate() {} };
        const coverHandle = host.tui.showOverlay(cover, { nonCapturing: true });
        host.unfocus(); // Same handle operation as Alt+Shift+F: Esc reaches Pi instead of the child.
        host.input('\x1b[27;1:1u');
        const result = await bounded(response);
        assert.equal(result.details.cancelled, true);
        assert.ok(!host.tui.overlayStack.some(entry => entry.component === shell));
        assert.ok(host.tui.overlayStack.some(entry => entry.component === cover));
        assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
        assert.equal(shell.finished, true); assert.equal(shell.countdownInterval, null);
        await until(() => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } }, 'cancelled test process actually exited');
        coverHandle.hide(); assert.equal(host.tui.getFocusedComponent(), host.editor);
        console.log(`PATCHED ${fullscreen ? 'fullscreen' : 'main'}: native Esc cancels blocking PTY attach; only own overlay removed`);
      } finally { pty.dispose(); sessionManager.unregisterActive(id, true); sessionManager.remove(id); host.dispose(); }
    }
    // A completed non-blocking attach must outlive the old call's AbortSignal.
    const abort = new AbortController(); const host = uiHost(true, abort);
    const pty = new PtyTerminalSession({ command: "printf 'POC_READY\\n'; sleep 30", shellConfig: { shell: '/bin/sh', args: ['-c'] }, cwd: work, cols: 100, rows: 20 });
    await until(() => pty.getViewportLines().join('\n').includes('POC_READY'), 'nonblocking process ready');
    const id = sessionManager.add('sleep 30', pty, 'nonblocking-poc', undefined, { noAutoCleanup: true });
    try {
      const result = await execute('nonblocking', { attach: id, mode: 'hands-free' }, abort.signal, undefined, host.ctx);
      assert.equal(result.details.status, 'running');
      await until(() => host.tui.hasOverlayEntries, 'nonblocking attach');
      abort.abort(); await delay(30);
      assert.equal(pty.exited, false); assert.equal(host.tui.hasOverlayEntries, true);
      assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
      host.tui.getFocusedComponent().killSession();
      console.log('PATCHED: completed non-blocking attach survives cancellation of its old tool call');
    } finally { pty.dispose(); sessionManager.unregisterActive(id, true); sessionManager.remove(id); host.dispose(); }

    // Exercise completion/abort races and verify long timers do not keep this process alive.
    for (const outcome of ['abort', 'complete', 'timeout', 'sync-complete']) {
      const abort = new AbortController(); const callbacks = new Set();
      const live = { onComplete(cb) { if (outcome === 'sync-complete') cb(); else callbacks.add(cb); return () => callbacks.delete(cb); } };
      const promise = waitForSessionCompletion(live, outcome === 'timeout' ? 10 : 60000, abort.signal).catch(error => error);
      if (outcome === 'abort') abort.abort();
      if (outcome === 'complete') for (const cb of [...callbacks]) cb();
      const value = await bounded(promise);
      if (outcome === 'abort') assert.equal(value.name, 'AbortError'); else assert.equal(value, outcome !== 'timeout');
      assert.equal(callbacks.size, 0); assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
    }
    for (const Class of [InteractiveShellOverlay, HeadlessDispatchMonitor]) {
      const owner = Object.assign(Object.create(Class.prototype), { completeCallbacks: [], completionResult: undefined, result: undefined });
      let calls = 0; let remove;
      remove = owner.registerCompleteCallback(() => { calls++; remove(); });
      owner.registerCompleteCallback(() => { calls++; });
      owner.triggerCompleteCallbacks();
      assert.equal(calls, 2, 'self-unsubscription must not skip another waiter');
    }
    console.log('PATCHED: completion/abort/timeout races release subscriptions and 60-second timers; concurrent waiters all notified');
    const already = new AbortController(); already.abort();
    await assert.rejects(execute('aborted', { sessionId: 'not-created' }, already.signal, undefined, { ui: {} }), { name: 'AbortError' });
  }
  console.log(baseline ? 'Baseline assertions passed.' : 'All cancellation PoC assertions passed.');
} finally {
  await handlers.get('session_shutdown')?.({ reason: 'exit' });
  hook.deregister();
  if (priorAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgent;
  rmSync(work, { recursive: true, force: true });
}
