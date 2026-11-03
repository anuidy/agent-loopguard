import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness } from '../lab/native-harness.mjs';
import { LoopGuardState } from '../packages/loopguard/lib/guard-state.js';

const parameters = {
  command: { type: 'string' }, description: { type: 'string' }, workdir: { type: 'string' },
  timeoutMs: { type: 'number' }, sandbox_permissions: { type: 'string' },
  justification: { type: 'string' }, run_in_background: { type: 'boolean' }, execution_nonce: { type: 'number' },
};
const args = { command: 'python fixtures/failing_test.py', description: 'Run tests' };
const foreground = (stdout = 'same failure', exitCode = 1, stderr = '') => ({
  kind: 'foreground', cwd: 'fixture', exitCode, signal: null, timedOut: false, aborted: false,
  stdout: { text: stdout, truncated: false }, stderr: { text: stderr, truncated: false },
});

async function harness(t, config) {
  const h = await createHarness({ variant: 'working', config });
  t.after(() => h.dispose());
  return h;
}

test('shell description changes share one operation for both bash and pwsh', async t => {
  for (const tool of ['bash', 'pwsh']) {
    const h = await harness(t, { semanticActions: true });
    h.register(tool, () => foreground(), parameters);
    assert.equal((await h.call(tool, { ...args, description: 'attempt one' })).denial, null);
    assert.equal((await h.call(tool, { ...args, description: 'attempt two' })).denial, null);
    assert.equal((await h.call(tool, { ...args, description: 'attempt three' })).denial, 'LOOP_GUARD_DUPLICATE');
  }
});

test('execution fields and quoted command whitespace keep distinct identities', async t => {
  for (const [key, first, second] of [
    ['command', "printf 'a  b'", "printf 'a b'"], ['workdir', 'one', 'two'],
    ['timeoutMs', 10, 20], ['sandbox_permissions', 'read-only', 'workspace-write'],
    ['justification', 'reason one', 'reason two'], ['run_in_background', false, true],
    ['execution_nonce', 1, 2],
  ]) {
    const h = await harness(t, { semanticActions: true, blockExactDuplicates: false, maxCallsPerRepeatGroup: 1 });
    h.register('bash', () => { throw new Error('fixed tool error'); }, parameters);
    assert.equal((await h.call('bash', { ...args, [key]: first })).denial, null, key);
    assert.equal((await h.call('bash', { ...args, [key]: second })).denial, null, key);
    assert.equal(h.bodyCounts.get('bash'), 2);
  }
});

test('display-field handling does not apply to unknown tools', async t => {
  const h = await harness(t, { semanticActions: true });
  h.register('custom_tool', () => { throw new Error('fixed error'); }, parameters);
  for (const description of ['one', 'two', 'three']) {
    assert.equal((await h.call('custom_tool', { ...args, description })).denial, null);
  }
});

test('only known unittest timestamp/elapsed noise is removed', async t => {
  const h = await harness(t, { semanticEvidence: true });
  let attempt = 0;
  h.register('bash', () => foreground(`test_started_at_ns=${++attempt}\n`, 1,
    `AssertionError: expected 1, got 2\nRan 1 test in 0.00${attempt}s\nFAILED (failures=1)\n`), parameters);
  assert.equal((await h.call('bash', args)).denial, null);
  assert.equal((await h.call('bash', args)).denial, null);
  assert.equal((await h.call('bash', args)).denial, 'LOOP_GUARD_DUPLICATE');
  const observations = h.decisions.filter(x => x.decision === 'observe');
  assert.deepEqual(observations.map(x => x.status), ['failed', 'failed']);
  assert.deepEqual(observations.map(x => x.productive), [true, false]);
  assert.equal(observations[0].evidenceKey, observations[1].evidenceKey);
});

test('new failures and a successful program result remain observable', async t => {
  const h = await harness(t, { semanticEvidence: true });
  const outputs = [foreground('error A'), foreground('error B'), foreground('OK', 0)];
  h.register('bash', () => outputs.shift(), parameters);
  for (const expected of [1, 1, 0]) assert.equal((await h.call('bash', args)).value.exitCode, expected);
  assert.deepEqual(h.decisions.filter(x => x.decision === 'observe').map(x => x.productive), [true, true, true]);
});

