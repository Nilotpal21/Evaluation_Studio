/**
 * Tool Resilience Factory Tests
 *
 * Verifies that the factory creates circuit breakers with tool: prefix
 * and rate limiters that integrate with HybridCircuitBreakerRegistry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the hybrid-cb-registry module before importing the factory
vi.mock('../../services/resilience/hybrid-cb-registry.js', () => {
  const mockBreaker = {
    isOpen: vi.fn().mockReturnValue(false),
    recordSuccess: vi.fn().mockResolvedValue(undefined),
    recordFailure: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockReturnValue('closed'),
  };

  const mockRegistry = {
    getBreaker: vi.fn().mockReturnValue(mockBreaker),
    isUsingRedis: vi.fn().mockReturnValue(false),
    shutdown: vi.fn(),
  };

  return {
    getCircuitBreakerRegistry: vi.fn().mockReturnValue(mockRegistry),
    resetCircuitBreakerRegistry: vi.fn(),
    HybridCircuitBreakerRegistry: vi.fn(),
  };
});

import { createToolResilienceFactory } from '../../services/resilience/tool-resilience-factory.js';
import { getCircuitBreakerRegistry } from '../../services/resilience/hybrid-cb-registry.js';

describe('ToolResilienceFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create circuit breakers with tool: prefix', () => {
    const factory = createToolResilienceFactory('org-1');
    factory.createCircuitBreaker('my_api', { threshold: 5, resetMs: 30000 });

    const registry = getCircuitBreakerRegistry();
    expect(registry.getBreaker).toHaveBeenCalledWith('tool:org-1:my_api', 'org-1');
  });

  it('should pass tenantId as tenantId for tenant-specific config', () => {
    const factory = createToolResilienceFactory('org-special');
    factory.createCircuitBreaker('weather_api', { threshold: 3, resetMs: 10000 });

    const registry = getCircuitBreakerRegistry();
    expect(registry.getBreaker).toHaveBeenCalledWith('tool:org-special:weather_api', 'org-special');
  });

  it('should return ICircuitBreaker-compatible adapter', async () => {
    const factory = createToolResilienceFactory();
    const breaker = factory.createCircuitBreaker('test', { threshold: 5, resetMs: 30000 });

    // Test ICircuitBreaker interface methods
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.getState()).toBe('closed');
    await breaker.recordSuccess();
    await breaker.recordFailure();
  });

  it('should create rate limiters', async () => {
    const factory = createToolResilienceFactory();
    const limiter = factory.createRateLimiter('test', 60);

    // Should not throw — token bucket should have tokens available
    await limiter.acquire();
  });

  it('should work without tenantId', () => {
    const factory = createToolResilienceFactory();
    factory.createCircuitBreaker('test', { threshold: 5, resetMs: 30000 });

    const registry = getCircuitBreakerRegistry();
    expect(registry.getBreaker).toHaveBeenCalledWith('tool:test', undefined);
  });
});
