import { beforeEach, describe, expect, test, vi } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => mockLogger),
  runWithObservabilityContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
}));

import { createWorkerSideEffectFailure, runBestEffortWorkerSideEffect } from '../shared.js';

describe('worker side-effect helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('runBestEffortWorkerSideEffect logs and swallows failures', async () => {
    await expect(
      runBestEffortWorkerSideEffect('connector-sync', 'write sync audit entry', async () => {
        throw new Error('audit collection unavailable');
      }),
    ).resolves.toBeUndefined();

    expect(mockLogger.error).toHaveBeenCalledWith(
      'Best-effort side effect failed: write sync audit entry',
      expect.objectContaining({ error: 'audit collection unavailable' }),
    );
  });

  test('createWorkerSideEffectFailure preserves both the primary and side-effect errors', () => {
    const primaryError = new Error('sync failed');
    const sideEffectError = new Error('source update failed');

    const aggregate = createWorkerSideEffectFailure(
      primaryError,
      'mark the source as errored after sync failure',
      sideEffectError,
    );

    expect(aggregate).toBeInstanceOf(AggregateError);
    expect(aggregate.errors).toEqual([primaryError, sideEffectError]);
    expect(aggregate.message).toContain('sync failed');
    expect(aggregate.message).toContain('mark the source as errored after sync failure');
    expect(aggregate.message).toContain('source update failed');
  });
});
