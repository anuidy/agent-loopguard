import { createHash } from 'node:crypto';
import { actionArguments, isShellTool, jobObservation, shellEvidence } from './tool-semantics.js';
import { JobWaitBudget } from './job-waits.js';
export const DEFAULT_STOP_PATTERNS = {
  en: /(?<![\p{L}\p{N}_-])(?:stop|halt|cancel|abort|terminate|answer(?:\s+now)?)(?![\p{L}\p{N}_-])/iu,
  zh: /(?:停止|暂停|取消|终止|回答|死循环)/u,
};

export function compileStopPatterns(customPatterns = []) {
  if (!Array.isArray(customPatterns)) return [];
  const compiled = [];
  for (const item of customPatterns) {
    if (item instanceof RegExp) {
      compiled.push(item);
    } else if (typeof item === 'string' && item.trim() !== '') {
      const escaped = item.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      compiled.push(new RegExp(escaped, 'iu'));
    }
  }
  return compiled;
}

const SECRET_KEY_PATTERN = /(?:token|secret|password|authorization|api[-_]?key|cookie)/iu;

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
}

function normalizedJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') return JSON.stringify(value.trim().replace(/\s+/gu, ' '));
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(normalizedJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + normalizedJson(value[key])).join(',') + '}';
}

function textFrom(value) {
  if (!Array.isArray(value)) return '';
  return value.map((block) => {
    if (block === null || typeof block !== 'object') return '';
    if (typeof block.text === 'string') return block.text;
    if (Array.isArray(block.content)) return textFrom(block.content);
    return '';
  }).join('\n');
}

