import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createHarness, hostDependencies } from '../lab/native-harness.mjs';

const options = process.argv.slice(2);
const scenario = options.find(x => !x.startsWith('--')) ?? 'read-edit-read';
const bridgeResult = options.includes('--bridge');
const variant = options.includes('--working') ? 'working' : 'upstream';
const hasResultIntegration = bridgeResult || variant === 'working';
if (!['read-edit-read', 'polling'].includes(scenario)
  || options.some(x => x.startsWith('--') && !['--bridge', '--working'].includes(x))) {
  throw new Error('Usage: npm run day1 -- [read-edit-read|polling] [--bridge] [--working]');
}

function show(event) {
  const identity = event.callId ? ` ${event.callId} ${event.tool}` : '';
  console.log(`[${String(event.index).padStart(2, '0')}] ${event.type}${identity}`);
  if (event.type === 'script/action') console.log(`     arguments = ${JSON.stringify(event.arguments)}`);
  if (event.type === 'tools/result') {
    console.log(`     exec has result field = ${event.executionContainsResult}`);
    console.log(`     second argument: isError=${event.isError}; value=${JSON.stringify(event.value)}`);
    if (event.denial) console.log(`     denial = ${event.denial}`);
  }
}

console.log(`Day 1 | ${scenario} | ${variant} | result bridge=${bridgeResult}`);
console.log(`Runtime: ${JSON.stringify(hostDependencies)}`);
console.log('script/action supplies fixed actions; no model is called.\n');
const h = await createHarness({ bridgeResult, variant, onTrace: show });
const resultDir = new URL('../results/day1/', import.meta.url);
await mkdir(resultDir, { recursive: true });
let outcome;
try {
  if (scenario === 'read-edit-read') {
    const path = new URL(`config-${variant}-${bridgeResult ? 'bridge' : 'stock'}.txt`, resultDir);
    await writeFile(path, 'before', 'utf8');
    h.register('read_file', () => readFile(path, 'utf8'), { path: { type: 'string' } });
    h.register('write_file', async args => {
      await writeFile(path, args.text, 'utf8');
      return 'written';
    }, { path: { type: 'string' }, text: { type: 'string' } });
    const calls = [
      await h.call('read_file', { path: 'config.txt' }),
      await h.call('write_file', { path: 'config.txt', text: 'after' }),
      await h.call('read_file', { path: 'config.txt' }),
    ];
    assert.equal(calls.at(-1).denial === null, hasResultIntegration);
    if (hasResultIntegration) assert.equal(calls.at(-1).value, 'after');
    assert.equal(await readFile(path, 'utf8'), 'after');
    const lastReadEnteredBody = h.events.some(x => x.type === 'tool/body' && x.callId === 'call-3');
    assert.equal(lastReadEnteredBody, hasResultIntegration);
    outcome = { calls, actualFileContent: 'after', lastReadEnteredBody };
    console.log(`\nFile on disk = after; call 3 (second read) entered tool body = ${lastReadEnteredBody}`);
  } else {
    // A real worker lives longer than two/three short waits. Its completion is
    // independent of whether the guard lets the script inspect it again.
    const worker = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 700)'], { stdio: 'ignore' });
    let done = false;
    const finished = once(worker, 'exit').then(([code]) => { done = true; return code; });
    h.register('job_output', async () => {
      await sleep(25);
      return { text: done ? 'completed' : '(no new output)', job: { id: 'eval-1', status: done ? 'completed' : 'running' } };
    }, { job_id: { type: 'string' }, wait: { type: 'boolean' }, timeout_ms: { type: 'number' } });
    const calls = [];
    let blockedWhileRunning = false;
    try {
      for (let i = 0; i < 8; i++) {
        const call = await h.call('job_output', { job_id: 'eval-1', wait: true, timeout_ms: 25 });
        calls.push(call);
        if (call.denial) { blockedWhileRunning = !done; break; }
        if (done) break;
      }
      const exitCode = await finished;
      assert(blockedWhileRunning);
      outcome = { calls, blockedWhileRunning, workerEventuallyCompleted: exitCode === 0 };
      console.log(`\nBlocked while running = ${blockedWhileRunning}; worker eventually completed = ${exitCode === 0}`);
    } finally { await finished; }
  }
  const report = { scenario, variant, bridgeResult, runtime: hostDependencies, ...outcome, events: h.events };
  const reportPath = new URL(`${scenario}-${variant}-${bridgeResult ? 'bridge' : 'stock'}.json`, resultDir);
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`Trace saved: ${fileURLToPath(reportPath)}`);
} finally {
  await h.dispose();
}
