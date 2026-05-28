import { describe, expect, it } from 'vitest';
import {
  createAsyncFanOutExecutionContext,
  createFanOutBranchId,
} from '../../services/execution/fanout/async-fanout-coordinator.js';
import {
  createBranchExecutionRecord,
  markBranchCompleted,
  markBranchExecuting,
  markBranchTimedOut,
  toBranchResult,
} from '../../services/execution/fanout/fanout-branch-state.js';
import {
  buildFanOutResultFromBranchResults,
  formatAsyncFanOutCompletionMessage,
  storeFanOutResultOnThread,
} from '../../services/execution/fanout/fanout-results.js';

describe('async fan-out coordinator scaffolding', () => {
  it('creates deterministic branch records with pending status', () => {
    const context = createAsyncFanOutExecutionContext({
      executionId: 'exec-1',
      barrierId: 'barrier-1',
      parentSessionId: 'session-1',
      parentExecutionId: 'parent-exec-1',
      parentThreadIndex: 0,
      timeoutMs: 30_000,
      createdAt: 100,
      branches: [
        {
          targetAgent: 'Billing_Agent',
          branchType: 'local_agent',
          threadIndex: 1,
          childSessionId: 'session-1__billing',
        },
        {
          targetAgent: 'Support_Agent',
          branchType: 'remote_agent',
          threadIndex: 2,
        },
        {
          targetAgent: 'lookup_order',
          branchType: 'tool',
        },
      ],
    });

    expect(context.branches).toHaveLength(3);
    expect(context.branches.map((branch) => branch.branchId)).toEqual([
      createFanOutBranchId({
        executionId: 'exec-1',
        targetAgent: 'Billing_Agent',
        branchType: 'local_agent',
        ordinal: 0,
      }),
      createFanOutBranchId({
        executionId: 'exec-1',
        targetAgent: 'Support_Agent',
        branchType: 'remote_agent',
        ordinal: 1,
      }),
      createFanOutBranchId({
        executionId: 'exec-1',
        targetAgent: 'lookup_order',
        branchType: 'tool',
        ordinal: 2,
      }),
    ]);
    expect(context.branches.every((branch) => branch.status === 'pending')).toBe(true);
    expect(context.branches[0]).toEqual(
      expect.objectContaining({
        childSessionId: 'session-1__billing',
        threadIndex: 1,
      }),
    );
  });

  it('treats duplicate terminal transitions as no-ops', () => {
    const branch = createBranchExecutionRecord({
      branchId: 'branch-1',
      barrierId: 'barrier-1',
      parentExecutionId: 'parent-exec-1',
      targetAgent: 'Billing_Agent',
      branchType: 'remote_agent',
      threadIndex: 1,
      createdAt: 100,
    });

    const executing = markBranchExecuting(branch, 110);
    expect(executing.accepted).toBe(true);
    expect(executing.record.status).toBe('executing');

    const completed = markBranchCompleted(executing.record, {
      response: 'done',
      completedAt: 120,
    });
    expect(completed.accepted).toBe(true);
    expect(completed.record.status).toBe('completed');

    const duplicateTimeout = markBranchTimedOut(completed.record, {
      error: 'late timeout',
      completedAt: 130,
    });
    expect(duplicateTimeout.accepted).toBe(false);
    expect(duplicateTimeout.record).toBe(completed.record);
    expect(duplicateTimeout.record.status).toBe('completed');
  });

  it('maps terminal branch records to barrier branch results', () => {
    const completed = markBranchCompleted(
      createBranchExecutionRecord({
        branchId: 'branch-2',
        barrierId: 'barrier-2',
        parentExecutionId: 'parent-exec-2',
        targetAgent: 'Support_Agent',
        branchType: 'local_agent',
        threadIndex: 3,
        createdAt: 200,
      }),
      {
        response: 'hello',
        completedAt: 240,
      },
    ).record;

    expect(toBranchResult(completed)).toEqual({
      branchId: 'branch-2',
      branchAgent: 'Support_Agent',
      status: 'completed',
      response: 'hello',
      error: undefined,
      gatheredData: undefined,
      completedAt: 240,
    });

    const timedOut = markBranchTimedOut(
      createBranchExecutionRecord({
        branchId: 'branch-3',
        barrierId: 'barrier-2',
        parentExecutionId: 'parent-exec-2',
        targetAgent: 'Orders_Agent',
        branchType: 'remote_agent',
        threadIndex: 4,
        createdAt: 200,
      }),
      {
        error: 'Timed out waiting for callback',
        completedAt: 260,
      },
    ).record;

    expect(toBranchResult(timedOut)).toEqual({
      branchId: 'branch-3',
      branchAgent: 'Orders_Agent',
      status: 'timeout',
      response: undefined,
      error: 'Timed out waiting for callback',
      gatheredData: undefined,
      completedAt: 260,
    });
  });

  it('normalizes barrier branch results into the runtime fan-out contract', () => {
    const fanOutResult = buildFanOutResultFromBranchResults({
      second: {
        branchId: 'branch-2',
        branchAgent: 'Shipping_Agent',
        status: 'timeout',
        error: 'Timed out waiting for callback',
        completedAt: 220,
      },
      first: {
        branchId: 'branch-1',
        branchAgent: 'Billing_Agent',
        status: 'completed',
        response: 'The invoice has been updated.',
        completedAt: 210,
      },
    });

    expect(fanOutResult).toEqual({
      success: true,
      results: [
        {
          target: 'Billing_Agent',
          status: 'completed',
          response: 'The invoice has been updated.',
          gatheredData: undefined,
        },
        {
          target: 'Shipping_Agent',
          status: 'error',
          error: "I couldn't complete Shipping_Agent before the async timeout.",
          gatheredData: undefined,
        },
      ],
      failedCount: 1,
    });

    expect(formatAsyncFanOutCompletionMessage(fanOutResult)).toContain(
      'Additional async routing results are ready.',
    );
  });

  it('stores fan-out result snapshots on the parent thread data contract', () => {
    const thread = {
      data: {
        values: {},
      },
    } as any;

    storeFanOutResultOnThread(thread, {
      success: true,
      results: [
        {
          target: 'Billing_Agent',
          status: 'completed',
          response: 'Done',
        },
        {
          target: 'Shipping_Agent',
          status: 'error',
          error: 'Timed out',
        },
      ],
      failedCount: 1,
    });

    expect(thread.data.values._last_fan_out).toEqual(
      expect.objectContaining({
        results: [
          {
            target: 'Billing_Agent',
            status: 'completed',
            response: 'Done',
          },
          {
            target: 'Shipping_Agent',
            status: 'error',
            response: 'Timed out',
          },
        ],
      }),
    );
    expect(thread.data.values._fan_out_result_Billing_Agent).toBe('Done');
    expect(thread.data.values._fan_out_result_Shipping_Agent).toBe('Timed out');
  });
});
