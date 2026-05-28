import type { ExecutorResult, Session } from '../types.js';

/**
 * Accumulates per-provider cost attribution on the session after each
 * `modelRouter.execute()` call resolves.
 *
 * Key format: `${result.engine}:${result.model ?? 'unknown'}`.
 * Pure synchronous function — no I/O, no side effects beyond mutating
 * `session.costByProvider`.
 */
export function accumulateProviderCost(session: Session, result: ExecutorResult): void {
  const key = `${result.engine}:${result.model ?? 'unknown'}`;

  if (!session.costByProvider) {
    session.costByProvider = {};
  }

  const entry = session.costByProvider[key];
  if (entry) {
    entry.callCount += 1;
    entry.totalUsd += result.costUsd ?? 0;
  } else {
    session.costByProvider[key] = {
      totalUsd: result.costUsd ?? 0,
      callCount: 1,
    };
  }
}
