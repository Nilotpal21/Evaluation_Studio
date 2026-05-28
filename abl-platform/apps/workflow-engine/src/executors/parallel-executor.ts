/**
 * Parallel Step Executor
 *
 * Executes multiple branches concurrently with configurable failure strategy.
 * Each branch is a named group of steps executed by the provided step runner.
 */

import { MAX_PARALLEL_BRANCHES } from '../constants.js';

export interface ParallelStep {
  id: string;
  type: 'parallel';
  branches: ParallelBranch[];
  failureStrategy: 'fail_fast' | 'wait_all' | 'ignore_errors';
}

export interface ParallelBranch {
  name: string;
  steps: string[];
}

export interface BranchResult {
  name: string;
  status: 'completed' | 'failed';
  output?: unknown;
  error?: { code: string; message: string };
}

export interface ParallelResult {
  branches: BranchResult[];
  allSucceeded: boolean;
}

/** Callback that executes a named branch and returns its output */
export type BranchRunner = (branch: ParallelBranch) => Promise<unknown>;

/**
 * Execute parallel branches with the specified failure strategy.
 *
 * - fail_fast: Rejects immediately when any branch fails (Promise.all semantics)
 * - wait_all: Waits for all branches, collects results (Promise.allSettled semantics)
 * - ignore_errors: Same as wait_all but always reports allSucceeded as true
 */
export async function executeParallel(
  step: ParallelStep,
  runner: BranchRunner,
): Promise<ParallelResult> {
  const { branches, failureStrategy } = step;

  if (branches.length > MAX_PARALLEL_BRANCHES) {
    throw new Error(
      `Parallel step "${step.id}" has ${branches.length} branches, exceeding the maximum of ${MAX_PARALLEL_BRANCHES}`,
    );
  }

  if (failureStrategy === 'fail_fast') {
    return executeFailFast(branches, runner);
  }

  return executeWaitAll(branches, runner, failureStrategy === 'ignore_errors');
}

async function executeFailFast(
  branches: ParallelBranch[],
  runner: BranchRunner,
): Promise<ParallelResult> {
  const promises = branches.map(async (branch): Promise<BranchResult> => {
    const output = await runner(branch);
    return { name: branch.name, status: 'completed', output };
  });

  const results = await Promise.all(promises);
  return { branches: results, allSucceeded: true };
}

async function executeWaitAll(
  branches: ParallelBranch[],
  runner: BranchRunner,
  ignoreErrors: boolean,
): Promise<ParallelResult> {
  const promises = branches.map(async (branch): Promise<BranchResult> => {
    try {
      const output = await runner(branch);
      return { name: branch.name, status: 'completed', output };
    } catch (err) {
      return {
        name: branch.name,
        status: 'failed',
        error: {
          code: 'BRANCH_EXECUTION_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  });

  const results = await Promise.all(promises);
  const allSucceeded = ignoreErrors || results.every((r) => r.status === 'completed');

  return { branches: results, allSucceeded };
}