test('returning to an already seen error does not provide fresh progress', async t => {
  const h = await harness(t, { semanticEvidence: true });
  let count = 0;
  h.register('bash', () => foreground(++count % 2 ? 'error A' : 'error B'), parameters);
  for (let i = 0; i < 3; i++) assert.equal((await h.call('bash', args)).denial, null);
  assert.equal((await h.call('bash', args)).denial, 'LOOP_GUARD_DUPLICATE');
});

test('business timestamps outside the known test profile are retained', async t => {
  for (const command of ['python report.py', 'echo python -m unittest']) {
    const h = await harness(t, { semanticEvidence: true });
    let count = 0;
    h.register('bash', () => foreground(`test_started_at_ns=${++count}`, 0), parameters);
    for (let i = 0; i < 4; i++) {
      assert.equal((await h.call('bash', { ...args, command })).denial, null);
    }
  }
});

test('numeric error evidence is retained within the test profile', async t => {
  const h = await harness(t, { semanticEvidence: true });
  let count = 0;
  h.register('bash', () => foreground('', 1, `AssertionError: actual=${++count}`), parameters);
  for (let i = 0; i < 4; i++) assert.equal((await h.call('bash', args)).denial, null);
});

test('interrupted commands do not report successful or useful new progress', async t => {
  for (const flag of ['aborted', 'timedOut']) {
    const h = await harness(t, { semanticEvidence: true });
    h.register('bash', () => ({ ...foreground('interrupted', 0), [flag]: true }), parameters);
    assert.equal((await h.call('bash', args)).denial, null);
    assert.equal((await h.call('bash', args)).denial, 'LOOP_GUARD_DUPLICATE');
    assert.equal(h.decisions.find(x => x.decision === 'observe').productive, false);
  }
});

function waiting(config = {}) {
  let now = 0;
  const statuses = new Map();
  const agent = { session: { id: 'waiting-session' } };
  const guard = new LoopGuardState({ semanticWaits: true, maxWaitPollsPerJob: 3,
    maxJobWaitMs: 100, minJobPollIntervalMs: 0, now: () => now,
    getJobStatus: (_agent, id) => statuses.get(id), ...config });
  guard.beginTurn(agent, 1, false);
  function call(id, jobId = 'job', status = 'running', commit = true) {
    const input = { job_id: jobId, wait: true, timeout_ms: 10 };
    const denied = guard.denyReason(agent, 'job_output', input, id);
    if (denied) return { denied };
    if (commit) {
      guard.commitCall(agent, id);
      guard.recordResult(agent, { callId: id, result: { isError: false, value: { text: '', job: { id: jobId, status } } } });
    }
    return { denied: null };
  }
  return { guard, agent, call, statuses, advance: ms => { now += ms; } };
}

test('running waits have independent bounded budgets and never advance the epoch', () => {
  const f = waiting({ maxToolAttemptsPerTurn: 1, progressToolNames: ['job_output'] });
  for (let i = 0; i < 3; i++) assert.equal(f.call(`call-${i}`).denied, null);
  assert.match(f.call('over-budget').denied, /LOOP_GUARD_WAIT_BUDGET/);
  const state = f.guard.stateFor(f.agent);
  assert.equal(state.progressEpoch, 0);
  assert.equal(state.attemptsSinceProgress, 0);
  assert.equal(state.progressAttemptsSinceProgress, 0);
});

test('too frequent waits stop at the configured frequency boundary', () => {
  const f = waiting({ minJobPollIntervalMs: 20 });
  f.call('first'); f.advance(5);
  assert.match(f.call('too-fast').denied, /LOOP_GUARD_WAIT_RATE/);
});

test('a wait that exceeds the remaining deadline is rejected before dispatch', () => {
  const f = waiting({ maxJobWaitMs: 50 });
  f.call('first'); f.advance(45);
  assert.match(f.call('too-late').denied, /LOOP_GUARD_WAIT_TIME/);
});

test('completion from the registry allows one final collection after a per-job limit', () => {
  const f = waiting({ maxWaitPollsPerJob: 1 });
  f.call('first');
  assert.match(f.call('limit').denied, /LOOP_GUARD_WAIT_BUDGET/);
  f.statuses.set('job', 'completed');
  assert.equal(f.call('collect', 'job', 'completed').denied, null);
  assert(f.call('already-collected', 'job', 'completed').denied);
});

