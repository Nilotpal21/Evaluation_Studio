import type { BranchResult } from '@agent-platform/execution';

export type BranchExecutionType = 'local_agent' | 'remote_agent' | 'tool';

export type BranchExecutionStatus = 'pending' | 'executing' | 'completed' | 'failed' | 'timed_out';

export interface BranchExecutionRecord {
  branchId: string;
  barrierId: string;
  parentExecutionId: string;
  targetAgent: string;
  branchType: BranchExecutionType;
  threadIndex?: number;
  childSessionId?: string;
  status: BranchExecutionStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  response?: string;
  error?: string;
  gatheredData?: Record<string, unknown>;
}

export interface BranchExecutionTransition {
  accepted: boolean;
  previousStatus: BranchExecutionStatus;
  record: BranchExecutionRecord;
}

export function createBranchExecutionRecord(params: {
  branchId: string;
  barrierId: string;
  parentExecutionId: string;
  targetAgent: string;
  branchType: BranchExecutionType;
  threadIndex?: number;
  childSessionId?: string;
  createdAt?: number;
}): BranchExecutionRecord {
  return {
    branchId: params.branchId,
    barrierId: params.barrierId,
    parentExecutionId: params.parentExecutionId,
    targetAgent: params.targetAgent,
    branchType: params.branchType,
    threadIndex: params.threadIndex,
    childSessionId: params.childSessionId,
    status: 'pending',
    createdAt: params.createdAt ?? Date.now(),
  };
}

export function isBranchExecutionTerminal(
  recordOrStatus: BranchExecutionRecord | BranchExecutionStatus,
): boolean {
  const status = typeof recordOrStatus === 'string' ? recordOrStatus : recordOrStatus.status;

  return status === 'completed' || status === 'failed' || status === 'timed_out';
}

export function markBranchExecuting(
  record: BranchExecutionRecord,
  startedAt = Date.now(),
): BranchExecutionTransition {
  if (isBranchExecutionTerminal(record)) {
    return {
      accepted: false,
      previousStatus: record.status,
      record,
    };
  }

  return {
    accepted: true,
    previousStatus: record.status,
    record: {
      ...record,
      status: 'executing',
      startedAt,
    },
  };
}

export function markBranchCompleted(
  record: BranchExecutionRecord,
  params?: {
    response?: string;
    gatheredData?: Record<string, unknown>;
    completedAt?: number;
  },
): BranchExecutionTransition {
  return markBranchTerminal(record, 'completed', params);
}

export function markBranchFailed(
  record: BranchExecutionRecord,
  params?: {
    error?: string;
    completedAt?: number;
  },
): BranchExecutionTransition {
  return markBranchTerminal(record, 'failed', params);
}

export function markBranchTimedOut(
  record: BranchExecutionRecord,
  params?: {
    error?: string;
    completedAt?: number;
  },
): BranchExecutionTransition {
  return markBranchTerminal(record, 'timed_out', params);
}

export function toBranchResult(record: BranchExecutionRecord): BranchResult | null {
  if (!isBranchExecutionTerminal(record)) {
    return null;
  }

  const status =
    record.status === 'failed' ? 'error' : record.status === 'timed_out' ? 'timeout' : 'completed';

  return {
    branchId: record.branchId,
    branchAgent: record.targetAgent,
    status,
    response: record.response,
    error: record.error,
    gatheredData: record.gatheredData,
    completedAt: record.completedAt ?? record.createdAt,
  };
}

function markBranchTerminal(
  record: BranchExecutionRecord,
  nextStatus: Extract<BranchExecutionStatus, 'completed' | 'failed' | 'timed_out'>,
  params?: {
    response?: string;
    error?: string;
    gatheredData?: Record<string, unknown>;
    completedAt?: number;
  },
): BranchExecutionTransition {
  if (isBranchExecutionTerminal(record)) {
    return {
      accepted: false,
      previousStatus: record.status,
      record,
    };
  }

  return {
    accepted: true,
    previousStatus: record.status,
    record: {
      ...record,
      status: nextStatus,
      response: params?.response ?? record.response,
      error: params?.error ?? record.error,
      gatheredData: params?.gatheredData ?? record.gatheredData,
      completedAt: params?.completedAt ?? Date.now(),
    },
  };
}
