import { Context } from '@deepseek-ai/cordis';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { createRequire } from 'node:module';
import * as UpstreamGuard from '../vendor/dsh-agent-loop-guard-0.2.24/lib/index.js';
import * as WorkingGuard from '../packages/loopguard/lib/index.js';

const require = createRequire(import.meta.url);
export const guardVersion = '0.2.24';
export const hostDependencies = {
  tools: require('@deepseek-ai/dsh-tools/package.json').version,
  cordis: require('@deepseek-ai/cordis/package.json').version,
  schemastery: require('@deepseek-ai/schemastery/package.json').version,
};
export const hostVersion = hostDependencies.tools;
export const guardSchemaVersion = hostDependencies.schemastery;
let sequence = 0;

// The runtime and plugin are real. The model decisions, Agent handle and tool
// definitions are fixtures, so the lifecycle can be inspected deterministically.
export async function createHarness({
  bridgeResult = false,
  variant = 'upstream',
  config = {},
  message = 'Inspect the experiment results.',
  onTrace = () => {},
  jobs,
} = {}) {
  if (!['upstream', 'working'].includes(variant)) throw new Error(`Unknown variant: ${variant}`);
  if (bridgeResult && variant === 'working') {
    throw new Error('--bridge is an upstream diagnostic; the working plugin handles native results directly.');
  }
  const Guard = variant === 'working' ? WorkingGuard : UpstreamGuard;
  const ctx = new Context();
  const logs = [];
  const events = [];
  const cancellations = [];
  const decisions = [];
  function trace(type, fields = {}) {
    const event = { index: events.length + 1, type, ...fields };
    events.push(event);
    onTrace(event);
  }
  const agent = {
    id: `lab-agent-${++sequence}`,
    session: { id: `lab-session-${sequence}` },
    cancel(reason, options) { cancellations.push({ reason: String(reason), options }); },
  };
  // These three services are the surrounding application boundary, not a model.
  ctx.provide('systemPrompt', { tools() { return () => {}; }, section() { return () => {}; } });
  ctx.provide('agents', { get(id) { return id === agent.session.id || id === agent.id ? agent : undefined; } });
  ctx.provide('sessions', {});
  if (jobs !== undefined) ctx.provide('jobs', jobs);
  const tools = new ToolRuntime(ctx);
  const observations = [
    ctx.on('loopguard/decision', event => { decisions.push(event); }),
    ctx.on('tools/pre-execute', async (execution, next) => {
      trace('tools/pre-execute', { callId: execution.callId, tool: execution.name });
      return next();
    }),
    ctx.on('tools/execute', async (execution, next) => {
      trace('tools/execute', { callId: execution.callId, tool: execution.name });
      return next();
    }),
  ];

  // Diagnostic B group: forward the real second event argument in the envelope
  // expected by the old state machine. Native exec itself is not modified.
  const mounted = bridgeResult ? {
    ...Guard,
    apply(pluginCtx, pluginConfig) {
      const originalOn = pluginCtx.on.bind(pluginCtx);
      const bridged = pluginCtx.extend({
        on(name, callback, ...args) {
          if (name === 'tools/result') {
            return originalOn(name, (execution, result) => callback({ ...execution, result }), ...args);
          }
          return originalOn(name, callback, ...args);
        },
      });
      return Guard.apply(bridged, pluginConfig);
    },
  } : Guard;
  const fiber = await ctx.plugin(mounted, { assistantOutputGuard: false, ...config });
  // Guards are monotonic: undefined does not override a denial. This extra
  // guard only observes this phase; reaching tools/execute proves all guards
  // accepted. We do not infer another guard's decision from observer ordering.
  observations.push(tools.guard(execution => {
    trace('guard/observe', { callId: execution.callId, tool: execution.name });
    return undefined;
  }));
  observations.push(ctx.on('tools/result', (execution, result) => {
    const row = {
      callId: execution.callId, tool: execution.name,
      executionContainsResult: Object.hasOwn(execution, 'result'),
      resultIsError: result.isError,
      value: result.value, content: result.content,
    };
    logs.push(row);
    const text = result.content.filter(x => x.type === 'text').map(x => x.text).join('\n');
    trace('tools/result', {
      callId: execution.callId, tool: execution.name,
      executionContainsResult: row.executionContainsResult,
      isError: result.isError, value: result.value,
      denial: text.match(/\[(LOOP_GUARD_[A-Z_]+)\]/)?.[1] ?? null,
    });
  }));

  const bodyCounts = new Map();
  function register(name, execute, parameters = {}) {
    tools.register({
      name, description: `Lab fixture: ${name}`, parameters,
      output: {
        schema: {},
        render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
      },
      async execute(args, execution) {
        bodyCounts.set(name, (bodyCounts.get(name) ?? 0) + 1);
        trace('tool/body', { callId: execution.callId, tool: name });
        return execute(args, execution);
      },
    });
  }
  let callSequence = 0;
  async function call(name, args = {}) {
    const callId = `call-${++callSequence}`;
    trace('script/action', { callId, tool: name, arguments: args });
    const result = await tools.execute({
      agent, name, arguments: args, callId,
      signal: new AbortController().signal,
    });
    const text = result.content.filter(x => x.type === 'text').map(x => x.text).join('\n');
    return {
      call: callSequence, tool: name, isError: result.isError,
      denial: text.match(/\[(LOOP_GUARD_[A-Z_]+)\]/)?.[1] ?? null,
      value: result.value, text,
    };
  }
  async function beginTurn(text, turn = 1) {
    trace('agent/pre-step', { turn });
    return ctx.waterfall('agent/pre-step', {
      agent, turn, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }],
      signal: new AbortController().signal,
    }, async () => ({ kind: 'accept' }));
  }
  await beginTurn(message);
  return {
    ctx, tools, agent, logs, events, decisions, cancellations, bodyCounts, register, call, beginTurn,
    bridgeResult, variant,
    async dispose() {
      for (const unobserve of observations.reverse()) unobserve();
      await fiber.dispose();
    },
  };
}