test('uncommitted cancellation refunds both the wait and normal reservation budgets', () => {
  const f = waiting({ maxWaitPollsPerJob: 1 });
  assert.equal(f.call('cancelled', 'job', 'running', false).denied, null);
  f.guard.recordResult(f.agent, { callId: 'cancelled' });
  assert.equal(f.guard.stateFor(f.agent).waits.totalPolls, 0);
  assert.equal(f.call('retry').denied, null);
});

test('ordinary progress cannot refill the job wait ledger', () => {
  const f = waiting({ maxWaitPollsPerJob: 1 });
  f.call('wait');
  assert.equal(f.guard.denyReason(f.agent, 'read_file', {}, 'read'), undefined);
  f.guard.commitCall(f.agent, 'read');
  f.guard.recordResult(f.agent, { callId: 'read', result: { isError: false, value: 'new content' } });
  assert.equal(f.guard.stateFor(f.agent).progressEpoch, 1);
  assert.match(f.call('wait-again').denied, /LOOP_GUARD_WAIT_BUDGET/);
});

test('changing job IDs cannot bypass the total wait-query cap', () => {
  const f = waiting({ maxWaitPollsPerTurn: 2 });
  assert.equal(f.call('a', 'a').denied, null);
  assert.equal(f.call('b', 'b').denied, null);
  assert.match(f.call('c', 'c').denied, /LOOP_GUARD_WAIT_BUDGET/);
});

test('concurrent queries for the same job are not admitted twice', () => {
  const f = waiting();
  assert.equal(f.call('pending', 'job', 'running', false).denied, null);
  assert.match(f.call('second').denied, /LOOP_GUARD_WAIT_INFLIGHT/);
});

test('native job_output waits can reach a terminal result', async t => {
  const h = await harness(t, { semanticWaits: true, minJobPollIntervalMs: 0, maxJobWaitMs: 1000 });
  let count = 0;
  h.register('job_output', () => ({ text: '', job: { id: 'job', status: ++count < 4 ? 'running' : 'completed' } }),
    { job_id: { type: 'string' }, wait: { type: 'boolean' }, timeout_ms: { type: 'number' } });
  for (let i = 0; i < 4; i++) {
    const result = await h.call('job_output', { job_id: 'job', wait: true, timeout_ms: 10 });
    assert.equal(result.denial, null);
  }
  assert.deepEqual(h.decisions.filter(x => x.decision === 'observe').map(x => x.productive), [false, false, false, true]);
});

test('foreign job snapshots cannot provide progress or infinite wait exemptions', async t => {
  const h = await harness(t, { semanticWaits: true, minJobPollIntervalMs: 0, maxJobWaitMs: 1000 });
  h.register('job_output', () => ({ text: '', job: { id: 'wrong-job', status: 'running' } }),
    { job_id: { type: 'string' }, wait: { type: 'boolean' }, timeout_ms: { type: 'number' } });
  const input = { job_id: 'job', wait: true, timeout_ms: 10 };
  await h.call('job_output', input);
  await h.call('job_output', input);
  assert.equal((await h.call('job_output', input)).denial, 'LOOP_GUARD_DUPLICATE');
  assert(h.decisions.filter(x => x.decision === 'observe').every(x => !x.productive));
});

test('native plugin reads optional registry status without consuming output', async t => {
  let status = 'running';
  const h = await createHarness({ variant: 'working',
    config: { semanticWaits: true, maxWaitPollsPerJob: 1, minJobPollIntervalMs: 0, maxJobWaitMs: 1000 },
    jobs: { list() { return [{ id: 'job', status }]; } },
  });
  t.after(() => h.dispose());
  h.register('job_output', () => ({ text: '', job: { id: 'job', status } }),
    { job_id: { type: 'string' }, wait: { type: 'boolean' }, timeout_ms: { type: 'number' } });
  const input = { job_id: 'job', wait: true, timeout_ms: 10 };
  assert.equal((await h.call('job_output', input)).denial, null);
  assert.equal((await h.call('job_output', input)).denial, 'LOOP_GUARD_WAIT_BUDGET');
  status = 'completed';
  assert.equal((await h.call('job_output', input)).value.job.status, 'completed');
  assert.equal(h.bodyCounts.get('job_output'), 2);
});
