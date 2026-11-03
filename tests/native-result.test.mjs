import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createHarness } from '../lab/native-harness.mjs';

async function harness(t, options = {}) {
  const h = await createHarness({ variant: 'working', ...options });
  t.after(() => h.dispose());
  return h;
}

function invoke(h, callId, {
  name = 'read_file', args = {}, agent = h.agent,
  signal = new AbortController().signal,
} = {}) {
  return h.tools.execute({ agent, name, arguments: args, callId, signal });
}

function denial(result) {
  return result.content.filter(x => x.type === 'text').map(x => x.text)
    .join('\n').match(/\[(LOOP_GUARD_[A-Z_]+)\]/)?.[1] ?? null;
}

for (const [label, options, expectedRead] of [
  ['upstream', { variant: 'upstream' }, undefined],
  ['diagnostic bridge', { variant: 'upstream', bridgeResult: true }, 'after'],
  ['working without bridge', {}, 'after'],
]) {
  test(`real file read/edit/read: ${label}`, async t => {
    const h = await harness(t, options);
    const directory = new URL('../results/tests/', import.meta.url);
    await mkdir(directory, { recursive: true });
    const file = new URL(`config-${label.replaceAll(' ', '-')}.txt`, directory);
    await writeFile(file, 'before', 'utf8');
    h.register('read_file', () => readFile(file, 'utf8'), { path: { type: 'string' } });
    h.register('write_file', async ({ text }) => {
      await writeFile(file, text, 'utf8');
      return 'written';
    }, { path: { type: 'string' }, text: { type: 'string' } });
    const nativeResults = [];
    t.after(h.ctx.on('tools/result', (exec, result) => nativeResults.push({ exec, result })));

    assert.equal((await h.call('read_file', { path: 'config.txt' })).value, 'before');
    assert.equal((await h.call('write_file', { path: 'config.txt', text: 'after' })).value, 'written');
    const last = await h.call('read_file', { path: 'config.txt' });
    assert.equal(await readFile(file, 'utf8'), 'after');
    assert.equal(last.value, expectedRead);
    assert.equal(last.denial, expectedRead ? null : 'LOOP_GUARD_DUPLICATE');
    assert.equal(h.bodyCounts.get('read_file'), expectedRead ? 2 : 1);
    assert.equal(nativeResults.length, 3);
    assert(nativeResults.every(({ exec, result }) =>
      Object.isFrozen(exec) && !Object.hasOwn(exec, 'result') && Object.isFrozen(result)));
  });
}

test('unchanged successful output is eventually denied', async t => {
  const h = await harness(t);
  h.register('read_file', () => 'same content');
  assert.equal((await h.call('read_file')).denial, null);
  assert.equal((await h.call('read_file')).denial, null);
  assert.equal((await h.call('read_file')).denial, 'LOOP_GUARD_DUPLICATE');
  assert.equal(h.bodyCounts.get('read_file'), 2);
});

test('a tool error does not count as successful progress', async t => {
  const h = await harness(t);
  h.register('read_file', () => { throw new Error('fixture read failed'); });
  const first = await h.call('read_file');
  assert.equal(first.isError, true);
  assert.equal(first.denial, null);
  assert.match(first.text, /fixture read failed/);
  assert.equal((await h.call('read_file')).denial, 'LOOP_GUARD_DUPLICATE');
  assert.equal(h.bodyCounts.get('read_file'), 1);
});

test('another guard denying after reservation refunds the uncommitted attempt', async t => {
  const h = await harness(t, { config: { maxToolAttemptsPerTurn: 1 } });
  h.register('read_file', () => 'content');
  t.after(h.tools.guard(exec => exec.callId === 'denied' ? 'Other policy denied this call' : undefined));
  const blocked = await invoke(h, 'denied');
  assert.equal(blocked.isError, true);
  assert.equal(h.bodyCounts.get('read_file'), undefined);
  const retried = await invoke(h, 'retry');
  assert.equal(retried.isError, false);
  assert.equal(retried.value, 'content');
  assert.equal(h.bodyCounts.get('read_file'), 1);
});

test('an unrelated pre-execute denial cannot refund a scheduled reservation', async t => {
  const h = await harness(t, { config: { maxToolAttemptsPerTurn: 1 } });
  h.register('read_file', () => 'content', { path: { type: 'string' } });
  const controller = new AbortController();
  const prepared = await h.tools.prepareScheduledExecution({
    agent: h.agent, name: 'read_file', arguments: { path: 'reserved' },
    callId: 'reserved', signal: controller.signal,
  });
  assert.equal(prepared.kind, 'dispatch');
  t.after(h.ctx.on('tools/pre-execute', async (exec, next) =>
    exec.callId === 'unreserved' ? { kind: 'deny', reason: 'Other pre-policy denied this call' } : next()));
  try {
    assert.equal((await invoke(h, 'unreserved', { args: { path: 'other' } })).isError, true);
    const next = await invoke(h, 'over-budget', { args: { path: 'fresh' } });
    assert.equal(denial(next), 'LOOP_GUARD_LIMIT');
    assert.equal(h.bodyCounts.get('read_file'), undefined);
  } finally {
    controller.abort();
    await h.tools.completeScheduledExecution(prepared);
  }
});

