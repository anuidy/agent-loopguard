// Test-only observer/limits for a real headless run. It supplies no model or
// tool results; the shipped Harness owns the Agent, tools and model requests.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const name = 'loopguard-smoke-recorder';
export const inject = ['tools', 'agents', 'sessions'];

export function apply(ctx, config) {
  const maxSteps = config.maxSteps ?? 6;
  const maxToolCalls = config.maxToolCalls ?? 8;
  const workspace = resolve(process.cwd());
  const tracePath = resolve(config.tracePath);
  mkdirSync(dirname(tracePath), { recursive: true });
  const record = (event, fields = {}) => appendFileSync(tracePath,
    JSON.stringify({ event, ...fields }) + '\n', 'utf8');
  let steps = 0;
  let attemptedTools = 0;
  record('recorder_ready', { maxSteps, maxToolCalls, nodeVersion: process.version });
  ctx.on('agent/pre-step', async (payload, next) => {
    if (steps >= maxSteps) {
      record('step_budget_reached', { turn: payload.turn, step: payload.step });
      return { kind: 'reject' };
    }
    steps += 1;
    record('model_step', { turn: payload.turn, step: payload.step });
    return next();
  });
  ctx.on('tools/pre-execute', async (exec, next) => {
    record('tool_request', {
      callId: exec.callId, tool: exec.name,
      filePath: typeof exec.arguments?.file_path === 'string' ? exec.arguments.file_path : undefined,
    });
    return next();
  });
  ctx.on('agent/request', async (payload, next) => {
    record('model_request', { turn: payload.turn, step: payload.step });
    return next();
  });
  ctx.on('tools/result', (exec, result) => {
    record('tool_result', { callId: exec.callId, tool: exec.name,
      isError: result.isError, errorCode: result.error?.code });
  });
  ctx.on('loopguard/decision', event => record('guard_decision', event));
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/end') record('turn_end', { reason: event.data?.reason?.kind });
    if (event.type === 'assistant/message' && event.data?.usage) {
      const usage = {};
      for (const key of ['inputTokens', 'outputTokens', 'totalTokens',
        'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
        const value = event.data.usage[key];
        if (typeof value === 'number' && Number.isFinite(value)) usage[key] = value;
      }
      record('model_usage', { usage });
    }
  });
  return ctx.tools.guard(exec => {
    attemptedTools += 1;
    let reason;
    if (attemptedTools > maxToolCalls) reason = 'SMOKE_TOOL_BUDGET';
    else if (!['read', 'write', 'edit'].includes(exec.name)) reason = 'SMOKE_TOOL_NOT_ALLOWED';
    else {
      const target = resolve(workspace, String(exec.arguments?.file_path ?? ''));
      const path = relative(workspace, target);
      if (isAbsolute(path) || path.startsWith('..' + sep)
        || !['input.json', 'result.json'].includes(path)) reason = 'SMOKE_PATH_NOT_ALLOWED';
      else if (path === 'input.json' && exec.name !== 'read') reason = 'SMOKE_INPUT_READ_ONLY';
    }
    if (reason) {
      record('smoke_denial', { callId: exec.callId, tool: exec.name, reason });
      return `[${reason}] This integration check permits only the two task files and a bounded number of tools.`;
    }
    return undefined;
  });
}
