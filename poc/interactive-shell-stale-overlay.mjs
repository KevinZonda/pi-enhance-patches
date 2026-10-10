// Run: node poc/interactive-shell-stale-overlay.mjs
// Installed shell overlay + real /bin/sh PTY + native Pi custom-dialog/TUI lifecycle.
// No sudo, VPN, model calls, real session changes, or installation edits.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { InteractiveMode, initTheme } from '@earendil-works/pi-coding-agent';
import { TuiAltScreen, TuiMainScreen, matchesKey, isKeyRelease, isKeyRepeat, stripTerminalSequences } from '@earendil-works/pi-tui';
import { KeybindingsManager } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js';
import { theme } from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { installCustomOverlayClose } from '../extensions/pi-custom-overlay/overlay-close.ts';

const installedRoot = process.env.PI_INTERACTIVE_SHELL_TEST_DIR
  ?? join(homedir(), '.pi/agent/npm/node_modules/pi-interactive-shell');
const outputDir = mkdtempSync(join(tmpdir(), 'pi-shell-overlay-poc-'));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(outputDir, 'agent');
mkdirSync(process.env.PI_CODING_AGENT_DIR);
// Plain Node needs the peers Pi normally supplies, and TS parameter properties transformed.
const peers = new Map(['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui']
  .map(name => [name, import.meta.resolve(name)]));
const hook = registerHooks({
  resolve(specifier, context, next) { return next(peers.get(specifier) ?? specifier, context); },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts') && fileURLToPath(url).startsWith(installedRoot + '/')) {
      return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
      }).outputText };
    }
    return next(url, context);
  },
});
const load = name => import(pathToFileURL(join(installedRoot, name)).href);
const { InteractiveShellOverlay } = await load('overlay-component.ts');
const { ReattachOverlay } = await load('reattach-overlay.ts');
const { PtyTerminalSession } = await load('pty-session.ts');
const { InteractiveShellCoordinator } = await load('runtime-coordinator.ts');
const { loadConfig } = await load('config.ts');
initTheme('dark');
const config = loadConfig(outputDir);
const metadata = {
  shellPackage: JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8')).version,
  piPackage: JSON.parse(readFileSync(new URL('../node_modules/@earendil-works/pi-coding-agent/package.json', import.meta.url), 'utf8')).version,
  node: process.version, platform: process.platform, installedRoot,
  hashes: Object.fromEntries(['overlay-component.ts', 'reattach-overlay.ts', 'pty-session.ts'].map(name =>
    [name, createHash('sha256').update(readFileSync(join(installedRoot, name))).digest('hex')])),
};
const results = [];
const command = "printf 'Password:\\nSorry, try again.\\nPassword:\\nSorry, try again.\\nPassword:\\nsudo: 3 incorrect password attempts\\n'; exit 1";
const shellConfig = { shell: '/bin/sh', args: ['-c'] };