test('cancellation before checking and after reservation leaves no spent attempt', async t => {
  const h = await harness(t, { config: { maxToolAttemptsPerTurn: 1 } });
  h.register('read_file', () => 'content');
  assert.equal((await invoke(h, 'cancelled-before-check', { signal: AbortSignal.abort() })).isError, true);
  const controller = new AbortController();
  t.after(h.tools.guard(exec => {
    if (exec.callId === 'cancelled-after-check') controller.abort();
    return undefined;
  }));
  const cancelled = await invoke(h, 'cancelled-after-check', { signal: controller.signal });
  assert.equal(cancelled.isError, true);
  assert.equal(h.bodyCounts.get('read_file'), undefined);
  const retried = await invoke(h, 'retry');
  assert.equal(retried.isError, false);
  assert.equal(h.bodyCounts.get('read_file'), 1);
});

test('a started and cancelled tool remains counted and does not provide successful progress', async t => {
  const h = await harness(t);
  const controller = new AbortController();
  h.register('read_file', () => {
    controller.abort();
    return 'discarded successful value';
  });
  const cancelled = await invoke(h, 'started', { signal: controller.signal });
  assert.equal(cancelled.isError, true);
  assert.equal(denial(await invoke(h, 'retry')), 'LOOP_GUARD_DUPLICATE');
  assert.equal(h.bodyCounts.get('read_file'), 1);
});

test('out-of-order native results remain associated with their own call IDs', async t => {
  const h = await harness(t);
  const slow = Promise.withResolvers();
  const fast = Promise.withResolvers();
  const slowStarted = Promise.withResolvers();
  const fastStarted = Promise.withResolvers();
  h.register('read_file', ({ path }) => {
    if (path === 'slow') { slowStarted.resolve(); return slow.promise; }
    fastStarted.resolve();
    return fast.promise;
  }, { path: { type: 'string' } });
  let fastCall;
  const slowCall = invoke(h, 'slow-1', { args: { path: 'slow' } });
  try {
    await slowStarted.promise;
    fastCall = invoke(h, 'fast-1', { args: { path: 'fast' } });
    await fastStarted.promise;
    fast.resolve('fast content');
    assert.equal((await fastCall).value, 'fast content');
    slow.resolve('slow content');
    assert.equal((await slowCall).value, 'slow content');
    assert.deepEqual(h.logs.map(x => x.callId), ['fast-1', 'slow-1']);
    assert.equal((await invoke(h, 'slow-2', { args: { path: 'slow' } })).value, 'slow content');
    assert.equal(denial(await invoke(h, 'slow-3', { args: { path: 'slow' } })), 'LOOP_GUARD_DUPLICATE');
  } finally {
    slow.resolve('slow content');
    fast.resolve('fast content');
    await Promise.allSettled([slowCall, fastCall]);
  }
});

test('another step in the same turn preserves limits; a new turn resets them', async t => {
  const h = await harness(t);
  h.register('read_file', () => 'same content');
  await h.call('read_file');
  assert.equal((await h.call('read_file')).denial, null);
  await h.beginTurn('Inspect the same file.', 1);
  assert.equal((await h.call('read_file')).denial, 'LOOP_GUARD_DUPLICATE');
  await h.beginTurn('Inspect the same file.', 2);
  assert.equal((await h.call('read_file')).value, 'same content');
});

test('sessions in one runtime are isolated and disposal clears only its own state', async t => {
  const h = await harness(t);
  h.register('read_file', () => 'same content');
  await h.call('read_file');
  await h.call('read_file');
  assert.equal((await h.call('read_file')).denial, 'LOOP_GUARD_DUPLICATE');
  const otherAgent = { id: 'other-agent', session: { id: 'other-session' } };
  assert.equal((await invoke(h, 'other-1', { agent: otherAgent })).isError, false);
  await invoke(h, 'other-2', { agent: otherAgent });
  h.ctx.emit('session/disposed', h.agent.session);
  assert.equal((await invoke(h, 'fresh')).isError, false);
  assert.equal(denial(await invoke(h, 'other-3', { agent: otherAgent })), 'LOOP_GUARD_DUPLICATE');
});
