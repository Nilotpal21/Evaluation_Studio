/**
 * SearchAICircuitBreaker Tests
 *
 * Verifies the circuit breaker wrapper for SearchAI service calls:
 * - Closed circuit: operations execute normally and record success
 * - Open circuit: operations fail fast without executing
 * - Failure recording: operation errors are recorded and re-thrown
 * - Tenant scoping: breaker name includes tenantId
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the hybrid circuit breaker registry
const mockIsOpen = vi.fn().mockReturnValue(false);
const mockRecordSuccess = vi.fn();
const mockRecordFailure = vi.fn();
const mockGetBreaker = vi.fn(() => ({
  isOpen: mockIsOpen,
  recordSuccess: mockRecordSuccess,
  recordFailure: mockRecordFailure,
}));
const mockGetRegistry = vi.fn(() => ({ getBreaker: mockGetBreaker }));

vi.mock('../services/resilience/hybrid-cb-registry.js', () => ({
  getCircuitBreakerRegistry: () => mockGetRegistry(),
}));

import { SearchAICircuitBreaker } from '../services/search-ai/search-ai-circuit-breaker.js';

describe('SearchAICircuitBreaker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default: circuit is closed
    mockIsOpen.mockReturnValue(false);
  });

  it('executes operation and records success when circuit is closed', async () => {
    const cb = new SearchAICircuitBreaker('tenant-1');
    const result = await cb.execute('search_vector', async () => ({ data: 'results' }));

    expect(result).toEqual({ data: 'results' });
    expect(mockGetBreaker).toHaveBeenCalledWith('search-ai:tenant-1', 'tenant-1');
    expect(mockIsOpen).toHaveBeenCalled();
    expect(mockRecordSuccess).toHaveBeenCalledOnce();
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it('throws immediately when circuit is open without executing the operation', async () => {
    mockIsOpen.mockReturnValue(true);
    const cb = new SearchAICircuitBreaker('tenant-1');
    const operationFn = vi.fn();

    await expect(cb.execute('search_vector', operationFn)).rejects.toThrow(
      'Search-AI circuit breaker is open for tenant tenant-1',
    );
    expect(operationFn).not.toHaveBeenCalled();
    expect(mockRecordSuccess).not.toHaveBeenCalled();
  });

  it('records failure and re-throws on operation error', async () => {
    const cb = new SearchAICircuitBreaker('tenant-1');
    const error = new Error('service unavailable');

    await expect(
      cb.execute('search_structured', async () => {
        throw error;
      }),
    ).rejects.toThrow('service unavailable');

    expect(mockRecordFailure).toHaveBeenCalledOnce();
    expect(mockRecordFailure).toHaveBeenCalledWith(error);
    expect(mockRecordSuccess).not.toHaveBeenCalled();
  });

  it('records failure with wrapped Error for non-Error throws', async () => {
    const cb = new SearchAICircuitBreaker('tenant-2');

    await expect(
      cb.execute('search_aggregate', async () => {
        throw 'string error'; // eslint-disable-line no-throw-literal
      }),
    ).rejects.toThrow('string error');

    expect(mockRecordFailure).toHaveBeenCalledOnce();
    const failureArg = mockRecordFailure.mock.calls[0][0];
    expect(failureArg).toBeInstanceOf(Error);
    expect(failureArg.message).toBe('string error');
  });

  it('uses tenant-scoped breaker name', async () => {
    const cb = new SearchAICircuitBreaker('tenant-xyz');
    await cb.execute('search_hybrid', async () => 'ok');

    expect(mockGetBreaker).toHaveBeenCalledWith('search-ai:tenant-xyz', 'tenant-xyz');
  });

  it('returns typed results', async () => {
    const cb = new SearchAICircuitBreaker('tenant-3');
    const result = await cb.execute<{ count: number }>('search_aggregate', async () => ({
      count: 42,
    }));

    expect(result.count).toBe(42);
  });

  it('different tenants use different breaker names', async () => {
    const cb1 = new SearchAICircuitBreaker('tenant-a');
    const cb2 = new SearchAICircuitBreaker('tenant-b');

    await cb1.execute('search_vector', async () => 'a');
    await cb2.execute('search_vector', async () => 'b');

    expect(mockGetBreaker).toHaveBeenCalledWith('search-ai:tenant-a', 'tenant-a');
    expect(mockGetBreaker).toHaveBeenCalledWith('search-ai:tenant-b', 'tenant-b');
  });
});
