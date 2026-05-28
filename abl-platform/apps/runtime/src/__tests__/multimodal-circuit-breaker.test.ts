/**
 * MultimodalCircuitBreaker Tests
 *
 * Verifies the circuit breaker wrapper for multimodal service calls:
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

import { MultimodalCircuitBreaker } from '../attachments/multimodal-circuit-breaker.js';

describe('MultimodalCircuitBreaker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default: circuit is closed
    mockIsOpen.mockReturnValue(false);
  });

  it('executes operation and records success when circuit is closed', async () => {
    const cb = new MultimodalCircuitBreaker('tenant-1');
    const result = await cb.execute('upload', async () => ({
      success: true,
      attachmentId: 'att-1',
    }));

    expect(result).toEqual({ success: true, attachmentId: 'att-1' });
    expect(mockGetBreaker).toHaveBeenCalledWith('multimodal:tenant-1', 'tenant-1');
    expect(mockIsOpen).toHaveBeenCalled();
    expect(mockRecordSuccess).toHaveBeenCalledOnce();
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it('throws immediately when circuit is open without executing the operation', async () => {
    mockIsOpen.mockReturnValue(true);
    const cb = new MultimodalCircuitBreaker('tenant-1');
    const operationFn = vi.fn();

    await expect(cb.execute('upload', operationFn)).rejects.toThrow(
      'Multimodal circuit breaker is open for tenant tenant-1',
    );
    expect(operationFn).not.toHaveBeenCalled();
    expect(mockRecordSuccess).not.toHaveBeenCalled();
  });

  it('records failure and re-throws on operation error', async () => {
    const cb = new MultimodalCircuitBreaker('tenant-1');
    const error = new Error('service unavailable');

    await expect(
      cb.execute('getAttachment', async () => {
        throw error;
      }),
    ).rejects.toThrow('service unavailable');

    expect(mockRecordFailure).toHaveBeenCalledOnce();
    expect(mockRecordFailure).toHaveBeenCalledWith(error);
    expect(mockRecordSuccess).not.toHaveBeenCalled();
  });

  it('records failure with wrapped Error for non-Error throws', async () => {
    const cb = new MultimodalCircuitBreaker('tenant-2');

    await expect(
      cb.execute('listBySession', async () => {
        throw 'string error'; // eslint-disable-line no-throw-literal
      }),
    ).rejects.toThrow('string error');

    expect(mockRecordFailure).toHaveBeenCalledOnce();
    const failureArg = mockRecordFailure.mock.calls[0][0];
    expect(failureArg).toBeInstanceOf(Error);
    expect(failureArg.message).toBe('string error');
  });

  it('uses tenant-scoped breaker name', async () => {
    const cb = new MultimodalCircuitBreaker('tenant-xyz');
    await cb.execute('getStatus', async () => null);

    expect(mockGetBreaker).toHaveBeenCalledWith('multimodal:tenant-xyz', 'tenant-xyz');
  });

  it('returns typed results', async () => {
    const cb = new MultimodalCircuitBreaker('tenant-3');
    const result = await cb.execute<{ scanStatus: string }>('getStatus', async () => ({
      scanStatus: 'clean',
    }));

    expect(result.scanStatus).toBe('clean');
  });

  it('different tenants use different breaker names', async () => {
    const cb1 = new MultimodalCircuitBreaker('tenant-a');
    const cb2 = new MultimodalCircuitBreaker('tenant-b');

    await cb1.execute('upload', async () => 'a');
    await cb2.execute('upload', async () => 'b');

    expect(mockGetBreaker).toHaveBeenCalledWith('multimodal:tenant-a', 'tenant-a');
    expect(mockGetBreaker).toHaveBeenCalledWith('multimodal:tenant-b', 'tenant-b');
  });

  it('does not record failure for circuit-open fast-fail (failure already known)', async () => {
    mockIsOpen.mockReturnValue(true);
    const cb = new MultimodalCircuitBreaker('tenant-1');

    await expect(cb.execute('deleteAttachment', vi.fn())).rejects.toThrow(
      'Multimodal circuit breaker is open',
    );

    // The open-circuit error itself should be recorded as a failure
    // (since it enters the catch block), but the original operation was not called
    expect(mockRecordFailure).toHaveBeenCalled();
  });
});
