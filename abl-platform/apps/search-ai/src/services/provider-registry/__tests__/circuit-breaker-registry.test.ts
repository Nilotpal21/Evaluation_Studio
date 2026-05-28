/**
 * Unit tests for ProviderRegistryWithCircuitBreaker
 *
 * Tests circuit breaker integration with provider registry.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProviderRegistryWithCircuitBreaker } from '../circuit-breaker-registry.js';
import { ProviderRegistry } from '../provider-registry.js';
import type { PipelineStageProvider } from '../types.js';
import { CircuitOpenError } from '@agent-platform/circuit-breaker';

// Store mock breaker factory so we can control it from tests
let mockBreakerFactory: any;

// Mock the module
vi.mock('@agent-platform/circuit-breaker', () => {
  // Define mock error inside the factory to avoid hoisting issues
  class MockCircuitOpenError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'CircuitOpenError';
    }
  }

  // Mock constructor class
  class MockRedisCircuitBreaker {
    execute: any;
    getState: any;
    forceReset: any;

    constructor(...args: any[]) {
      // Call the test-controlled factory
      if (mockBreakerFactory) {
        const instance = mockBreakerFactory(...args);
        this.execute = instance.execute;
        this.getState = instance.getState;
        this.forceReset = instance.forceReset;
      } else {
        // Default implementation — execute(key, fn)
        this.execute = vi.fn().mockImplementation(async (_key: string, fn: any) => await fn());
        this.getState = vi.fn().mockResolvedValue('CLOSED');
        this.forceReset = vi.fn().mockResolvedValue({ state: 'CLOSED', action: 'forced' });
      }
    }
  }

  return {
    RedisCircuitBreaker: MockRedisCircuitBreaker,
    CircuitOpenError: MockCircuitOpenError,
  };
});

// Mock Redis
const mockRedis = {
  eval: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
} as any;

// Mock provider
class MockExtractionProvider implements PipelineStageProvider {
  id = 'mock-extraction';
  name = 'Mock Extraction Provider';
  type = 'extraction' as const;
  version = '1.0.0';
  description = 'Mock extraction provider for testing';

  async execute(input: any, config: any): Promise<any> {
    return { text: 'extracted text', pageCount: 10 };
  }

  validateConfig(config: unknown): config is any {
    return true;
  }

  getSchema() {
    return { type: 'object' as const, properties: {} };
  }
}

// Fallback provider
class FallbackExtractionProvider implements PipelineStageProvider {
  id = 'fallback-extraction';
  name = 'Fallback Extraction Provider';
  type = 'extraction' as const;
  version = '1.0.0';
  description = 'Fallback extraction provider for testing';

  async execute(input: any, config: any): Promise<any> {
    return { text: 'fallback extracted text', pageCount: 5 };
  }

  validateConfig(config: unknown): config is any {
    return true;
  }

  getSchema() {
    return { type: 'object' as const, properties: {} };
  }
}

describe('ProviderRegistryWithCircuitBreaker', () => {
  let registry: ProviderRegistryWithCircuitBreaker;
  let baseRegistry: ProviderRegistry;

  beforeEach(() => {
    // Clear registry
    baseRegistry = ProviderRegistry.getInstance();
    baseRegistry.clear();

    // Register mock providers
    baseRegistry.register(new MockExtractionProvider());
    baseRegistry.register(new FallbackExtractionProvider());

    // Create circuit breaker registry
    registry = new ProviderRegistryWithCircuitBreaker(mockRedis);

    // Reset mock factory
    mockBreakerFactory = undefined;

    // Reset mocks
    vi.clearAllMocks();
  });

  describe('executeWithProtection', () => {
    it('should execute provider successfully', async () => {
      // Mock circuit breaker execute to pass through
      const mockExecute = vi.fn().mockImplementation(async (_key: string, fn: any) => await fn());
      mockBreakerFactory = () => ({
        execute: mockExecute,
        getState: vi.fn().mockResolvedValue('CLOSED'),
        forceReset: vi.fn().mockResolvedValue({ state: 'CLOSED', action: 'forced' }),
      });

      const result = await registry.executeWithProtection({
        tenantId: 'tenant-123',
        stageType: 'extraction',
        providerId: 'mock-extraction',
        input: { buffer: Buffer.from('test'), metadata: {} },
        config: {},
      });

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ text: 'extracted text', pageCount: 10 });
      expect(result.providerId).toBe('mock-extraction');
      expect(result.circuitOpen).toBe(false);
      expect(result.usedFallback).toBe(false);
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it('should handle circuit open error and try fallback', async () => {
      // First call (primary) throws CircuitOpenError, second call (fallback) succeeds
      let callCount = 0;
      const mockExecute = vi.fn().mockImplementation(async (_key: string, fn: any) => {
        callCount++;
        if (callCount === 1) {
          throw new CircuitOpenError('tool_service', 'test-key', 60000);
        }
        return await fn();
      });

      mockBreakerFactory = () => ({
        execute: mockExecute,
        getState: vi.fn().mockResolvedValue('CLOSED'),
        forceReset: vi.fn().mockResolvedValue({ state: 'CLOSED', action: 'forced' }),
      });

      const result = await registry.executeWithProtection({
        tenantId: 'tenant-123',
        stageType: 'extraction',
        providerId: 'mock-extraction',
        input: { buffer: Buffer.from('test'), metadata: {} },
        config: {},
        fallbackProviders: ['fallback-extraction'],
      });

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ text: 'fallback extracted text', pageCount: 5 });
      expect(result.providerId).toBe('fallback-extraction');
      expect(result.circuitOpen).toBe(false);
      expect(result.usedFallback).toBe(true);
      expect(mockExecute).toHaveBeenCalledTimes(2);
    });

    it('should try all fallbacks before giving up', async () => {
      // All providers fail
      const mockExecute = vi.fn().mockImplementation(async () => {
        throw new Error('Provider failure');
      });

      mockBreakerFactory = () => ({
        execute: mockExecute,
        getState: vi.fn().mockResolvedValue('CLOSED'),
        forceReset: vi.fn().mockResolvedValue({ state: 'CLOSED', action: 'forced' }),
      });

      const result = await registry.executeWithProtection({
        tenantId: 'tenant-123',
        stageType: 'extraction',
        providerId: 'mock-extraction',
        input: { buffer: Buffer.from('test'), metadata: {} },
        config: {},
        fallbackProviders: ['fallback-extraction'],
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Provider failure');
      expect(result.providerId).toBe('fallback-extraction');
      expect(result.circuitOpen).toBe(false);
      expect(result.usedFallback).toBe(true);
      expect(mockExecute).toHaveBeenCalledTimes(2); // Primary + 1 fallback
    });

    it('should handle provider not found', async () => {
      const mockExecute = vi.fn();
      mockBreakerFactory = () => ({
        execute: mockExecute,
        getState: vi.fn().mockResolvedValue('CLOSED'),
        forceReset: vi.fn().mockResolvedValue({ state: 'CLOSED', action: 'forced' }),
      });

      const result = await registry.executeWithProtection({
        tenantId: 'tenant-123',
        stageType: 'extraction',
        providerId: 'nonexistent-provider',
        input: { buffer: Buffer.from('test'), metadata: {} },
        config: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('nonexistent-provider');
      expect(result.error).toContain('not found');
      expect(result.providerId).toBe('nonexistent-provider');
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('should skip nonexistent fallback providers', async () => {
      // Primary fails, fallback1 doesn't exist, fallback2 succeeds
      let callCount = 0;
      const mockExecute = vi.fn().mockImplementation(async (_key: string, fn: any) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Primary failure');
        }
        // callCount === 2 succeeds (fallback2)
        return await fn();
      });

      mockBreakerFactory = () => ({
        execute: mockExecute,
        getState: vi.fn().mockResolvedValue('CLOSED'),
        forceReset: vi.fn().mockResolvedValue({ state: 'CLOSED', action: 'forced' }),
      });

      const result = await registry.executeWithProtection({
        tenantId: 'tenant-123',
        stageType: 'extraction',
        providerId: 'mock-extraction',
        input: { buffer: Buffer.from('test'), metadata: {} },
        config: {},
        fallbackProviders: ['nonexistent-fallback', 'fallback-extraction'],
      });

      expect(result.success).toBe(true);
      expect(result.providerId).toBe('fallback-extraction');
      expect(result.usedFallback).toBe(true);
      expect(mockExecute).toHaveBeenCalledTimes(2); // Primary + fallback2 (skipped nonexistent)
    });

    it('should use different circuit breakers per tenant', async () => {
      let instanceCount = 0;
      const breakerInstances = new Map<string, any>();
      mockBreakerFactory = () => {
        instanceCount++;
        const instance = {
          execute: vi.fn().mockImplementation(async (_key: string, fn: any) => await fn()),
          getState: vi.fn().mockResolvedValue('CLOSED'),
          forceReset: vi.fn().mockResolvedValue({ state: 'CLOSED', action: 'forced' }),
        };
        breakerInstances.set(`instance-${instanceCount}`, instance);
        return instance;
      };

      // Execute for tenant1
      await registry.executeWithProtection({
        tenantId: 'tenant-1',
        stageType: 'extraction',
        providerId: 'mock-extraction',
        input: {},
        config: {},
      });

      // Execute for tenant2
      await registry.executeWithProtection({
        tenantId: 'tenant-2',
        stageType: 'extraction',
        providerId: 'mock-extraction',
        input: {},
        config: {},
      });

      // Should create separate breakers for each tenant (2 unique Map entries)
      expect(breakerInstances.size).toBe(2);
    });
  });

  describe('getCircuitState', () => {
    it('should return circuit breaker state', async () => {
      const mockGetState = vi.fn().mockResolvedValue('CLOSED');
      mockBreakerFactory = () => ({
        execute: vi.fn(),
        getState: mockGetState,
        forceReset: vi.fn(),
      });

      const state = await registry.getCircuitState('tenant-123', 'mock-extraction');

      expect(state).toBe('CLOSED');
      expect(mockGetState).toHaveBeenCalledTimes(1);
    });

    it('should return OPEN state when circuit is open', async () => {
      const mockGetState = vi.fn().mockResolvedValue('OPEN');
      mockBreakerFactory = () => ({
        execute: vi.fn(),
        getState: mockGetState,
        forceReset: vi.fn(),
      });

      const state = await registry.getCircuitState('tenant-123', 'mock-extraction');

      expect(state).toBe('OPEN');
      expect(mockGetState).toHaveBeenCalledTimes(1);
    });
  });

  describe('resetCircuit', () => {
    it('should manually reset circuit breaker', async () => {
      const mockForceReset = vi.fn().mockResolvedValue({ state: 'CLOSED', action: 'forced' });
      mockBreakerFactory = () => ({
        execute: vi.fn(),
        getState: vi.fn(),
        forceReset: mockForceReset,
      });

      await registry.resetCircuit('tenant-123', 'mock-extraction');

      expect(mockForceReset).toHaveBeenCalledTimes(1);
    });
  });

  describe('getRegistry', () => {
    it('should return underlying provider registry', () => {
      const underlyingRegistry = registry.getRegistry();

      expect(underlyingRegistry).toBe(baseRegistry);
      expect(underlyingRegistry.has('extraction', 'mock-extraction')).toBe(true);
    });
  });
});
