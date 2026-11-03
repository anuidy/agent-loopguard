import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createHarness, hostDependencies } from './native-harness.mjs';

const flags = { semanticActions: true, semanticEvidence: true, semanticWaits: true };
const variants = [
  { id: 'A', variant: 'upstream' },
  { id: 'B', variant: 'upstream', bridgeResult: true },
  { id: 'B-safe', variant: 'working' },
  { id: 'C', variant: 'working', config: { blockExactDuplicates: false, maxCallsPerRepeatGroup: 20 } },
  { id: 'D', variant: 'working', config: flags },
];
const parameters = { command: { type: 'string' }, description: { type: 'string' }, workdir: { type: 'string' } };
const input = { command: 'python fixtures/failing_test.py', description: 'Run tests', workdir: process.cwd() };
const foreground = (stdout, exitCode = 1, stderr = '') => ({
  kind: 'foreground', cwd: process.cwd(), exitCode, signal: null, timedOut: false, aborted: false,
  stdout: { text: stdout, truncated: false }, stderr: { text: stderr, truncated: false },
});
const fixture = fileURLToPath(new URL('../fixtures/failing_test.py', import.meta.url));
const cases = [];

async function run(scenario, settings, ablation = false) {
  const config = {
    minJobPollIntervalMs: 0, maxJobWaitMs: 4000,
    maxWaitPollsPerJob: scenario === 'background-over-budget' ? 4 : 12,
    ...settings.config,
  };
  const started = performance.now();
  let worker, finished, ready, workerDone = false;
  if (scenario.startsWith('background-')) {
    const duration = scenario === 'background-finish' ? 500 : 3000;
    worker = spawn(process.execPath, ['-e',
      `process.send('ready'); process.once('message', () => setTimeout(() => process.exit(0), ${duration}));`],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    ready = once(worker, 'message');
    finished = once(worker, 'exit').then(([code]) => { workerDone = true; return code; });
    await Promise.race([ready, finished.then(() => { throw new Error('worker exited before readiness'); })]);
  }
  const h = await createHarness({ ...settings, config,
    jobs: worker ? { list() { return [{ id: 'eval-1', status: workerDone ? 'completed' : 'running' }]; } } : undefined,
  });
  const calls = [];
  let blockedWhileRunning = false;
  let actualFailures = 0;
  let path;
  try {
    if (scenario === 'read-edit-read') {
      path = new URL(`../results/semantics/config-${settings.id}.txt`, import.meta.url);
      await writeFile(path, 'before', 'utf8');
      h.register('read_file', () => readFile(path, 'utf8'), { path: { type: 'string' } });
      h.register('write_file', async args => { await writeFile(path, args.text, 'utf8'); return 'written'; },
        { path: { type: 'string' }, text: { type: 'string' } });
      calls.push(await h.call('read_file', { path: 'config.txt' }));
      calls.push(await h.call('write_file', { path: 'config.txt', text: 'after' }));
      calls.push(await h.call('read_file', { path: 'config.txt' }));
      assert.equal(await readFile(path, 'utf8'), 'after');
    } else if (worker) {
      let workerStarted = false;
      h.register('job_output', async () => {
        if (!workerStarted) { workerStarted = true; worker.send('start'); }
        await Promise.race([finished, sleep(80)]);
        return { text: workerDone ? 'completed' : '(no new output)',
          job: { id: 'eval-1', status: workerDone ? 'completed' : 'running' } };
      }, { job_id: { type: 'string' }, wait: { type: 'boolean' }, timeout_ms: { type: 'number' } });
      for (let i = 0; i < 8; i++) {
        const result = await h.call('job_output', { job_id: 'eval-1', wait: true, timeout_ms: 80 });
        calls.push(result);
        if (result.denial) { blockedWhileRunning = !workerDone; break; }
        if (result.value.job.status === 'completed') break;
      }
    } else {
      let count = 0;
      h.register('bash', () => {
        count += 1;
        if (scenario === 'actual-failure-noise') {
          const p = spawnSync('python', [fixture], { encoding: 'utf8', windowsHide: true });
          if (p.error) throw p.error;
          assert.equal(p.status, 1);
          actualFailures += 1;
          return foreground(p.stdout, p.status, p.stderr);
        }
        if (scenario === 'new-error-then-pass') {
          return count < 3 ? foreground(`error ${count}`) : foreground('OK', 0);
        }
        return foreground('fixed failure');
      }, parameters);
      const limit = scenario === 'new-error-then-pass' ? 3 : 8;
      for (let i = 0; i < limit; i++) {
        const args = scenario === 'description-retries' ? { ...input, description: `Retry ${i + 1}` } : input;
        const result = await h.call('bash', args);
        calls.push(result);
        if (result.denial) break;
      }
    }
    const last = calls.at(-1);
    const completed = scenario === 'read-edit-read' ? last.value === 'after'
      : scenario === 'background-finish' ? last.value?.job.status === 'completed'
        : scenario === 'new-error-then-pass' ? last.value?.exitCode === 0 : false;
    const workerEventuallyCompleted = worker && scenario === 'background-finish'
      ? (await finished) === 0 : null;
    const summary = {
      requests: calls.length, executions: [...h.bodyCounts.values()].reduce((a, b) => a + b, 0),
      deniedCall: last.denial ? calls.length : null, denial: last.denial, completed,
      blockedWhileRunning, workerEventuallyCompleted,
      cleanupTerminatesWorker: Boolean(worker && !workerDone),
      actualFailures, elapsedMs: Math.round(performance.now() - started),
      observedStatuses: h.decisions.filter(x => x.decision === 'observe').map(x => x.status),
    };
    if (scenario === 'read-edit-read') assert.equal(completed, settings.id !== 'A');
    if (settings.id === 'D') {
      if (scenario === 'description-retries' || scenario === 'actual-failure-noise') assert.equal(summary.deniedCall, 3);
      if (scenario === 'background-finish' || scenario === 'new-error-then-pass') assert(completed);
      if (scenario === 'background-over-budget') {
        assert.equal(summary.denial, 'LOOP_GUARD_WAIT_BUDGET');
        assert.equal(summary.executions, 4);
        assert(blockedWhileRunning);
      }
    }
    if (ablation && scenario !== 'background-finish') assert.equal(summary.executions, 8);
    if (ablation && scenario === 'background-finish') assert.equal(summary.deniedCall, 3);
    cases.push({ scenario, group: settings.id, ablation, config, summary, calls, decisions: h.decisions, events: h.events });
    console.log(JSON.stringify({ scenario, group: settings.id, ...summary }));
  } finally {
    if (worker && !workerDone) worker.kill();
    if (finished) await finished;
    await h.dispose();
  }
}

await mkdir(new URL('../results/semantics/', import.meta.url), { recursive: true });
for (const scenario of ['read-edit-read', 'description-retries', 'actual-failure-noise',
  'background-finish', 'background-over-budget', 'new-error-then-pass']) {
  for (const settings of variants) await run(scenario, settings);
}
for (const [scenario, disabled] of [
  ['description-retries', 'semanticActions'], ['actual-failure-noise', 'semanticEvidence'],
  ['background-finish', 'semanticWaits'],
]) await run(scenario, { id: `D-without-${disabled}`, variant: 'working', config: { ...flags, [disabled]: false } }, true);

const sourceHashes = {};
for (const file of ['index.js', 'guard-state.js', 'tool-semantics.js', 'job-waits.js']) {
  sourceHashes[file] = createHash('sha256').update(await readFile(new URL(`../packages/loopguard/lib/${file}`, import.meta.url))).digest('hex');
}
const report = {
  measuredDate: '2026-11-03', scope: 'Controlled component traces; real Cordis/ToolRuntime; no model or complete Agent loop.',
  controls: 'Same scenario and 8-call cap (3 for read/edit/read and changing-error control). C alone widens repeats. Timed workers are real processes; over-budget workers are explicitly terminated during cleanup.',
  runtime: hostDependencies, sourceHashes, groups: variants, cases,
};
await writeFile(new URL('../results/semantics/comparison.json', import.meta.url), JSON.stringify(report, null, 2), 'utf8');
console.log(`Saved ${cases.length} component traces, including 3 ablations.`);
