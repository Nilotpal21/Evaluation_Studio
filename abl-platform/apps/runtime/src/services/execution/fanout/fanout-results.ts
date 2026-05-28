import type { BranchResult } from '@agent-platform/execution';
import type { AgentThread, FanOutResult, SubTaskResult } from '../types.js';

export function buildFanOutResultFromBranchResults(
  resultsByKey: Readonly<Record<string, BranchResult>>,
): FanOutResult {
  const results = Object.values(resultsByKey)
    .sort((left, right) => left.completedAt - right.completedAt)
    .map(mapBranchResultToSubTaskResult);

  return {
    success: results.some((result) => result.status === 'completed'),
    results,
    failedCount: results.filter((result) => result.status === 'error').length,
  };
}

export function storeFanOutResultOnThread(
  thread: Pick<AgentThread, 'data'>,
  fanOutResult: FanOutResult,
  timestamp = Date.now(),
): void {
  thread.data.values._last_fan_out = {
    timestamp,
    results: fanOutResult.results.map((result) => ({
      target: result.target,
      status: result.status,
      response: result.response || result.error,
    })),
  };

  for (const result of fanOutResult.results) {
    const key = `_fan_out_result_${result.target}`;
    thread.data.values[key] = result.status === 'completed' ? result.response : result.error;
  }
}

export function formatAsyncFanOutCompletionMessage(fanOutResult: FanOutResult): string {
  const completed = fanOutResult.results.filter(
    (result) => result.status === 'completed' && result.response,
  );
  const failed = fanOutResult.results.filter((result) => result.status === 'error');
  const lines: string[] = [];

  if (completed.length === 1 && failed.length === 0) {
    return completed[0].response ?? `Async fan-out completed for ${completed[0].target}.`;
  }

  if (fanOutResult.results.length > 0) {
    lines.push('Additional async routing results are ready.');
  }

  if (completed.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }

    for (const result of completed) {
      lines.push(`[${result.target}] ${result.response}`);
    }
  }

  if (failed.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }

    for (const result of failed) {
      lines.push(result.error ?? `I couldn't complete ${result.target} right now.`);
    }
  }

  return lines.join('\n').trim() || 'Async routing completed.';
}

function mapBranchResultToSubTaskResult(result: BranchResult): SubTaskResult {
  if (result.status === 'completed') {
    return {
      target: result.branchAgent,
      status: 'completed',
      response: result.response,
      gatheredData: result.gatheredData,
    };
  }

  return {
    target: result.branchAgent,
    status: 'error',
    error: getUserFacingFanOutBranchError(result),
    gatheredData: result.gatheredData,
  };
}

function getUserFacingFanOutBranchError(result: BranchResult): string {
  switch (result.status) {
    case 'timeout':
      return `I couldn't complete ${result.branchAgent} before the async timeout.`;
    case 'cancelled':
      return `I couldn't complete ${result.branchAgent} because that async task was cancelled.`;
    case 'error':
    default:
      return result.error || `I couldn't complete ${result.branchAgent} right now.`;
  }
}
