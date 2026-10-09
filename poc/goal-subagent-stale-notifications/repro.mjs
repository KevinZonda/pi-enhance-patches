import assert from 'node:assert/strict';
import { createJiti } from '/Users/kevin/Desktop/cc_plugins/pi-enhance-patches/node_modules/jiti/lib/jiti.mjs';
import { AgentSession } from '/Users/kevin/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js';
const jiti = createJiti(import.meta.url);
const { NotificationManager } = await jiti.import('/Users/kevin/.pi/agent/npm/node_modules/@gotgenes/pi-subagents/src/observation/notification.ts');
const { SubagentState } = await jiti.import('/Users/kevin/.pi/agent/npm/node_modules/@gotgenes/pi-subagents/src/lifecycle/subagent-state.ts');
function child(id) {
  const state = new SubagentState({ status: 'running' });
  return new Proxy(state, { get(target, key) {
    if (key === 'id') return id;
    if (key === 'description') return 'test ' + id;
    if (key === 'getContextPercent') return () => 0;
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
}

// Control: a finished, collected child is filtered while the plugin still owns the queue.
{
  const sent = [];
  const manager = new NotificationManager((message) => sent.push(message));
  const record = child('control');
  manager.onParentAgentStart();
  record.recordUpdate('old progress');
  manager.sendUpdate(record, 'old progress');
  record.markCompleted('done');
  manager.sendCompletion(record);
  record.markConsumed();
  manager.onParentAgentSettled();
  assert.equal(sent.length, 0);
  console.log('PASS control: completed + collected before plugin flush => no notices');
}

// Reuse of a record across runs: the queue stores no run identity.
{
  const sent = [];
  const manager = new NotificationManager((message) => sent.push(message));
  const record = child('resumed');
  manager.onParentAgentStart();
  record.recordUpdate('progress from run 1');
  manager.sendUpdate(record, 'progress from run 1');
  record.markCompleted('run 1 done');
  record.markConsumed();
  record.resetForResume(Date.now());
  manager.onParentAgentSettled();
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /progress from run 1/);
  assert.match(sent[0].content, /still running/);
  console.log('REPRO record reuse: run 1 progress emitted during run 2');
}

// A pending completion also follows the mutable record into a resumed run.
{
  const sent = [];
  const manager = new NotificationManager((message) => sent.push(message));
  const record = child('completion-resumed');
  manager.onParentAgentStart();
  record.markCompleted('run 1 done');
  manager.sendCompletion(record);
  record.markConsumed();
  record.resetForResume(Date.now());
  manager.onParentAgentSettled();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].customType, 'subagent-notification');
  assert.match(sent[0].content, /running<\/summary>/);
  assert.match(sent[0].content, /<result>No output\.<\/result>/);
  console.log('REPRO completion reuse: collected run 1 becomes a completion notice saying running / No output');
}

// Use real Pi sendCustomMessage + _emitAgentSettled; stub only model execution and event plumbing.
{
  const session = Object.create(AgentSession.prototype);
  session._isAgentRunActive = true;
  session._isEmittingAgentSettled = false;
  session._deferredSettledActions = [];
  session._emit = () => {};
  session._resolveIdleWaitIfIdle = () => {};
  const runs = [];
  let record;
  session._runAgentPrompt = async (message) => {
    // First deferred prompt stands in for the parent's acceptance/result collection.
    if (runs.length === 0) {
      record.markCompleted('accepted result');
      record.markConsumed();
    }
    runs.push({ type: message.customType, consumed: record.consumed, content: message.content });
  };
  const manager = new NotificationManager((message, options) => {
    void session.sendCustomMessage(message, options);
  });
  record = child('queued');
  manager.onParentAgentStart();
  for (const text of ['old update A', 'old update B', 'old update C']) {
    record.recordUpdate(text);
    manager.sendUpdate(record, text);
  }
  session._extensionRunner = { emit: async () => {
    // Goal/another extension reserves a continuation before the Subagent listener flushes.
    await session.sendCustomMessage({ customType: 'acceptance', content: 'collect result', display: false }, { triggerTurn: true });
    manager.onParentAgentSettled();
    assert.equal(session._deferredSettledActions.length, 4);
  }};
  await session._emitAgentSettled();
  assert.equal(runs.length, 4);
  assert.equal(record.isActive(), false);
  assert.equal(record.consumed, true);
  assert.deepEqual(runs.slice(1).map(x => x.type), Array(3).fill('subagent-update'));
  assert.ok(runs.slice(1).every(x => x.consumed && /still running/.test(x.content)));
  console.log('REPRO Pi settled queue: result completed + collected, but 3 stale updates still start 3 prompts');
  console.log(JSON.stringify(runs.map(({type, consumed}) => ({type, consumed})), null, 2));
}
