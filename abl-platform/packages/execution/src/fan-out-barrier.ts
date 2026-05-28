/**
 * FanOutBarrier — distributed coordination for mixed sync/async fan-out.
 *
 * When a fan-out execution includes both local (fast, synchronous) and remote
 * (slow, asynchronous) branches, the barrier:
 * - Tracks how many branches have completed
 * - Stores each branch's result
 * - Detects when all branches are done and triggers parent resumption
 *
 * Redis-backed with atomic Lua scripts for concurrent-safe operations.
 */

export type BranchResultStatus = 'completed' | 'error' | 'timeout' | 'cancelled';

export type FanOutBarrierStatus = 'open' | 'completed' | 'cancelled' | 'expired';

export type BranchCompletionDisposition =
  | 'recorded'
  | 'duplicate'
  | 'ignored_late'
  | 'barrier_missing';

export interface BranchResult {
  /**
   * Stable branch identifier used by the hardened async fan-out path.
   *
   * Legacy producers may omit this field; stores should fall back to
   * `branchAgent` until all old writers are removed.
   */
  branchId?: string;
  branchAgent: string;
  status: BranchResultStatus;
  response?: string;
  error?: string;
  gatheredData?: Record<string, unknown>;
  completedAt: number;
}

export interface FanOutBarrier {
  barrierId: string;
  parentSessionId: string;
  parentExecutionId: string;
  tenantId: string;
  totalBranches: number;
  completedBranches: number;
  createdAt: number;
  expiresAt: number;
  /**
   * Additive lifecycle marker for the hardened async fan-out contract.
   * Existing stores may omit it and are treated as `open`.
   */
  status?: FanOutBarrierStatus;
  /** True once the barrier determines the parent can resume. */
  parentResumeReady?: boolean;
  /** Timestamp when the barrier entered a terminal state. */
  closedAt?: number;
  /** Terminal branch count for visibility/debugging. */
  terminalBranches?: number;
  /** Count of ignored late callbacks after close/expiry. */
  ignoredLateArrivals?: number;
  /** Suspension ID of the parent execution (set when parent suspends) */
  parentSuspensionId?: string;
}

export interface BranchCompletionDecision {
  branchKey: string;
  disposition: BranchCompletionDisposition;
  shouldRecord: boolean;
}

export interface BranchCompletionOutcome {
  allComplete: boolean;
  completedCount: number;
  totalCount: number;
  /** Additive metadata for the hardened async fan-out contract. */
  disposition?: BranchCompletionDisposition;
  branchKey?: string;
  parentResumeReady?: boolean;
}

export function getBranchResultKey(result: Pick<BranchResult, 'branchId' | 'branchAgent'>): string {
  return result.branchId ?? result.branchAgent;
}

export function isBarrierClosed(
  barrier: Pick<FanOutBarrier, 'status' | 'expiresAt'>,
  now = Date.now(),
): boolean {
  if (barrier.status && barrier.status !== 'open') {
    return true;
  }

  return barrier.expiresAt > 0 && barrier.expiresAt <= now;
}

export function classifyBranchCompletionAttempt(params: {
  barrier: Pick<FanOutBarrier, 'status' | 'expiresAt'> | null | undefined;
  existingResults: Readonly<Record<string, Pick<BranchResult, 'branchId' | 'branchAgent'>>>;
  result: Pick<BranchResult, 'branchId' | 'branchAgent'>;
  now?: number;
}): BranchCompletionDecision {
  const branchKey = getBranchResultKey(params.result);

  if (!params.barrier) {
    return {
      branchKey,
      disposition: 'barrier_missing',
      shouldRecord: false,
    };
  }

  if (isBarrierClosed(params.barrier, params.now)) {
    return {
      branchKey,
      disposition: 'ignored_late',
      shouldRecord: false,
    };
  }

  const hasExistingResult = Object.values(params.existingResults).some(
    (existing) => getBranchResultKey(existing) === branchKey,
  );
  if (hasExistingResult) {
    return {
      branchKey,
      disposition: 'duplicate',
      shouldRecord: false,
    };
  }

  return {
    branchKey,
    disposition: 'recorded',
    shouldRecord: true,
  };
}

export interface FanOutBarrierStore {
  /**
   * Create a new barrier for N branches.
   * Returns the barrierId (UUID).
   */
  create(params: {
    parentSessionId: string;
    parentExecutionId: string;
    tenantId: string;
    totalBranches: number;
    timeoutMs: number;
  }): Promise<string>;

  /**
   * Record a branch completion. Returns whether all branches are done.
   *
   * Hardened stores must treat completion as idempotent per branch key:
   * 1. Resolve the branch key from `branchId ?? branchAgent`
   * 2. Ignore late arrivals for closed/cancelled/expired barriers
   * 3. Ignore duplicate terminal completions for the same branch key
   * 4. Increment terminal counts exactly once per branch
   *
   * Legacy stores may still only return the base counts while the Phase 3a
   * contract is being adopted; additive fields remain optional for now.
   */
  completeBranch(barrierId: string, result: BranchResult): Promise<BranchCompletionOutcome>;

  /** Get current barrier state. */
  get(barrierId: string): Promise<FanOutBarrier | null>;

  /** Get all branch results for a barrier. */
  getResults(barrierId: string): Promise<Record<string, BranchResult>>;

  /** Set the parent suspension ID (called when parent suspends after local branches finish). */
  setParentSuspension(barrierId: string, suspensionId: string): Promise<void>;

  /** Get the parent suspension ID. */
  getParentSuspension(barrierId: string): Promise<string | null>;

  /** Cancel a barrier and all pending branches. */
  cancel(barrierId: string, reason: string): Promise<void>;

  /** Delete a barrier (cleanup after all branches complete). */
  delete(barrierId: string): Promise<void>;
}
