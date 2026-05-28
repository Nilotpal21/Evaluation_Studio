import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Queue } from 'bullmq';
import type { CleanupJobData } from '../queues.js';

// =============================================================================
// MOCK: Mongoose Attachment model (chainable .select().limit().lean())
// =============================================================================

const mockLean = vi.fn();
const mockLimit = vi.fn().mockReturnValue({ lean: mockLean });
const mockSelect = vi.fn().mockReturnValue({ limit: mockLimit });
const mockFind = vi.fn().mockReturnValue({ select: mockSelect });

vi.mock('@agent-platform/database', () => ({
  Attachment: {
    find: (...args: unknown[]) => mockFind(...args),
  },
}));

// =============================================================================
// MOCK: queues.js helpers
// =============================================================================

const mockWorkerLog = vi.fn();
const mockWorkerError = vi.fn();

vi.mock('../queues.js', () => ({
  workerLog: (...args: unknown[]) => mockWorkerLog(...args),
  workerError: (...args: unknown[]) => mockWorkerError(...args),
}));

// =============================================================================
// HELPERS
// =============================================================================

function makeCleanupQueue(overrides?: Partial<Queue<CleanupJobData>>): Queue<CleanupJobData> {
  return {
    add: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Queue<CleanupJobData>;
}

function makeAttachment(overrides?: Record<string, unknown>) {
  return {
    _id: 'att-001',
    tenantId: 'tenant-1',
    ...overrides,
  };
}

/**
 * Set up the chainable mock to resolve with the given attachments array.
 */
function setupFindResult(attachments: ReturnType<typeof makeAttachment>[]) {
  mockLean.mockResolvedValue(attachments);
  // Reset the chain so each call re-wires correctly
  mockLimit.mockReturnValue({ lean: mockLean });
  mockSelect.mockReturnValue({ limit: mockLimit });
  mockFind.mockReturnValue({ select: mockSelect });
}

// =============================================================================
// TESTS
// =============================================================================

describe('createExpirySweep', () => {
  let cleanupQueue: Queue<CleanupJobData>;
  let createExpirySweep: typeof import('../expiry-sweep-job.js').createExpirySweep;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-25T12:00:00.000Z'));

    setupFindResult([]);
    cleanupQueue = makeCleanupQueue();

    const mod = await import('../expiry-sweep-job.js');
    createExpirySweep = mod.createExpirySweep;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // Finds attachments expiring within the 2-hour horizon
  // ---------------------------------------------------------------------------

  it('queries for attachments expiring within the 2-hour horizon', async () => {
    setupFindResult([]);

    const sweep = createExpirySweep(cleanupQueue);
    await sweep();

    // The horizon should be now + 2 hours
    const expectedHorizon = new Date('2026-02-25T14:00:00.000Z');

    expect(mockFind).toHaveBeenCalledWith({
      expiresAt: { $lte: expectedHorizon },
    });

    // Verify chainable calls
    expect(mockSelect).toHaveBeenCalledWith('_id tenantId');
    expect(mockLimit).toHaveBeenCalledWith(500);
    expect(mockLean).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Enqueues cleanup jobs with correct data
  // ---------------------------------------------------------------------------

  it('enqueues cleanup jobs with correct attachmentId, tenantId, and reason', async () => {
    const attachments = [
      makeAttachment({ _id: 'att-001', tenantId: 'tenant-1' }),
      makeAttachment({ _id: 'att-002', tenantId: 'tenant-2' }),
    ];
    setupFindResult(attachments);

    const sweep = createExpirySweep(cleanupQueue);
    await sweep();

    expect(cleanupQueue.add).toHaveBeenCalledTimes(2);

    expect(cleanupQueue.add).toHaveBeenCalledWith(
      'cleanup',
      {
        attachmentId: 'att-001',
        tenantId: 'tenant-1',
        reason: 'expired',
      },
      { jobId: 'cleanup:att-001' },
    );

    expect(cleanupQueue.add).toHaveBeenCalledWith(
      'cleanup',
      {
        attachmentId: 'att-002',
        tenantId: 'tenant-2',
        reason: 'expired',
      },
      { jobId: 'cleanup:att-002' },
    );
  });

  // ---------------------------------------------------------------------------
  // Uses dedup jobId format: cleanup:{attachmentId}
  // ---------------------------------------------------------------------------

  it('uses dedup jobId in the format cleanup:{attachmentId}', async () => {
    const attachments = [makeAttachment({ _id: 'att-xyz-123' })];
    setupFindResult(attachments);

    const sweep = createExpirySweep(cleanupQueue);
    await sweep();

    expect(cleanupQueue.add).toHaveBeenCalledWith('cleanup', expect.any(Object), {
      jobId: 'cleanup:att-xyz-123',
    });
  });

  // ---------------------------------------------------------------------------
  // Handles zero expiring attachments
  // ---------------------------------------------------------------------------

  it('returns without enqueuing when no attachments are expiring', async () => {
    setupFindResult([]);

    const sweep = createExpirySweep(cleanupQueue);
    await sweep();

    expect(cleanupQueue.add).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Silently ignores duplicate job errors
  // ---------------------------------------------------------------------------

  it('silently ignores duplicate job errors without calling workerError', async () => {
    const attachments = [makeAttachment({ _id: 'att-001' })];
    setupFindResult(attachments);

    (cleanupQueue.add as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Job with id cleanup:att-001 already exists (duplicate)'),
    );

    const sweep = createExpirySweep(cleanupQueue);
    await sweep();

    // Should NOT report duplicate errors
    expect(mockWorkerError).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Reports non-duplicate enqueue errors via workerError
  // ---------------------------------------------------------------------------

  it('reports non-duplicate enqueue errors via workerError', async () => {
    const attachments = [makeAttachment({ _id: 'att-001' })];
    setupFindResult(attachments);

    const redisError = new Error('Redis connection refused');
    (cleanupQueue.add as ReturnType<typeof vi.fn>).mockRejectedValue(redisError);

    const sweep = createExpirySweep(cleanupQueue);
    await sweep();

    expect(mockWorkerError).toHaveBeenCalledWith(
      'expiry-sweep',
      'Failed to enqueue cleanup for att-001',
      redisError,
    );
  });

  // ---------------------------------------------------------------------------
  // Continues enqueuing remaining items after a single enqueue failure
  // ---------------------------------------------------------------------------

  it('continues enqueuing remaining attachments after one enqueue fails', async () => {
    const attachments = [
      makeAttachment({ _id: 'att-001', tenantId: 'tenant-1' }),
      makeAttachment({ _id: 'att-002', tenantId: 'tenant-1' }),
      makeAttachment({ _id: 'att-003', tenantId: 'tenant-1' }),
    ];
    setupFindResult(attachments);

    // First call fails, second and third succeed
    (cleanupQueue.add as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('Redis timeout'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    const sweep = createExpirySweep(cleanupQueue);
    await sweep();

    // All three should have been attempted
    expect(cleanupQueue.add).toHaveBeenCalledTimes(3);

    // The first failure should have been reported
    expect(mockWorkerError).toHaveBeenCalledWith(
      'expiry-sweep',
      'Failed to enqueue cleanup for att-001',
      expect.any(Error),
    );
  });

  // ---------------------------------------------------------------------------
  // Handles query failure gracefully
  // ---------------------------------------------------------------------------

  it('handles Attachment.find query failure gracefully via workerError', async () => {
    const dbError = new Error('MongoNetworkError: connection timed out');
    mockLean.mockRejectedValue(dbError);

    const sweep = createExpirySweep(cleanupQueue);
    await sweep();

    // Should report the query error
    expect(mockWorkerError).toHaveBeenCalledWith('expiry-sweep', 'Expiry sweep failed', dbError);

    // Should NOT have attempted to enqueue any jobs
    expect(cleanupQueue.add).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Handles non-Error thrown values in query failure
  // ---------------------------------------------------------------------------

  it('handles non-Error thrown values in the query failure path', async () => {
    mockLean.mockRejectedValue('raw string error');

    const sweep = createExpirySweep(cleanupQueue);
    await sweep();

    expect(mockWorkerError).toHaveBeenCalledWith(
      'expiry-sweep',
      'Expiry sweep failed',
      'raw string error',
    );
  });

  // ---------------------------------------------------------------------------
  // Handles non-Error thrown values in enqueue failure
  // ---------------------------------------------------------------------------

  it('handles non-Error thrown values in the enqueue failure path', async () => {
    const attachments = [makeAttachment({ _id: 'att-001' })];
    setupFindResult(attachments);

    (cleanupQueue.add as ReturnType<typeof vi.fn>).mockRejectedValue('connection lost');

    const sweep = createExpirySweep(cleanupQueue);
    await sweep();

    // non-Error, non-duplicate string => should be reported
    expect(mockWorkerError).toHaveBeenCalledWith(
      'expiry-sweep',
      'Failed to enqueue cleanup for att-001',
      'connection lost',
    );
  });

  // ---------------------------------------------------------------------------
  // Multiple sweep invocations are independent
  // ---------------------------------------------------------------------------

  it('supports multiple independent sweep invocations from the same factory', async () => {
    const sweep = createExpirySweep(cleanupQueue);

    // First invocation: 1 attachment
    setupFindResult([makeAttachment({ _id: 'att-001' })]);
    await sweep();
    expect(cleanupQueue.add).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();

    // Second invocation: 2 attachments
    setupFindResult([makeAttachment({ _id: 'att-002' }), makeAttachment({ _id: 'att-003' })]);
    await sweep();
    expect(cleanupQueue.add).toHaveBeenCalledTimes(2);
  });
});
