import crypto from 'crypto';
import {
  classifyBranchCompletionAttempt,
  getBranchResultKey,
  type BranchResult,
  type BranchCompletionDisposition,
  type FanOutBarrier,
  type FanOutBarrierStore,
} from './fan-out-barrier.js';

interface InMemoryFanOutBarrierStoreOptions {
  maxBarriers?: number;
  cleanupIntervalMs?: number;
  cleanupGraceMs?: number;
}

interface StoredBarrierState {
  barrier: FanOutBarrier;
  results: Map<string, BranchResult>;
}

const DEFAULT_MAX_BARRIERS = 2_000;
const DEFAULT_BARRIER_CLEANUP_INTERVAL_MS = 60_000;
const DEFAULT_BARRIER_CLEANUP_GRACE_MS = 300_000;

/**
 * Single-process barrier store for test/dev harnesses.
 *
 * Keeps the hardened contract executable without Redis while preserving
 * idempotent completion and late-arrival handling.
 */
export class InMemoryFanOutBarrierStore implements FanOutBarrierStore {
  private readonly barriers = new Map<string, StoredBarrierState>();
  private readonly maxBarriers: number;
  private readonly cleanupIntervalMs: number;
  private readonly cleanupGraceMs: number;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(options: InMemoryFanOutBarrierStoreOptions = {}) {
    this.maxBarriers = options.maxBarriers ?? DEFAULT_MAX_BARRIERS;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_BARRIER_CLEANUP_INTERVAL_MS;
    this.cleanupGraceMs = options.cleanupGraceMs ?? DEFAULT_BARRIER_CLEANUP_GRACE_MS;
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), this.cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  async create(params: {
    parentSessionId: string;
    parentExecutionId: string;
    tenantId: string;
    totalBranches: number;
    timeoutMs: number;
  }): Promise<string> {
    this.cleanupExpired();
    this.evictOverflow(this.maxBarriers - 1);

    const barrierId = crypto.randomUUID();
    const now = Date.now();
    this.barriers.set(barrierId, {
      barrier: {
        barrierId,
        parentSessionId: params.parentSessionId,
        parentExecutionId: params.parentExecutionId,
        tenantId: params.tenantId,
        totalBranches: params.totalBranches,
        completedBranches: 0,
        createdAt: now,
        expiresAt: now + params.timeoutMs,
        status: 'open',
        parentResumeReady: false,
        terminalBranches: 0,
        ignoredLateArrivals: 0,
      },
      results: new Map(),
    });
    return barrierId;
  }

  async completeBranch(
    barrierId: string,
    result: BranchResult,
  ): Promise<{
    allComplete: boolean;
    completedCount: number;
    totalCount: number;
    disposition?: BranchCompletionDisposition;
    branchKey?: string;
    parentResumeReady?: boolean;
  }> {
    const now = Date.now();
    const state = this.barriers.get(barrierId);
    const barrier = this.ensureBarrierState(state, now)?.barrier ?? null;

    const decision = classifyBranchCompletionAttempt({
      barrier,
      existingResults: Object.fromEntries(state?.results ?? []),
      result,
      now,
    });

    if (!state || decision.disposition === 'barrier_missing') {
      return {
        allComplete: false,
        completedCount: 0,
        totalCount: 0,
        disposition: 'barrier_missing',
        branchKey: decision.branchKey,
        parentResumeReady: false,
      };
    }

    if (decision.disposition === 'ignored_late') {
      state.barrier.ignoredLateArrivals = (state.barrier.ignoredLateArrivals ?? 0) + 1;
      return this.buildOutcome(state.barrier, decision.disposition, decision.branchKey);
    }

    if (decision.disposition === 'duplicate') {
      return this.buildOutcome(state.barrier, decision.disposition, decision.branchKey);
    }

    const branchKey = getBranchResultKey(result);
    state.results.set(branchKey, {
      ...result,
      branchId: result.branchId,
    });
    state.barrier.completedBranches += 1;
    state.barrier.terminalBranches = state.barrier.completedBranches;

    if (
      state.barrier.completedBranches >= state.barrier.totalBranches &&
      !state.barrier.parentResumeReady
    ) {
      state.barrier.parentResumeReady = true;
      state.barrier.status = 'completed';
      state.barrier.closedAt = now;
    }

    return this.buildOutcome(state.barrier, decision.disposition, branchKey);
  }