async function until(predicate, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timeout: ${description}`);
    await delay(10);
  }
}

async function probe({ fullscreen, action, reattach = false, scopedClose = false }) {
  const name = `${fullscreen ? 'fullscreen' : 'main'}-${reattach ? 'reattach' : 'new'}-${action}${scopedClose ? '-scoped' : ''}`;
  const events = [];
  const record = (event, details = {}) => events.push({ at: Date.now(), event, ...details });
  let input;
  let terminalOutput = '';
  const terminal = {
    columns: 120, rows: 40, kittyProtocolActive: true,
    start(onInput) { input = onInput; }, stop() {},
    write(text) { terminalOutput += text; },
    hideCursor() {}, showCursor() {}, moveBy() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
    setTitle() {}, setProgress() {}, setProgramStatus() {},
  };
  const tui = fullscreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
  const editorKeys = [];
  const editor = { focused: false, getText: () => '', setText() {}, render: () => ['Editor ready'], invalidate() {},
    handleInput(data) { editorKeys.push(data); record('editor-input', { hex: Buffer.from(data).toString('hex') }); } };
  tui.addChild(editor);
  const host = Object.assign(Object.create(InteractiveMode.prototype), {
    ui: tui, editor, keybindings: new KeybindingsManager(),
    editorContainer: { clear() {}, addChild() {} },
  });
  const disposePatch = scopedClose ? installCustomOverlayClose(host) : () => {};
  const coordinator = new InteractiveShellCoordinator();
  coordinator.beginOverlay();
  let component, handle, session, coverHandle, settled = false, value;
  // Same focus listener as installed index.ts, without loading unrelated tools or models.
  const removeInput = tui.addInputListener(data => {
    record('terminal-input', { hex: Buffer.from(data).toString('hex'), overlayOpen: coordinator.isOverlayOpen() });
    if (!coordinator.isOverlayOpen() || isKeyRelease(data) || isKeyRepeat(data)) return undefined;
    if (matchesKey(data, config.focusShortcut)) {
      if (coordinator.isOverlayFocused()) coordinator.unfocusOverlay();
      else coordinator.focusOverlay();
      record('focus-toggle', { focused: coordinator.isOverlayFocused() });
      return { consume: true };
    }
    return undefined;
  });
  try {
    tui.start();
    tui.setFocus(editor);
    if (reattach) {
      session = new PtyTerminalSession({ command, shellConfig, cwd: outputDir, cols: 110, rows: 16 }, {});
      await until(() => session.exited, 'real PTY exit before reattach');
    }
    const promise = host.showExtensionCustom((realTui, realTheme, _keys, nativeDone) => {
      const done = result => {
        record('done', { exitCode: result.exitCode });
        nativeDone(result);
      };
      component = reattach
        ? new ReattachOverlay(realTui, realTheme, { id: name, command, session }, config, done, () => coordinator.unfocusOverlay())
        : new InteractiveShellOverlay(realTui, realTheme, {
          command, shellConfig, cwd: outputDir, mode: 'interactive', reason: 'PoC: simulated sudo failure, no sudo invocation',
          onUnfocus: () => coordinator.unfocusOverlay(),
        }, config, done);
      session ??= component.session;
      const handleInput = component.handleInput.bind(component);
      component.handleInput = data => {
        record('shell-input', { hex: Buffer.from(data).toString('hex'), finished: component.finished });
        handleInput(data);
      };
      const dispose = component.dispose.bind(component);
      component.dispose = () => { record('dispose'); dispose(); };
      return component;
    }, {
      overlay: true,
      overlayOptions: { width: `${config.overlayWidthPercent}%`, maxHeight: `${config.overlayHeightPercent}%`,
        anchor: config.overlayAnchor, margin: 1, nonCapturing: true },
      onHandle(next) { handle = next; coordinator.setOverlayHandle(handle); handle.focus(); },
    }).then(result => { settled = true; value = result; coordinator.endOverlay(); record('promise-settled'); });
    await until(() => handle && component.state === 'exited', 'shell exit overlay');
    assert.equal(session.exitCode, 1);
    const initial = component.render(114).map(stripTerminalSequences).join('\n');
    assert.match(initial, /sudo: 3 incorrect password attempts/);
    if (action === 'auto') {
      await until(() => settled, 'natural 10-second auto close', 12000);
    } else {
      // The reported frame showed 9 seconds; wait for the real first timer tick.
      await until(() => component.exitCountdown === 9, 'countdown 10 -> 9');
      if (action === 'covered-key' || action === 'covered-auto') {
        const cover = { render: () => ['Another extension overlay'], invalidate() {}, handleInput() {} };
        coverHandle = tui.showOverlay(cover, { width: 30, nonCapturing: true });
        assert.equal(tui.getFocusedComponent(), component, 'shell remains focused below non-capturing cover');
      }
      if (action === 'covered-auto') {
        await until(() => settled, 'covered natural auto close', 12000);
      } else if (action === 'focus') {
        input('\x1b[102;4u'); // Kitty Alt+Shift+F
        assert.equal(tui.getFocusedComponent(), editor, 'Alt+Shift+F unfocuses the live overlay');
        input('\x1b[102;4u');
        assert.equal(tui.getFocusedComponent(), component, 'Alt+Shift+F refocuses the live overlay');
        input('\r');
      } else {
        input(action === 'kitty-enter' ? '\x1b[13;1:1u' : action === 'ctrl-t' ? '\x14' : '\r');
      }
      await until(() => settled, 'close callback resolves tool');
    }
    await promise;
    await delay(50);
    assert.equal(value.exitCode, 1);
    const stale = tui.overlayStack.some(entry => entry.component === component);
    const beforeRetry = component.exitCountdown;
    if (stale) {
      assert.equal(scopedClose, false);
      assert.equal(component.finished, true);
      assert.equal(component.countdownInterval, null, 'disposed shell has no countdown timer');
      assert.equal(coordinator.isOverlayOpen(), false, 'extension coordinator thinks overlay is closed');
      const frame = component.render(114).map(stripTerminalSequences).join('\n');
      writeFileSync(join(outputDir, `${name}-stale.txt`), frame);
      input('\r'); input('\x14'); input('\x1b[102;4u');
      await delay(1150);
      assert.equal(component.exitCountdown, beforeRetry, 'countdown frozen after native done');
      assert.ok(tui.overlayStack.some(entry => entry.component === component), 'Enter/Ctrl+T/focus shortcut fail to close stale shell');
      assert.equal(tui.getFocusedComponent(), component, 'stale shell traps input');
      assert.equal(editorKeys.length, 0);
    } else {
      if (coverHandle) {
        assert.equal(tui.overlayStack.length, 1, 'scoped closure preserves other overlay');
        coverHandle.hide();
      }
      assert.equal(tui.hasOverlayEntries, false);
      assert.equal(tui.getFocusedComponent(), editor);
      input('p');
      assert.deepEqual(editorKeys, ['p']);
    }
    assert.equal(stale, (action === 'covered-key' || action === 'covered-auto') && !scopedClose);
    const result = { name, stale, exitCountdown: beforeRetry, finished: component.finished,
      countdownActive: component.countdownInterval !== null, coordinatorOpen: coordinator.isOverlayOpen(), events };
    results.push(result);
    writeFileSync(join(outputDir, `${name}-terminal.log`), terminalOutput);
    console.log(`${name.padEnd(44)} ${stale ? 'REPRODUCED: stale shell traps keys, countdown frozen' : 'CLOSED: editor receives input'}`);
  } finally {
    removeInput();
    handle?.hide(); coverHandle?.hide(); component?.dispose(); session?.dispose(); tui.stop();
    disposePatch();
  }
}

try {
  for (const fullscreen of [false, true]) {
    for (const action of ['enter', 'kitty-enter', 'ctrl-t', 'focus', 'auto', 'covered-key', 'covered-auto']) {
      await probe({ fullscreen, action });
    }
    await probe({ fullscreen, action: 'covered-key', scopedClose: true });
    await probe({ fullscreen, action: 'covered-auto', scopedClose: true });
    await probe({ fullscreen, action: 'enter', reattach: true });
    await probe({ fullscreen, action: 'covered-key', reattach: true });
    await probe({ fullscreen, action: 'covered-key', reattach: true, scopedClose: true });
  }
  writeFileSync(join(outputDir, 'results.json'), JSON.stringify({ metadata, results }, null, 2));
  console.log(`Evidence: ${outputDir}`);
  console.log('Overlay-stack overlap reproduces the symptom. This does not prove another overlay was present in the killed session.');
} finally {
  hook.deregister();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
}
