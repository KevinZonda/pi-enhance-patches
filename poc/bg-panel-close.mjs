// Run: node poc/bg-panel-close.mjs
// Uses installed production code; never starts/kills tasks or changes the installation.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

const root = process.env.PI_BACKGROUND_TASKS_TEST_DIR ?? join(getAgentDir(), 'npm/node_modules/pi-background-tasks');
// Pi supplies these peer dependencies to extensions; plain Node needs the same mapping.
const peers = new Map(['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui']
  .map(name => [name, import.meta.resolve(name)]));
const peerHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (peers.has(specifier)) {
      return nextResolve(peers.get(specifier), context);
    }
    return nextResolve(specifier, context);
  },
});
const { BackgroundTasksManager } = await import(pathToFileURL(join(root, 'dist/src/ui/background-tasks-manager.js')));
const { TuiMainScreen, parseKey } = await import('@earendil-works/pi-tui');
peerHook.deregister();
const overlayOptions = {
  anchor: 'bottom-center', width: '96%', minWidth: 64,
  maxHeight: '60%', margin: { bottom: 1, left: 1, right: 1 },
};
const theme = { fg: (_color, text) => text };
const task = {
  id: 'poc-task', name: 'Panel close PoC', command: 'true', status: 'completed',
  exitCode: 0, startTime: 0, endTime: 1000,
  outputPath: '/nonexistent/bg-panel-poc.log', outputAbsPath: '/nonexistent/bg-panel-poc.log',
};

function probe(mode, data, normalize = false) {
  let input;
  const terminal = {
    columns: 120, rows: 24, kittyProtocolActive: true,
    start(onInput) { input = onInput; },
    stop() {}, write() {}, hideCursor() {}, showCursor() {},
  };
  const tui = new TuiMainScreen(terminal);
  // Keep real input/focus/overlay routing; suppress terminal drawing and render scheduling.
  tui.requestRender = () => {};
  tui.requestImmediateRender = () => {};
  let closed = false;
  let delivered;
  const manager = new BackgroundTasksManager(tui, theme, () => {
    closed = true;
    tui.hideOverlay();
  }, {
    initialTaskId: mode === 'detail' ? task.id : undefined,
    getTasks: () => [task], stopTask: async () => {},
    stopAllRunning: async () => ({ stopped: 0, failures: [] }),
    rerunTask: async () => task, showOutputPath() {}, markSeen() {},
    markFinishedSeen() {}, isSeen: () => false,
  });
  const original = manager.handleInput.bind(manager);
  manager.handleInput = (raw) => {
    delivered = raw;
    // Candidate fix ONLY in this PoC: decode close letters with the TUI key parser.
    const closeKey = parseKey(raw);
    original(normalize && ['q', 'x', 'Q', 'X', 'shift+q', 'shift+x'].includes(closeKey)
      ? closeKey.slice(-1) : raw);
  };
  try {
    tui.start();
    tui.showOverlay(manager, overlayOptions);
    assert.equal(tui.getFocusedComponent(), manager, 'overlay owns keyboard focus');
    input(data);
    assert.equal(delivered, data, 'real TUI delivers the unchanged key event to the panel');
    assert.equal(tui.hasOverlayEntries, !closed, 'close callback removes the overlay');
    return closed;
  } finally {
    manager.dispose();
    tui.stop();
  }
}

const cases = [
  ['plain q', 'q', true], ['plain x', 'x', true],
  ['plain Q', 'Q', true], ['plain X', 'X', true],
  ['Kitty q press', '\x1b[113;1:1u', false],
  ['Kitty x press', '\x1b[120;1:1u', false],
  ['CSI-u q', '\x1b[113u', false], ['CSI-u x', '\x1b[120u', false],
  ['modifyOtherKeys q', '\x1b[27;1;113~', false],
  ['modifyOtherKeys x', '\x1b[27;1;120~', false],
  ['Kitty Shift+Q', '\x1b[113;2u', false],
  ['Kitty Shift+X', '\x1b[120;2u', false],
  ['plain Escape', '\x1b', true], ['Kitty Escape', '\x1b[27;1:1u', true],
];

let reproduced = 0;
for (const mode of ['list', 'detail']) {
  for (const [label, data, expected] of cases) {
    const closed = probe(mode, data);
    assert.equal(closed, expected, `${mode}: ${label}`);
    assert.equal(probe(mode, data, true), true, `candidate normalization: ${mode}: ${label}`);
    if (!closed) reproduced++;
    console.log(`${mode.padEnd(6)} ${label.padEnd(20)} parsed=${String(parseKey(data)).padEnd(8)} ${closed ? 'CLOSED' : 'STUCK '} raw=${JSON.stringify(data)}`);
  }
}
assert.equal(reproduced, 16);
console.log(`\nConfirmed ${reproduced} stuck cases in installed production code; candidate normalization closes all ${cases.length * 2} cases.`);
console.log('This proves a protocol-dependent bug, not which bytes your actual terminal sends. No production files changed.');
