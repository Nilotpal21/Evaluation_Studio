import { describe, it, expect, vi } from 'vitest';
import {
  executeParallel,
  type ParallelStep,
  type BranchRunner,
} from '../executors/parallel-executor.js';

function makeStep(failureStrategy: 'fail_fast' | 'wait_all' | 'ignore_errors'): ParallelStep {
  return {
    id: 'par-1',
    type: 'parallel',
    branches: [
      { name: 'branch-a', steps: ['step-a1'] },
      { name: 'branch-b', steps: ['step-b1'] },
      { name: 'branch-c', steps: ['step-c1'] },
    ],
    failureStrategy,
  };
}

describe('executeParallel', () => {
  describe('fail_fast strategy', () => {
    it('returns all results when all branches succeed', async () => {
      const runner: BranchRunner = vi
        .fn()
        .mockImplementation(async (branch) => ({ result: branch.name }));

      const result = await executeParallel(makeStep('fail_fast'), runner);

      expect(result.allSucceeded).toBe(true);
      expect(result.branches).toHaveLength(3);
      expect(result.branches[0]).toEqual({
        name: 'branch-a',
        status: 'completed',
        output: { result: 'branch-a' },
      });
    });

    it('throws when any branch fails', async () => {
      const runner: BranchRunner = vi.fn().mockImplementation(async (branch) => {
        if (branch.name === 'branch-b') throw new Error('Branch B failed');
        return { result: branch.name };
      });

      await expect(executeParallel(makeStep('fail_fast'), runner)).rejects.toThrow(
        'Branch B failed',
      );
    });
  });

  describe('wait_all strategy', () => {
    it('returns all results when all branches succeed', async () => {
      const runner: BranchRunner = vi
        .fn()
        .mockImplementation(async (branch) => ({ result: branch.name }));

      const result = await executeParallel(makeStep('wait_all'), runner);

      expect(result.allSucceeded).toBe(true);
      expect(result.branches).toHaveLength(3);
      expect(result.branches.every((b) => b.status === 'completed')).toBe(true);
    });

    it('collects failures without throwing', async () => {
      const runner: BranchRunner = vi.fn().mockImplementation(async (branch) => {
        if (branch.name === 'branch-b') throw new Error('Branch B failed');
        return { result: branch.name };
      });

      const result = await executeParallel(makeStep('wait_all'), runner);

      expect(result.allSucceeded).toBe(false);
      expect(result.branches).toHaveLength(3);

      const failed = result.branches.find((b) => b.name === 'branch-b');
      expect(failed?.status).toBe('failed');
      expect(failed?.error?.message).toBe('Branch B failed');

      const succeeded = result.branches.filter((b) => b.status === 'completed');
      expect(succeeded).toHaveLength(2);
    });
  });

  describe('ignore_errors strategy', () => {
    it('reports allSucceeded true even with failures', async () => {
      const runner: BranchRunner = vi.fn().mockImplementation(async (branch) => {
        if (branch.name === 'branch-c') throw new Error('Branch C failed');
        return { result: branch.name };
      });

      const result = await executeParallel(makeStep('ignore_errors'), runner);

      expect(result.allSucceeded).toBe(true);
      expect(result.branches).toHaveLength(3);

      const failed = result.branches.find((b) => b.name === 'branch-c');
      expect(failed?.status).toBe('failed');
    });
  });

  it('runs branches concurrently', async () => {
    const order: string[] = [];
    const runner: BranchRunner = vi.fn().mockImplementation(async (branch) => {
      order.push(`start:${branch.name}`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`end:${branch.name}`);
      return {};
    });

    await executeParallel(makeStep('wait_all'), runner);

    // All branches should start before any ends
    const firstEnd = order.findIndex((s) => s.startsWith('end:'));
    const starts = order.slice(0, firstEnd).filter((s) => s.startsWith('start:'));
    expect(starts.length).toBeGreaterThanOrEqual(2);
  });
});
