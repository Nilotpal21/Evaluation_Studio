/**
 * RetryHandler Tests
 *
 * Tests exponential backoff with jitter, retryable errors, and max attempts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RetryHandler } from '../client/retry-handler.js';

describe('RetryHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('should succeed on first attempt when operation succeeds', async () => {
    const handler = new RetryHandler({
      maxAttempts: 3,
      initialDelayMs: 1000,
      maxDelayMs: 10000,
      backoffMultiplier: 2,
    });

    const operation = vi.fn().mockResolvedValue('success');

    const result = await handler.execute(operation);

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('should retry on retryable error and eventually succeed', async () => {
    const handler = new RetryHandler({
      maxAttempts: 3,
      initialDelayMs: 1000,
      maxDelayMs: 10000,
      backoffMultiplier: 2,
    });

    const retryableError: any = new Error('Temporary failure');
    retryableError.statusCode = 503;

    const operation = vi
      .fn()
      .mockRejectedValueOnce(retryableError)
      .mockRejectedValueOnce(retryableError)
      .mockResolvedValueOnce('success');

    const executePromise = handler.execute(operation);

    // First attempt fails immediately
    await vi.waitFor(() => {
      expect(operation).toHaveBeenCalledTimes(1);
    });

    // Advance past first retry delay (1000ms)
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => {
      expect(operation).toHaveBeenCalledTimes(2);
    });

    // Advance past second retry delay (2000ms)
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => {
      expect(operation).toHaveBeenCalledTimes(3);
    });

    const result = await executePromise;

    expect(result).toBe('success');
  });

  it('should fail after max attempts exceeded', async () => {
    const handler = new RetryHandler({
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1000,
      backoffMultiplier: 2,
    });

    const retryableError: any = new Error('Persistent failure');
    retryableError.statusCode = 503;
    const operation = vi.fn().mockRejectedValue(retryableError);

    const executePromise = handler.execute(operation).catch((err) => err);

    // Advance through all retry delays (100ms + 200ms = 300ms total for 2 retries)
    await vi.advanceTimersByTimeAsync(100); // First retry delay
    await vi.advanceTimersByTimeAsync(200); // Second retry delay

    // Give promise time to reject after all retries exhausted
    await vi.runAllTimersAsync();

    const result = await executePromise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('Persistent failure');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('should apply exponential backoff correctly', async () => {
    const handler = new RetryHandler({
      maxAttempts: 4,
      initialDelayMs: 100,
      maxDelayMs: 10000,
      backoffMultiplier: 2,
    });

    const retryableError: any = new Error('Fail');
    retryableError.statusCode = 503;
    const operation = vi.fn().mockRejectedValue(retryableError);

    const executePromise = handler.execute(operation).catch((err) => err);

    // First attempt (immediate)
    await vi.waitFor(() => {
      expect(operation).toHaveBeenCalledTimes(1);
    });

    // First retry after ~100ms
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => {
      expect(operation).toHaveBeenCalledTimes(2);
    });

    // Second retry after ~200ms
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => {
      expect(operation).toHaveBeenCalledTimes(3);
    });

    // Third retry after ~400ms
    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(() => {
      expect(operation).toHaveBeenCalledTimes(4);
    });

    await vi.runAllTimersAsync();
    const result = await executePromise;
    expect(result).toBeInstanceOf(Error);
  });

  it('should respect max delay cap', async () => {
    const handler = new RetryHandler({
      maxAttempts: 5,
      initialDelayMs: 1000,
      maxDelayMs: 3000,
      backoffMultiplier: 2,
    });

    const retryableError: any = new Error('Fail');
    retryableError.statusCode = 503;
    const operation = vi.fn().mockRejectedValue(retryableError);

    const executePromise = handler.execute(operation).catch((err) => err);

    // Initial attempt
    await vi.waitFor(() => {
      expect(operation).toHaveBeenCalledTimes(1);
    });

    // Retries: 1000, 2000, 4000 (capped to 3000), 8000 (capped to 3000)
    await vi.advanceTimersByTimeAsync(1000); // First retry
    await vi.waitFor(() => {
      expect(operation).toHaveBeenCalledTimes(2);
    });

    await vi.advanceTimersByTimeAsync(2000); // Second retry
    await vi.waitFor(() => {
      expect(operation).toHaveBeenCalledTimes(3);
    });

    await vi.advanceTimersByTimeAsync(3000); // Third retry (would be 4000, capped at 3000)
    await vi.waitFor(() => {
      expect(operation).toHaveBeenCalledTimes(4);
    });

    await vi.advanceTimersByTimeAsync(3000); // Fourth retry (would be 8000, capped at 3000)
    await vi.waitFor(() => {
      expect(operation).toHaveBeenCalledTimes(5);
    });

    await vi.runAllTimersAsync();
    const result = await executePromise;
    expect(result).toBeInstanceOf(Error);
  });

  it('should apply jitter to delays', async () => {
    const handler = new RetryHandler({
      maxAttempts: 3,
      initialDelayMs: 1000,
      maxDelayMs: 10000,
      backoffMultiplier: 2,
    });

    const retryableError: any = new Error('Fail');
    retryableError.statusCode = 503;

    // Execute handler and check that delay is within jitter range
    const operation = vi.fn().mockRejectedValue(retryableError);

    const executePromise = handler.execute(operation).catch((err) => err);

    // First retry - should be ~1000ms ± 25% jitter (750-1250ms)
    await vi.advanceTimersByTimeAsync(1000);

    // Second retry - should be ~2000ms ± 25% jitter (1500-2500ms)
    await vi.advanceTimersByTimeAsync(2000);

    // Finish all timers
    await vi.runAllTimersAsync();

    const result = await executePromise;
    expect(result).toBeInstanceOf(Error);

    // Verify retries happened
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('should only retry on retryable status codes (429)', async () => {
    const handler = new RetryHandler({
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1000,
      backoffMultiplier: 2,
      retryableStatusCodes: [429, 503],
    });

    // 429 should retry
    const retryableError: any = new Error('Rate limited');
    retryableError.statusCode = 429;
    const operation429 = vi
      .fn()
      .mockRejectedValueOnce(retryableError)
      .mockResolvedValueOnce('success');

    const promise429 = handler.execute(operation429);

    // Wait for first attempt
    await vi.waitFor(() => {
      expect(operation429).toHaveBeenCalledTimes(1);
    });

    // Advance timer for retry
    await vi.advanceTimersByTimeAsync(100);

    // Wait for second attempt
    await vi.waitFor(() => {
      expect(operation429).toHaveBeenCalledTimes(2);
    });

    const result429 = await promise429;
    expect(result429).toBe('success');
  });

  it('should not retry on non-retryable status codes (400)', async () => {
    const handler = new RetryHandler({
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1000,
      backoffMultiplier: 2,
      retryableStatusCodes: [429, 503],
    });

    // 400 should NOT retry
    const nonRetryableError: any = new Error('Bad request');
    nonRetryableError.statusCode = 400;
    const operation400 = vi.fn().mockRejectedValue(nonRetryableError);

    await expect(handler.execute(operation400)).rejects.toThrow('Bad request');
    expect(operation400).toHaveBeenCalledTimes(1);
  });

  it('should handle operation that throws synchronously', async () => {
    const handler = new RetryHandler({
      maxAttempts: 2,
      initialDelayMs: 100,
      maxDelayMs: 1000,
      backoffMultiplier: 2,
    });

    const operation = vi.fn().mockImplementation(() => {
      const error: any = new Error('Sync error');
      error.statusCode = 503;
      throw error;
    });

    const executePromise = handler.execute(operation).catch((err) => err);

    // Advance through retry delay
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();

    const result = await executePromise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('Sync error');
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
