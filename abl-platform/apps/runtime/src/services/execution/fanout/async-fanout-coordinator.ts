import type { SuspendedContinuation, SuspensionReason } from '@agent-platform/execution';
import {
  createBranchExecutionRecord,
  type BranchExecutionRecord,
  type BranchExecutionType,
} from './fanout-branch-state.js';

export interface AsyncFanOutBranchSpec {
  targetAgent: string;
  branchType: BranchExecutionType;
  threadIndex?: number;
  childSessionId?: string;
  branchId?: string;
}

export interface AsyncFanOutExecutionContext {
  executionId: string;
  barrierId: string;
  parentSessionId: string;
  parentExecutionId: string;
  parentThreadIndex: number;
  timeoutMs: number;
  createdAt: number;
  branches: BranchExecutionRecord[];
}

export interface FanOutRemoteBranchSuspensionContract {
  reason: Extract<SuspensionReason, { type: 'fan_out_remote_branch' }>;
  continuation: Extract<SuspendedContinuation, { type: 'fan_out_remote_branch' }>;
}

export interface FanOutParentResumeSuspensionContract {
  reason: Extract<SuspensionReason, { type: 'fan_out_parent_resume' }>;
  continuation: Extract<SuspendedContinuation, { type: 'fan_out_parent_resume' }>;
}

export function createFanOutBranchId(params: {
  executionId: string;
  targetAgent: string;
  branchType: BranchExecutionType;
  ordinal: number;
}): string {
  const normalizedTarget = params.targetAgent.replace(/[^A-Za-z0-9_-]+/g, '_');
  return `${params.executionId}:${params.branchType}:${normalizedTarget}:${params.ordinal}`;
}

export function createAsyncFanOutExecutionContext(params: {
  executionId: string;
  barrierId: string;
  parentSessionId: string;
  parentExecutionId: string;
  parentThreadIndex: number;
  timeoutMs: number;
  branches: AsyncFanOutBranchSpec[];
  createdAt?: number;
}): AsyncFanOutExecutionContext {
  const createdAt = params.createdAt ?? Date.now();

  return {
    executionId: params.executionId,
    barrierId: params.barrierId,
    parentSessionId: params.parentSessionId,
    parentExecutionId: params.parentExecutionId,
    parentThreadIndex: params.parentThreadIndex,
    timeoutMs: params.timeoutMs,
    createdAt,
    branches: params.branches.map((branch, index) =>
      createBranchExecutionRecord({
        branchId:
          branch.branchId ??
          createFanOutBranchId({
            executionId: params.executionId,
            targetAgent: branch.targetAgent,
            branchType: branch.branchType,
            ordinal: index,
          }),
        barrierId: params.barrierId,
        parentExecutionId: params.parentExecutionId,
        targetAgent: branch.targetAgent,
        branchType: branch.branchType,
        threadIndex: branch.threadIndex,
        childSessionId: branch.childSessionId,
        createdAt,
      }),
    ),
  };
}

export function buildRemoteBranchSuspensionContract(params: {
  branch: Pick<BranchExecutionRecord, 'branchId' | 'targetAgent' | 'threadIndex'>;
  barrierId: string;
  parentExecutionId: string;
  callbackId: string;
  timeoutSeconds: number;
}): FanOutRemoteBranchSuspensionContract {
  if (params.branch.threadIndex == null) {
    throw new Error('Remote fan-out branches require a threadIndex before suspension creation');
  }

  return {
    reason: {
      type: 'fan_out_remote_branch',
      target: params.branch.targetAgent,
      barrierId: params.barrierId,
      branchId: params.branch.branchId,
      callbackId: params.callbackId,
      timeout: params.timeoutSeconds,
    },
    continuation: {
      type: 'fan_out_remote_branch',
      barrierId: params.barrierId,
      branchId: params.branch.branchId,
      branchAgent: params.branch.targetAgent,
      threadIndex: params.branch.threadIndex,
      parentExecutionId: params.parentExecutionId,
    },
  };
}

export function buildParentResumeSuspensionContract(params: {
  barrierId: string;
  parentThreadIndex: number;
  parentExecutionId: string;
  callbackId: string;
  timeoutSeconds: number;
}): FanOutParentResumeSuspensionContract {
  return {
    reason: {
      type: 'fan_out_parent_resume',
      barrierId: params.barrierId,
      callbackId: params.callbackId,
      timeout: params.timeoutSeconds,
    },
    continuation: {
      type: 'fan_out_parent_resume',
      barrierId: params.barrierId,
      parentThreadIndex: params.parentThreadIndex,
      parentExecutionId: params.parentExecutionId,
    },
  };
}