  async get(barrierId: string): Promise<FanOutBarrier | null> {
    const state = this.barriers.get(barrierId);
    if (!state) {
      return null;
    }

    this.ensureBarrierState(state, Date.now());
    return { ...state.barrier };
  }

  async getResults(barrierId: string): Promise<Record<string, BranchResult>> {
    const state = this.barriers.get(barrierId);
    if (!state) {
      return {};
    }

    const result: Record<string, BranchResult> = {};
    for (const [branchKey, branchResult] of state.results.entries()) {
      result[branchKey] = { ...branchResult };
    }
    return result;
  }

  async setParentSuspension(barrierId: string, suspensionId: string): Promise<void> {
    const state = this.barriers.get(barrierId);
    if (!state) {
      return;
    }
    state.barrier.parentSuspensionId = suspensionId;
  }

  async getParentSuspension(barrierId: string): Promise<string | null> {
    const state = this.barriers.get(barrierId);
    return state?.barrier.parentSuspensionId ?? null;
  }

  async cancel(barrierId: string, _reason: string): Promise<void> {
    const state = this.barriers.get(barrierId);
    if (!state) {
      return;
    }

    state.barrier.status = 'cancelled';
    state.barrier.closedAt = Date.now();
  }

  async delete(barrierId: string): Promise<void> {
    this.barriers.delete(barrierId);
  }

  private ensureBarrierState(
    state: StoredBarrierState | undefined,
    now: number,
  ): StoredBarrierState | undefined {
    if (!state) {
      return undefined;
    }

    if (state.barrier.status === 'open' && state.barrier.expiresAt <= now) {
      state.barrier.status = 'expired';
      state.barrier.closedAt = now;
    }

    return state;
  }

  private buildOutcome(
    barrier: FanOutBarrier,
    disposition: BranchCompletionDisposition,
    branchKey: string,
  ): {
    allComplete: boolean;
    completedCount: number;
    totalCount: number;
    disposition: BranchCompletionDisposition;
    branchKey: string;
    parentResumeReady: boolean;
  } {
    return {
      allComplete: barrier.completedBranches >= barrier.totalBranches && barrier.totalBranches > 0,
      completedCount: barrier.completedBranches,
      totalCount: barrier.totalBranches,
      disposition,
      branchKey,
      parentResumeReady: barrier.parentResumeReady === true,
    };
  }

  private cleanupExpired(now = Date.now()): void {
    for (const [barrierId, state] of this.barriers.entries()) {
      this.ensureBarrierState(state, now);
      const terminalAt = state.barrier.closedAt ?? state.barrier.expiresAt;
      if (terminalAt + this.cleanupGraceMs <= now) {
        this.barriers.delete(barrierId);
      }
    }
  }

  private evictOverflow(targetSize: number): void {
    if (this.barriers.size <= targetSize) {
      return;
    }

    const ordered = [...this.barriers.entries()].sort((left, right) => {
      const leftTerminal = left[1].barrier.closedAt ?? left[1].barrier.expiresAt;
      const rightTerminal = right[1].barrier.closedAt ?? right[1].barrier.expiresAt;
      if (leftTerminal !== rightTerminal) {
        return leftTerminal - rightTerminal;
      }
      return left[1].barrier.createdAt - right[1].barrier.createdAt;
    });

    while (this.barriers.size > targetSize && ordered.length > 0) {
      const next = ordered.shift();
      if (!next) {
        break;
      }
      this.barriers.delete(next[0]);
    }
  }
}
