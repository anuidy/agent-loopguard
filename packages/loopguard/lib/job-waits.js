import { TERMINAL_JOB_STATES, waitRequest } from './tool-semantics.js';

// One ledger per session/turn. Progress epochs never refill its budgets.
export class JobWaitBudget {
  constructor(now) {
    this.now = now;
    this.jobs = new Map();
    this.totalPolls = 0;
  }

  inspect(name, args, config, lookupStatus) {
    if (!waitRequest(name, args)) return undefined;
    const entry = this.jobs.get(args.job_id);
    if (entry?.invalid) return undefined; // Unknown DTOs return to ordinary guard rules.
    const now = this.now();
    const status = lookupStatus ?? entry?.status ?? 'unknown';
    const terminal = TERMINAL_JOB_STATES.has(status);
    const view = { jobId: args.job_id, entry, status, terminal, now };
    const denied = (code, reason) => ({ ...view, code, reason });
    if (entry?.collected) return denied('LOOP_GUARD_WAIT_COLLECTED', 'terminal output was already collected');
    if (this.totalPolls >= config.maxWaitPollsPerTurn) {
      return denied('LOOP_GUARD_WAIT_BUDGET', 'total wait-query budget exhausted for this turn');
    }
    if (entry?.active > 0) return denied('LOOP_GUARD_WAIT_INFLIGHT', 'a query for this job is already in flight');
    // Permit one final collection after the registry reports settlement, even
    // when the job's own wait budget expired; the total turn cap still applies.
    if (terminal) return view;
    if ((entry?.polls ?? 0) >= config.maxWaitPollsPerJob) {
      return denied('LOOP_GUARD_WAIT_BUDGET', 'wait-query budget exhausted for this job');
    }
    const elapsed = entry ? now - entry.firstAt : 0;
    const requested = args.timeout_ms ?? 30_000;
    if (elapsed + requested > config.maxJobWaitMs) {
      return denied('LOOP_GUARD_WAIT_TIME', 'job wait deadline would be exceeded; use completion notifications');
    }
    if (entry && now - entry.lastAt < config.minJobPollIntervalMs) {
      return denied('LOOP_GUARD_WAIT_RATE', 'queries are too frequent; use wait or completion notifications');
    }
    return view;
  }

  reserve(view, callId) {
    const entry = view.entry ?? {
      firstAt: view.now, lastAt: -Infinity, polls: 0, active: 0,
      status: view.status, collected: false, invalid: false,
    };
    const ticket = { jobId: view.jobId, callId, priorLastAt: entry.lastAt, finished: false };
    entry.lastAt = view.now;
    entry.lastCallId = callId;
    entry.status = view.status;
    entry.polls += 1;
    entry.active += 1;
    this.totalPolls += 1;
    this.jobs.set(view.jobId, entry);
    return ticket;
  }

  release(ticket) {
    if (ticket.finished) return;
    ticket.finished = true;
    const entry = this.jobs.get(ticket.jobId);
    if (!entry) return;
    entry.active = Math.max(0, entry.active - 1);
    entry.polls = Math.max(0, entry.polls - 1);
    this.totalPolls = Math.max(0, this.totalPolls - 1);
    if (entry.lastCallId === ticket.callId) entry.lastAt = ticket.priorLastAt;
    if (entry.polls === 0) this.jobs.delete(ticket.jobId);
  }

  observe(ticket, observation) {
    if (ticket?.finished) return;
    if (ticket) {
      ticket.finished = true;
      const entry = this.jobs.get(ticket.jobId);
      if (entry) {
        entry.active = Math.max(0, entry.active - 1);
        entry.invalid = observation === undefined;
      }
    }
    if (!observation) return;
    const entry = this.jobs.get(observation.id);
    if (entry) {
      entry.status = observation.status;
      entry.collected = observation.terminal;
    }
  }
}
