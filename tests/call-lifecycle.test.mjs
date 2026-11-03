import assert from 'node:assert/strict';
import test from 'node:test';
import { LoopGuardState } from '../packages/loopguard/lib/guard-state.js';

const agent = { id: 'fixture-agent', session: { id: 'fixture-session' } };

function fixture() {
  const guard = new LoopGuardState();
  guard.beginTurn(agent, 1, false);
  return guard;
}

function reserve(guard, id, name = 'read_file') {
  assert.equal(guard.denyReason(agent, name, { path: id }, id), undefined);
}

const success = value => ({ isError: false, value });

test('an explicit unknown call ID cannot commit another pending call', () => {
  const guard = fixture();
  reserve(guard, 'pending');
  guard.commitCall(agent, 'not-reserved');
  assert.equal(guard.stateFor(agent).calls[0].committed, false);
});

test('an unreserved native result cannot release or update another pending call', () => {
  const guard = fixture();
  reserve(guard, 'pending');
  guard.recordResult(agent, { callId: 'not-reserved', result: success('unrelated') });
  const state = guard.stateFor(agent);
  assert.equal(state.calls[0].released, false);
  assert.equal(state.attemptsSinceProgress, 1);
  assert.equal(state.progressEpoch, 0);
});

test('repeated release of one call cannot release another reservation', () => {
  const guard = fixture();
  reserve(guard, 'first');
  reserve(guard, 'second');
  guard.recordResult(agent, { callId: 'first' });
  guard.recordResult(agent, { callId: 'first' });
  const state = guard.stateFor(agent);
  assert.equal(state.calls[0].released, true);
  assert.equal(state.calls[1].released, false);
  assert.equal(state.attemptsSinceProgress, 1);
});

test('releasing a reservation from an older epoch cannot refund current work', () => {
  const guard = fixture();
  reserve(guard, 'old', 'todo_write');
  reserve(guard, 'progress');
  guard.commitCall(agent, 'progress');
  guard.recordResult(agent, { callId: 'progress', result: success('new evidence') });
  // Same operation, new call ID, after an epoch advance.
  assert.equal(guard.denyReason(agent, 'todo_write', { path: 'old' }, 'current'), undefined);
  guard.recordResult(agent, { callId: 'old' });
  const state = guard.stateFor(agent);
  assert.equal(state.attemptsSinceProgress, 1);
  assert.equal(state.progressAttemptsSinceProgress, 1);
  assert.equal([...state.exactGroups.values()][0].count, 1);
  assert.equal([...state.repeatGroups.values()][0].count, 1);
});

test('a completed call is observed at most once', () => {
  const guard = fixture();
  reserve(guard, 'done');
  guard.commitCall(agent, 'done');
  guard.recordResult(agent, { callId: 'done', result: success('first evidence') });
  guard.recordResult(agent, { callId: 'done', result: success('different late evidence') });
  assert.equal(guard.stateFor(agent).progressEpoch, 1);
});

test('late commit/result after session disposal cannot recreate the session', () => {
  const guard = fixture();
  reserve(guard, 'late');
  guard.commitCall(agent, 'late');
  guard.disposeSession(agent.session.id);
  guard.commitCall(agent, 'late');
  guard.recordResult(agent, { callId: 'late', result: success('late evidence') });
  assert.equal(guard.getTelemetry().activeAgents, 0);
});
