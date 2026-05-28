/**
 * Permission Graph Service Half-Open Probe Tests
 *
 * Verifies the probeInProgress flag in PermissionGraphService's internal circuit
 * breaker ensures only one request passes through during the half-open state.
 * Tests exercise the circuit breaker through the public API (upsertUser).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the PermissionGraphClient before importing the service.
// Must use a function expression (not arrow) so it works with `new`.
vi.mock('../permission-graph-client.js', () => {
  return {
    PermissionGraphClient: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
      this.verifyConnection = vi.fn().mockResolvedValue(true);
      this.close = vi.fn().mockResolvedValue(undefined);
      this.upsertUser = vi.fn();
      this.initializeSchema = vi.fn().mockResolvedValue(undefined);
    }),
  };
});

import { PermissionGraphService } from '../permission-graph-service.js';
import { PermissionGraphClient } from '../permission-graph-client.js';

describe('PermissionGraphService half-open probe guard', () => {
  const THRESHOLD = 3;
  const TIMEOUT_MS = 5000;

  let service: PermissionGraphService;
  let mockUpsertUser: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();

    // Reset the singleton so each test starts fresh
    PermissionGraphService.resetInstance();

    // Clear the mock call history but keep the implementation intact
    (PermissionGraphClient as unknown as ReturnType<typeof vi.fn>).mockClear();

    service = PermissionGraphService.getInstance({
      uri: 'bolt://localhost:7687',
      username: 'neo4j',
      password: 'test',
      circuitBreakerThreshold: THRESHOLD,
      circuitBreakerTimeout: TIMEOUT_MS,
      maxRetries: 0, // skip retries for faster tests
    });

    // Grab the mock from the constructed client instance
    const MockClient = PermissionGraphClient as unknown as ReturnType<typeof vi.fn>;
    const clientInstance = MockClient.mock.results[MockClient.mock.results.length - 1].value;
    mockUpsertUser = clientInstance.upsertUser;
  });

  afterEach(() => {
    PermissionGraphService.resetInstance();
    vi.useRealTimers();
  });

  const userInput = {
    tenantId: 'tenant-1',
    email: 'test@example.com',
    displayName: 'Test User',
    domain: 'example.com',
  };

  const userResult = {
    tenantId: 'tenant-1',
    email: 'test@example.com',
    displayName: 'Test User',
    domain: 'example.com',
    status: 'active',
    createdAt: new Date(),
  };

  /**
   * Helper: trip the circuit breaker by making enough failed calls.
   */
  async function tripBreaker(): Promise<void> {
    // Use a non-retryable error message so executeWithRetry fails immediately
    // without sleeping (the retryable patterns check for "timeout", "connection", etc.)
    mockUpsertUser.mockRejectedValue(new Error('permission denied'));

    for (let i = 0; i < THRESHOLD; i++) {
      await expect(service.upsertUser(userInput)).rejects.toThrow();
    }
  }

  it('allows first probe request in half-open, rejects second', async () => {
    await tripBreaker();

    // Advance time past the circuit breaker timeout
    vi.advanceTimersByTime(TIMEOUT_MS + 1);

    // Set up the mock so the probe request hangs (stays in-flight)
    let resolveProbe!: (value: unknown) => void;
    const pendingProbe = new Promise((resolve) => {
      resolveProbe = resolve;
    });
    mockUpsertUser.mockReturnValueOnce(pendingProbe);

    // Start probe request (do not await — it's pending)
    const probePromise = service.upsertUser(userInput);

    // Second request should be rejected with "Circuit breaker is OPEN"
    await expect(service.upsertUser(userInput)).rejects.toThrow(/Circuit breaker is OPEN/);

    // Resolve the probe so the test can clean up
    resolveProbe(userResult);
    const result = await probePromise;
    expect(result).toEqual(userResult);
  });

  it('recordSuccess clears flag on successful probe', async () => {
    await tripBreaker();

    vi.advanceTimersByTime(TIMEOUT_MS + 1);

    // Probe succeeds
    mockUpsertUser.mockResolvedValueOnce(userResult);
    const result = await service.upsertUser(userInput);
    expect(result).toEqual(userResult);

    // Circuit should be closed — subsequent calls should work
    mockUpsertUser.mockResolvedValueOnce(userResult);
    const next = await service.upsertUser(userInput);
    expect(next).toEqual(userResult);
  });

  it('recordFailure clears flag and circuit goes back to open', async () => {
    await tripBreaker();

    vi.advanceTimersByTime(TIMEOUT_MS + 1);

    // Probe fails
    mockUpsertUser.mockRejectedValueOnce(new Error('probe rejected'));
    await expect(service.upsertUser(userInput)).rejects.toThrow('probe rejected');

    // Circuit should be back to open — request rejected without calling the client
    const callCountAfterProbe = mockUpsertUser.mock.calls.length;

    await expect(service.upsertUser(userInput)).rejects.toThrow(/Circuit breaker is OPEN/);

    // No additional client call should have been made
    expect(mockUpsertUser).toHaveBeenCalledTimes(callCountAfterProbe);

    // Advance time past timeout again — new probe should be allowed
    vi.advanceTimersByTime(TIMEOUT_MS + 1);

    mockUpsertUser.mockResolvedValueOnce(userResult);
    const result = await service.upsertUser(userInput);
    expect(result).toEqual(userResult);
  });

  it('resetMetrics clears the probe flag', async () => {
    await tripBreaker();

    vi.advanceTimersByTime(TIMEOUT_MS + 1);

    // Start a probe (transition to half-open)
    let resolveProbe!: (value: unknown) => void;
    mockUpsertUser.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProbe = resolve;
      }),
    );
    const probePromise = service.upsertUser(userInput);

    // Second request blocked
    await expect(service.upsertUser(userInput)).rejects.toThrow(/Circuit breaker is OPEN/);

    // Reset metrics — clears probeInProgress and circuit state
    service.resetMetrics();

    // Resolve the dangling probe to avoid unhandled rejections
    resolveProbe(userResult);
    await probePromise.catch(() => {});

    // After reset, the circuit is closed — requests should work
    mockUpsertUser.mockResolvedValueOnce(userResult);
    const result = await service.upsertUser(userInput);
    expect(result).toEqual(userResult);

    // Trip and recover again to prove the flag was truly cleared
    await tripBreaker();
    vi.advanceTimersByTime(TIMEOUT_MS + 1);

    mockUpsertUser.mockResolvedValueOnce(userResult);
    const probeAfterReset = await service.upsertUser(userInput);
    expect(probeAfterReset).toEqual(userResult);
  });
});