function safeLogValue(value, depth = 0) {
  if (depth > 3) return '[depth-limit]';
  if (typeof value === 'string') {
    return value.replace(/((?:Bearer|token)\s+)[^\s'"]+/giu, '$1[redacted]')
      .replace(/((?:token|secret|password|authorization|api[-_]?key)=)[^\s&]+/giu, '$1[redacted]')
      .slice(0, 400);
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeLogValue(item, depth + 1));
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    output[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : safeLogValue(item, depth + 1);
  }
  return output;
}

export function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value >= 1 ? value : fallback;
}

export function nonNegativeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export function hasStopRequest(messages, customPatterns = []) {
  if (!Array.isArray(messages)) return false;
  const compiledCustom = compileStopPatterns(customPatterns);
  return messages.some((message) => {
    if (message?.source?.kind !== 'user') return false;
    const text = textFrom(message.content);
    if (!text) return false;
    if (DEFAULT_STOP_PATTERNS.en.test(text) || DEFAULT_STOP_PATTERNS.zh.test(text)) {
      return true;
    }
    return compiledCustom.some((regex) => regex.test(text));
  });
}

export function callFingerprint(name, args) {
  try {
    const raw = stableJson(args);
    const body = raw.length > 256 ? 'sha256:' + createHash('sha256').update(raw).digest('hex') : raw;
    return String(name) + ':' + body;
  } catch {
    return String(name) + ':<unserializable>';
  }
}

export function callRepeatFingerprint(name, args) {
  try {
    const raw = normalizedJson(args);
    const body = raw.length > 256 ? 'sha256:' + createHash('sha256').update(raw).digest('hex') : raw;
    return String(name) + ':' + body;
  } catch {
    return String(name) + ':<unserializable>';
  }
}

export function resultFingerprint(value) {
  try {
    const raw = stableJson(value);
    return raw.length > 256 ? 'sha256:' + createHash('sha256').update(raw).digest('hex') : raw;
  } catch {
    return '<unserializable-result>';
  }
}

export function safeCallSummary(name, args) {
  return {
    tool: String(name),
    arguments: safeLogValue(args),
  };
}

function hasOwn(object, key) {
  return object !== null && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
}

function outcomeFromExecution(execution) {
  const data = execution?.data;
  const hasResult = hasOwn(execution, 'result') || hasOwn(execution, 'output')
    || hasOwn(data, 'result') || hasOwn(data, 'output') || hasOwn(execution, 'error');
  if (!hasResult) return { known: false, successful: false, resultFingerprint: '<unknown>', progressToken: '<unknown>' };
  const value = execution?.result ?? execution?.output ?? data?.result ?? data?.output
    ?? (hasOwn(execution, 'error') ? { error: execution.error } : undefined);
  const failed = (execution?.error != null && execution?.error !== false)
    || value?.isError === true
    || value?.success === false
    || value?.ok === false
    || (value?.error != null && value?.error !== false);
  const explicitProgress = execution?.progressToken ?? execution?.progress ?? execution?.stateVersion
    ?? data?.progressToken ?? data?.progress ?? data?.stateVersion;
  return {
    known: true,
    successful: !failed,
    resultFingerprint: resultFingerprint(value),
    progressToken: explicitProgress === undefined ? resultFingerprint(value) : resultFingerprint(explicitProgress),
  };
}

export class LoopGuardState {
  constructor(config = {}) {
    const progressToolNames = Array.isArray(config.progressToolNames)
      ? config.progressToolNames
        .filter((name) => typeof name === 'string' && name.trim() !== '')
        .map((name) => name.trim())
      : ['todo_write'];
    const strictTools = Array.isArray(config.strictTools)
      ? config.strictTools
        .filter((name) => typeof name === 'string' && name.trim() !== '')
        .map((name) => name.trim())
      : [];
    const stopPatterns = Array.isArray(config.stopPatterns)
      ? config.stopPatterns
        .filter((name) => typeof name === 'string' && name.trim() !== '')
        .map((name) => name.trim())
      : [];
    this.config = {
      ...config,
      maxToolAttemptsPerTurn: nonNegativeInteger(config.maxToolAttemptsPerTurn, 64),
      maxProgressToolCallsPerTurn: positiveInteger(config.maxProgressToolCallsPerTurn, 16),
      maxCallsPerRepeatGroup: positiveInteger(config.maxCallsPerRepeatGroup, 5),
      strictToolLimit: positiveInteger(config.strictToolLimit, 3),
      dryRunMode: Boolean(config.dryRunMode),
      blockExactDuplicates: config.blockExactDuplicates !== undefined ? Boolean(config.blockExactDuplicates) : true,
      semanticActions: Boolean(config.semanticActions),
      semanticEvidence: Boolean(config.semanticEvidence),
      semanticWaits: Boolean(config.semanticWaits),
      maxWaitPollsPerJob: positiveInteger(config.maxWaitPollsPerJob, 12),
      maxWaitPollsPerTurn: positiveInteger(config.maxWaitPollsPerTurn, 32),
      maxJobWaitMs: positiveInteger(config.maxJobWaitMs, 120_000),
      minJobPollIntervalMs: nonNegativeInteger(config.minJobPollIntervalMs, 200),
      stopPatterns,
    };
    this.stopPatterns = stopPatterns;
    this.logger = config.logger;
    this.onViolation = typeof config.onViolation === 'function' ? config.onViolation : undefined;
    this.onDecision = typeof config.onDecision === 'function' ? config.onDecision : undefined;
    this.getJobStatus = typeof config.getJobStatus === 'function' ? config.getJobStatus : () => undefined;
    this.now = typeof config.now === 'function' ? config.now : () => performance.now();
    this.progressToolNames = new Set(progressToolNames);
    this.strictTools = new Set(strictTools);
    this.byAgent = new Map();
    this.objectKeys = new WeakMap();
    this.nextObjectKey = 1;

    this.metrics = {
      totalViolations: 0,
      byCode: {
        LOOP_GUARD_STOP: 0,
        LOOP_GUARD_DUPLICATE: 0,
        LOOP_GUARD_REPEAT: 0,
        LOOP_GUARD_LIMIT: 0,
        LOOP_GUARD_PROGRESS_LIMIT: 0,
        LOOP_GUARD_OUTPUT: 0,
      },
      lastViolation: null,
    };
  }

  updateConfig(config = {}) {
    const progressToolNames = Array.isArray(config.progressToolNames)
      ? config.progressToolNames
        .filter((name) => typeof name === 'string' && name.trim() !== '')
        .map((name) => name.trim())
      : Array.from(this.progressToolNames);
    const strictTools = Array.isArray(config.strictTools)
      ? config.strictTools
        .filter((name) => typeof name === 'string' && name.trim() !== '')
        .map((name) => name.trim())
      : Array.from(this.strictTools);
    this.config = {
      ...this.config,
      ...config,
      maxToolAttemptsPerTurn: nonNegativeInteger(config.maxToolAttemptsPerTurn, this.config.maxToolAttemptsPerTurn ?? 64),
      maxProgressToolCallsPerTurn: positiveInteger(config.maxProgressToolCallsPerTurn, this.config.maxProgressToolCallsPerTurn ?? 16),
      maxCallsPerRepeatGroup: positiveInteger(config.maxCallsPerRepeatGroup ?? config.maxCallsPerToolPerTurn, this.config.maxCallsPerRepeatGroup ?? 5),
      strictToolLimit: positiveInteger(config.strictToolLimit, this.config.strictToolLimit ?? 3),
      dryRunMode: config.dryRunMode !== undefined ? Boolean(config.dryRunMode) : Boolean(this.config.dryRunMode),
      blockExactDuplicates: config.blockExactDuplicates !== undefined ? Boolean(config.blockExactDuplicates) : this.config.blockExactDuplicates,
      semanticActions: config.semanticActions !== undefined ? Boolean(config.semanticActions) : this.config.semanticActions,
      semanticEvidence: config.semanticEvidence !== undefined ? Boolean(config.semanticEvidence) : this.config.semanticEvidence,
      semanticWaits: config.semanticWaits !== undefined ? Boolean(config.semanticWaits) : this.config.semanticWaits,
      maxWaitPollsPerJob: positiveInteger(config.maxWaitPollsPerJob, this.config.maxWaitPollsPerJob),
      maxWaitPollsPerTurn: positiveInteger(config.maxWaitPollsPerTurn, this.config.maxWaitPollsPerTurn),
      maxJobWaitMs: positiveInteger(config.maxJobWaitMs, this.config.maxJobWaitMs),
      minJobPollIntervalMs: nonNegativeInteger(config.minJobPollIntervalMs, this.config.minJobPollIntervalMs),
    };
    if (Array.isArray(config.stopPatterns)) {
      this.stopPatterns = config.stopPatterns
        .filter((name) => typeof name === 'string' && name.trim() !== '')
        .map((name) => name.trim());
      this.config.stopPatterns = this.stopPatterns;
    }
    if (config.logger !== undefined) this.logger = config.logger;
    this.progressToolNames = new Set(progressToolNames);
    this.strictTools = new Set(strictTools);
  }

  hasStopRequest(messages) {
    return hasStopRequest(messages, this.stopPatterns);
  }

  recordExternalViolation(code, detail, extra = {}) {
    this.metrics.totalViolations += 1;
    this.metrics.byCode[code] = (this.metrics.byCode[code] || 0) + 1;
    this.metrics.lastViolation = {
      code,
      tool: extra.tool || 'assistant/output',
      timestamp: Date.now(),
      turn: extra.turn,
      reason: detail,
    };
  }

  getTelemetry() {
    return {
      ...this.metrics,
      activeAgents: this.byAgent.size,
      dryRunMode: Boolean(this.config.dryRunMode),
    };
  }

  resetTelemetry() {
    this.metrics.totalViolations = 0;
    for (const k of Object.keys(this.metrics.byCode)) {
      this.metrics.byCode[k] = 0;
    }
    this.metrics.lastViolation = null;
  }

  disposeSession(sessionId) {
    if (sessionId === undefined || sessionId === null) return;
    const id = typeof sessionId === 'object' ? (sessionId.id ?? sessionId) : sessionId;
    const str = String(id);
    this.byAgent.delete('session:' + str);
    this.byAgent.delete(str);
  }

  agentKey(agent) {
    if (agent !== null && typeof agent === 'object') {
      const sessionId = agent.session?.id ?? agent.session?.header?.id ?? agent.id;
      if (typeof sessionId === 'string' && sessionId.length > 0) return 'session:' + sessionId;
      let key = this.objectKeys.get(agent);
      if (key === undefined) {
        key = 'object:' + this.nextObjectKey++;
        this.objectKeys.set(agent, key);
      }
      return key;
    }
    return 'agent:' + String(agent ?? 'unknown');
  }

  emptyState(turn = undefined) {
    return {
      turn,
      attemptsSinceProgress: 0,
      progressAttemptsSinceProgress: 0,
      calls: [],
      nextCallKey: 1,
      stopRequested: false,
      answerOnly: false,
      stopReason: '',
      blockReason: undefined,
      progressEpoch: 0,
      repeatGroups: new Map(),
      exactGroups: new Map(),
      lastResults: new Map(),
      lastProgress: undefined,
      lastEvidence: undefined,
      semanticEvidence: new Map(),
      jobTerminals: new Set(),
      waits: new JobWaitBudget(this.now),
    };
  }

  beginTurn(agent, turn, stopRequested) {
    const key = this.agentKey(agent);
    const prior = this.byAgent.get(key);
    if (prior === undefined || prior.turn !== turn) {
      const next = this.emptyState(turn);
      next.stopRequested = Boolean(stopRequested);
      if (stopRequested) next.blockReason = 'LOOP_GUARD_STOP';
      this.byAgent.set(key, next);
      return;
    }
    if (stopRequested) {
      prior.stopRequested = true;
      prior.blockReason = 'LOOP_GUARD_STOP';
    }
  }

  stateFor(agent) {
    const key = this.agentKey(agent);
    let state = this.byAgent.get(key);
    if (state === undefined) {
      state = this.emptyState();
      this.byAgent.set(key, state);
    }
    return state;
  }

  findCall(state, callId) {
    if (typeof callId === 'string' && callId.length > 0) {
      // A result may come from a call rejected before our guard reserved it.
      // Never attribute an explicit, unmatched ID to a different call.
      return state.calls.findLast((call) => call.id === callId && !call.released);
    }
    return state.calls.findLast((call) => !call.released && !call.resultSeen);
  }

  decrementReservations(state, call) {
    if (!call || !call.counted || call.committed) return;
    call.counted = false;
    if (call.waitTicket) {
      state.waits.release(call.waitTicket);
      return;
    }
    // Progress already cleared the old epoch's counters and repeat groups.
    if (call.progressEpoch !== state.progressEpoch) return;
    state.attemptsSinceProgress = Math.max(0, state.attemptsSinceProgress - 1);
    if (call.isProgressTool) state.progressAttemptsSinceProgress = Math.max(0, state.progressAttemptsSinceProgress - 1);
    if (call.repeatFingerprint) {
      const group = state.repeatGroups.get(call.repeatFingerprint);
      if (group && group.progressEpoch === state.progressEpoch && group.count > 0) {
        group.count = Math.max(0, group.count - 1);
      }
    }
    if (call.fingerprint) {
      const exact = state.exactGroups.get(call.fingerprint);
      if (exact && exact.progressEpoch === state.progressEpoch && exact.count > 0) {
        exact.count = Math.max(0, exact.count - 1);
      }
    }
  }

  violation(state, agent, name, args, callId, code, detail) {
    this.metrics.totalViolations += 1;
    this.metrics.byCode[code] = (this.metrics.byCode[code] || 0) + 1;
    this.metrics.lastViolation = {
      code,
      tool: String(name),
      timestamp: Date.now(),
      turn: state.turn,
      reason: detail,
    };
    this.emitDecision(state, { id: callId, tool: name }, { decision: 'deny', code, reason: detail });

    const summary = safeCallSummary(name, args);
    const event = {
      code,
      reason: detail,
      callId: typeof callId === 'string' ? callId : undefined,
      agent: this.agentKey(agent),
      progressEpoch: state.progressEpoch,
      attemptsSinceProgress: state.attemptsSinceProgress,
      progressAttemptsSinceProgress: state.progressAttemptsSinceProgress,
      lastProgress: state.lastProgress,
      dryRun: Boolean(this.config.dryRunMode),
      ...summary,
    };
    try {
      this.onViolation?.(event);
    } catch (error) {
      this.logger?.debug?.('dsh-agent-loop-guard: onViolation callback failed: ' + (error instanceof Error ? error.message : String(error)));
    }

    if (this.config.dryRunMode) {
      return undefined;
    }

    state.answerOnly = true;
    state.stopReason = code + ': ' + detail;
    if (!state.blockReason) {
      state.blockReason = code;
    }

    let guidance = 'ACTION REQUIRED: ';
    if (code === 'LOOP_GUARD_STOP') {
      guidance += 'User requested stop. Do NOT invoke further tools. Synthesize your final answer in plain text.';
    } else if (code.startsWith('LOOP_GUARD_WAIT_')) {
      guidance += 'Do not busy-poll this job. Use the existing completion notification; report the waiting limit if it is still running.';
    } else if (code === 'LOOP_GUARD_DUPLICATE') {
      guidance += `Tool "${name}" was called with identical arguments without producing new results. Stop repeating this action. Analyze the previous output, alter your parameters, try a different tool, or synthesize a direct textual answer.`;
    } else if (code === 'LOOP_GUARD_REPEAT') {
      guidance += `Tool "${name}" reached repetition limit without progress. Switch to an alternative exploration approach or answer directly.`;
    } else if (code === 'LOOP_GUARD_PROGRESS_LIMIT') {
      guidance += `Progress tool "${name}" repeatedly called without task changes. Stop updating task lists and proceed to execute or respond.`;
    } else if (code === 'LOOP_GUARD_LIMIT') {
      guidance += `Turn budget of ${this.config.maxToolAttemptsPerTurn} non-productive attempts exhausted. Cease tool execution and explain current progress or roadblock to the user.`;
    } else {
      guidance += 'Cease tool execution and provide a final text response. The next user turn will reset this guard.';
    }

    const feedback = code.startsWith('LOOP_GUARD_WAIT_')
      ? 'Waiting policy stopped this query; running status alone is not task progress.'
      : 'No productive progress was observed; provide the final text answer now.';
    return `[${code}] ${detail}. ${feedback} ${guidance}`;
  }

  emitDecision(state, call, fields) {
    const digest = key => key === undefined ? undefined : createHash('sha256').update(key).digest('hex');
    try {
      this.onDecision?.({
        callId: call.id, tool: call.tool,
        actionKey: digest(call.fingerprint), evidenceKey: digest(call.resultFingerprint),
        progressEpoch: state.progressEpoch, attemptsSinceProgress: state.attemptsSinceProgress,
        waitPollsThisTurn: state.waits.totalPolls, ...fields,
      });
    } catch (error) {
      this.logger?.debug?.('loopguard decision observer failed: ' + String(error));
    }
  }

  denyReason(agent, name, args, callId) {
    const state = this.stateFor(agent);
    if (state.stopRequested) {
      return this.violation(state, agent, name, args, callId, 'LOOP_GUARD_STOP', 'user requested stop; tools are disabled for this turn');
    }
    let jobStatus;
    if (this.config.semanticWaits && name === 'job_output' && typeof args?.job_id === 'string') {
      jobStatus = this.getJobStatus(agent, args.job_id);
    }
    const wait = this.config.semanticWaits ? state.waits.inspect(name, args, this.config, jobStatus) : undefined;
    const finalCollection = wait?.terminal && !wait.code && state.blockReason?.startsWith('LOOP_GUARD_WAIT_');
    if (state.answerOnly && !finalCollection) {
      const code = state.blockReason || 'LOOP_GUARD_STOP';
      return this.violation(state, agent, name, args, callId, code, state.stopReason || 'previous guard violation requires a text answer');
    }
    if (wait?.code) return this.violation(state, agent, name, args, callId, wait.code, wait.reason);
    const identityArgs = this.config.semanticActions ? actionArguments(name, args) : args;
    const fingerprint = callFingerprint(name, identityArgs);
    const repeatFingerprint = this.config.semanticActions && isShellTool(name)
      ? fingerprint : callRepeatFingerprint(name, args);
    const repeatGroup = state.repeatGroups.get(repeatFingerprint);
    const exactGroup = state.exactGroups.get(fingerprint);
    const repeatCount = repeatGroup?.progressEpoch === state.progressEpoch ? repeatGroup.count : 0;
    const exactCount = exactGroup?.progressEpoch === state.progressEpoch ? exactGroup.count : 0;

    const isStrictTool = this.strictTools.has(String(name));
    const maxRepeats = isStrictTool ? this.config.strictToolLimit : this.config.maxCallsPerRepeatGroup;

    if (!wait && this.config.blockExactDuplicates && exactCount >= 1) {
      return this.violation(state, agent, name, args, callId, 'LOOP_GUARD_DUPLICATE', 'identical tool call repeated without a new result or state change after ' + exactCount + ' attempts');
    }

    if (!wait && repeatCount >= maxRepeats) {
      const code = (this.config.blockExactDuplicates && exactCount >= maxRepeats) ? 'LOOP_GUARD_DUPLICATE' : 'LOOP_GUARD_REPEAT';
      return this.violation(state, agent, name, args, callId, code, 'near-identical tool call repeated without a new result or state change after ' + repeatCount + ' attempts');
    }
    const isProgressTool = this.progressToolNames.has(String(name));
    if (!wait && isProgressTool) {
      if (state.progressAttemptsSinceProgress >= this.config.maxProgressToolCallsPerTurn) {
        return this.violation(state, agent, name, args, callId, 'LOOP_GUARD_PROGRESS_LIMIT', 'progress/state tool budget exhausted without productive progress');
      }
    } else if (!wait && this.config.maxToolAttemptsPerTurn > 0 && state.attemptsSinceProgress >= this.config.maxToolAttemptsPerTurn) {
      return this.violation(state, agent, name, args, callId, 'LOOP_GUARD_LIMIT', 'tool budget exhausted without productive progress');
    }
    const id = typeof callId === 'string' && callId.length > 0 ? callId : 'anonymous-' + String(state.nextCallKey++);
    const priorRepeat = state.repeatGroups.get(repeatFingerprint);
    const priorExact = state.exactGroups.get(fingerprint);
    if (!wait) state.repeatGroups.set(repeatFingerprint, {
      count: (priorRepeat?.progressEpoch === state.progressEpoch ? priorRepeat.count : 0) + 1,
      progressEpoch: state.progressEpoch,
    });
    if (!wait) state.exactGroups.set(fingerprint, {
      count: (priorExact?.progressEpoch === state.progressEpoch ? priorExact.count : 0) + 1,
      progressEpoch: state.progressEpoch,
    });
    const call = {
      id,
      tool: String(name),
      args,
      fingerprint,
      repeatFingerprint,
      isProgressTool,
      pending: true,
      committed: false,
      released: false,
      counted: true,
      progressEpoch: state.progressEpoch,
      resultSeen: false,
      waitTicket: wait ? state.waits.reserve(wait, id) : undefined,
    };
    state.calls.push(call);
    if (!wait) state.attemptsSinceProgress += 1;
    if (!wait && isProgressTool) state.progressAttemptsSinceProgress += 1;
    this.emitDecision(state, call, { decision: wait ? 'wait' : 'allow', jobStatus: wait?.status });
    return undefined;
  }

  commitCall(agent, callId) {
    const state = this.byAgent.get(this.agentKey(agent));
    if (state === undefined) return;
    const call = this.findCall(state, callId);
    if (call !== undefined) {
      call.pending = false;
      call.committed = true;
    }
  }

  recordResult(agent, execution = {}) {
    const state = this.byAgent.get(this.agentKey(agent));
    if (state === undefined) return { known: false, productive: false };
    const call = this.findCall(state, execution.callId);
    if (call === undefined || call.resultSeen) return { known: false, productive: false };
    if (call.pending && !call.committed) {
      call.released = true;
      this.decrementReservations(state, call);
      return { known: false, productive: false };
    }
    let outcome = outcomeFromExecution(execution);
    const job = this.config.semanticWaits ? jobObservation(call.tool, call.args, execution.result) : undefined;
    if (call.waitTicket) state.waits.observe(call.waitTicket, job);
    const shell = this.config.semanticEvidence ? shellEvidence(call.tool, call.args, execution.result) : undefined;
    if (shell) {
      outcome = {
        known: true, successful: shell.status === 'succeeded',
        resultFingerprint: resultFingerprint(shell.evidence), progressToken: resultFingerprint(shell.evidence),
      };
    } else if (job) {
      outcome = {
        known: true, successful: job.status === 'completed',
        resultFingerprint: resultFingerprint(job), progressToken: resultFingerprint(job),
      };
    } else if (this.config.semanticWaits && call.tool === 'job_output') {
      // A malformed/foreign job DTO is not evidence of task progress.
      outcome = { ...outcome, successful: false };
    }
    call.pending = false;
    call.committed = true;
    call.resultSeen = true;
    call.resultFingerprint = outcome.resultFingerprint;
    call.progressToken = outcome.progressToken;
    const prior = state.lastEvidence;
    const priorForCall = state.lastResults.get(call.repeatFingerprint);
    const resultUnchangedForCall = priorForCall !== undefined
      && priorForCall.resultFingerprint === outcome.resultFingerprint
      && priorForCall.progressToken === outcome.progressToken;
    let productive = outcome.known && outcome.successful
      && !resultUnchangedForCall
      && (prior === undefined
        || prior.resultFingerprint !== outcome.resultFingerprint
        || prior.progressToken !== outcome.progressToken);
    if (shell) {
      const seen = state.semanticEvidence.get(call.fingerprint) ?? new Set();
      productive = shell.canProgress && !seen.has(outcome.resultFingerprint) && seen.size < 64;
      if (productive) seen.add(outcome.resultFingerprint);
      state.semanticEvidence.set(call.fingerprint, seen);
    } else if (job) {
      const terminalKey = `${job.id}:${job.status}`;
      productive = job.terminal && !state.jobTerminals.has(terminalKey);
      if (productive) state.jobTerminals.add(terminalKey);
    }
    call.productive = productive;
    state.lastResults.set(call.repeatFingerprint, outcome);
    if (productive) {
      state.lastEvidence = outcome;
      state.progressEpoch += 1;
      state.attemptsSinceProgress = 0;
      state.progressAttemptsSinceProgress = 0;
      state.repeatGroups.clear();
      state.exactGroups.clear();
      state.lastProgress = {
        callId: call.id,
        tool: call.fingerprint.split(':', 1)[0],
        resultFingerprint: outcome.resultFingerprint,
        progressToken: outcome.progressToken,
      };
    }
    this.emitDecision(state, call, {
      decision: 'observe', productive,
      adapter: shell?.adapter ?? (job ? 'job-lifecycle'
        : this.config.semanticWaits && call.tool === 'job_output' ? 'job-unknown' : 'generic'),
      status: shell?.status ?? job?.status ?? (outcome.successful ? 'tool-success' : 'tool-error-or-unknown'),
    });
    return { known: outcome.known, productive };
  }
}
