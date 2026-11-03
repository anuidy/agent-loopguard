// Limited adapters for the pinned DSH bash/pwsh foreground and job_output DTOs.
const SHELL_TOOLS = new Set(['bash', 'pwsh']);
export const TERMINAL_JOB_STATES = new Set(['completed', 'failed', 'killed']);
const JOB_STATES = new Set(['running', 'stopping', ...TERMINAL_JOB_STATES]);

export function actionArguments(name, args) {
  if (!SHELL_TOOLS.has(name) || !args || typeof args !== 'object'
    || typeof args.command !== 'string' || !args.command.trim()
    || typeof args.description !== 'string' || !args.description.trim()) return args;
  // Retain every execution/unknown field, including justification and permissions.
  const { description: _displayOnly, ...executionArgs } = args;
  return executionArgs;
}

export function isShellTool(name) {
  return SHELL_TOOLS.has(name);
}

function unittestProfile(command) {
  return typeof command === 'string'
    && /^\s*(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?\s+(?:-m\s+unittest\b|(?:[^\s]*[\\/])?failing_test\.py(?:\s|$))/u.test(command);
}

function evidenceText(text, command) {
  if (!unittestProfile(command)) return text;
  // Only the explicit fixture timestamp and unittest's elapsed summary are noise.
  return text.split(/\r?\n/u)
    .filter(line => !/^test_started_at_ns=\d+\s*$/u.test(line))
    .map(line => line.replace(/^(Ran \d+ tests? in )\d+(?:\.\d+)?s$/u, '$1<elapsed>s'))
    .join('\n');
}

export function shellEvidence(name, args, result) {
  if (!SHELL_TOOLS.has(name) || result?.isError !== false) return undefined;
  const value = result.value;
  if (value?.kind !== 'foreground'
    || !(Number.isInteger(value.exitCode) || value.exitCode === null)
    || typeof value.timedOut !== 'boolean' || typeof value.aborted !== 'boolean'
    || !(typeof value.signal === 'string' || value.signal === null)
    || typeof value.stdout?.text !== 'string' || typeof value.stderr?.text !== 'string') return undefined;
  const status = value.aborted || value.stopped ? 'aborted'
    : value.timedOut ? 'timed-out'
      : value.sandbox?.denied || value.sandbox?.runnerFailed ? 'sandbox-error'
        : value.signal !== null ? 'signaled'
          : value.exitCode === 0 ? 'succeeded' : 'failed';
  return {
    adapter: unittestProfile(args?.command) ? 'shell-unittest' : 'shell-foreground',
    status,
    canProgress: status === 'succeeded' || status === 'failed',
    evidence: {
      status, exitCode: value.exitCode, signal: value.signal,
      cwd: value.cwd, timedOut: value.timedOut, aborted: value.aborted,
      stopped: value.stopped, sandbox: value.sandbox,
      stdout: evidenceText(value.stdout.text, args?.command),
      stderr: evidenceText(value.stderr.text, args?.command),
      stdoutTruncated: value.stdout.truncated,
      stderrTruncated: value.stderr.truncated,
    },
  };
}

export function jobObservation(name, args, result) {
  const job = result?.value?.job;
  if (name !== 'job_output' || result?.isError !== false
    || typeof args?.job_id !== 'string' || job?.id !== args.job_id
    || !JOB_STATES.has(job.status) || typeof result.value.text !== 'string') return undefined;
  return { id: job.id, status: job.status, terminal: TERMINAL_JOB_STATES.has(job.status) };
}

export function waitRequest(name, args) {
  return name === 'job_output' && args?.wait === true
    && typeof args.job_id === 'string' && args.job_id.length > 0
    && (args.timeout_ms === undefined || (Number.isFinite(args.timeout_ms) && args.timeout_ms > 0));
}
