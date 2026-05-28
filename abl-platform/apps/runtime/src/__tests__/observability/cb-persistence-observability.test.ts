/**
 * Circuit Breaker Persistence Observability Tests
 *
 * Verifies that KMS, SearchAI, and Multimodal circuit breaker wrappers
 * correctly log warnings and emit metrics when breaker persistence fails.
 *
 * Scenario: fn() fails -> catch block tries to record failure via breaker ->
 * breaker.recordFailure() itself throws -> inner catch should:
 *   1. Log a warning via log.warn
 *   2. Call recordCBPersistenceFailure(service, 'record_failure')
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// MOCKS — declared before any import that transitively pulls in the modules
// =============================================================================

// Mock logger — capture warn calls across all wrappers
const mockLogWarn = vi.fn();
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: mockLogWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock metrics — capture persistence failure recording
const mockRecordCBPersistenceFailure = vi.fn();
vi.mock('../../observability/metrics.js', () => ({
  recordCBPersistenceFailure: (...args: unknown[]) => mockRecordCBPersistenceFailure(...args),
  setCircuitBreakerState: vi.fn(),
}));

// Mock hybrid CB registry — return a breaker whose recordFailure rejects
const mockRecordFailure = vi.fn().mockRejectedValue(new Error('Redis persistence failed'));
const mockRecordSuccess = vi.fn().mockResolvedValue(undefined);
vi.mock('../../services/resilience/hybrid-cb-registry.js', () => ({
  getCircuitBreakerRegistry: () => ({
    getBreaker: () => ({
      isOpen: () => false,
      recordSuccess: mockRecordSuccess,
      recordFailure: mockRecordFailure,
    }),
  }),
}));

// Mock tenant CB config (transitive dependency of hybrid-cb-registry)
vi.mock('../../services/resilience/tenant-cb-config.js', () => ({
  getTenantCBConfig: () => null,
}));

// Mock Redis client (transitive dependency of hybrid-cb-registry)
vi.mock('../../services/redis/redis-client.js', () => ({
  getRedisClient: () => null,
  getRedisHandle: () => null,
  isRedisAvailable: () => false,
}));

// =============================================================================
// SETUP
// =============================================================================

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  // Reset recordFailure to always reject (tests may override)
  mockRecordFailure.mockRejectedValue(new Error('Redis persistence failed'));
});

// =============================================================================
// KMS CIRCUIT BREAKER
// =============================================================================

describe('KMS circuit breaker persistence observability', () => {
  test('logs warning when breaker persistence fails on recordFailure', async () => {
    const { KMSCircuitBreakerWrapper } = await import('../../services/kms/kms-circuit-breaker.js');
    const mockProvider = { providerType: 'local' } as any;
    const wrapper = new KMSCircuitBreakerWrapper(mockProvider, 'tenant-1');

    await expect(
      wrapper.execute('encrypt', () => Promise.reject(new Error('KMS down'))),
    ).rejects.toThrow('KMS down');

    expect(mockLogWarn).toHaveBeenCalledWith(
      'Failed to persist circuit breaker state',
      expect.objectContaining({
        breakerName: 'kms:local:tenant-1',
      }),
    );
  });

  test('emits recordCBPersistenceFailure metric with service=kms', async () => {
    const { KMSCircuitBreakerWrapper } = await import('../../services/kms/kms-circuit-breaker.js');
    const mockProvider = { providerType: 'local' } as any;
    const wrapper = new KMSCircuitBreakerWrapper(mockProvider, 'tenant-2');

    await expect(
      wrapper.execute('decrypt', () => Promise.reject(new Error('KMS timeout'))),
    ).rejects.toThrow('KMS timeout');

    expect(mockRecordCBPersistenceFailure).toHaveBeenCalledWith('kms', 'record_failure');
  });

  test('does not emit persistence failure metric when recordFailure succeeds', async () => {
    mockRecordFailure.mockResolvedValueOnce(undefined);

    const { KMSCircuitBreakerWrapper } = await import('../../services/kms/kms-circuit-breaker.js');
    const mockProvider = { providerType: 'local' } as any;
    const wrapper = new KMSCircuitBreakerWrapper(mockProvider, 'tenant-3');

    await expect(
      wrapper.execute('encrypt', () => Promise.reject(new Error('KMS down'))),
    ).rejects.toThrow('KMS down');

    expect(mockRecordCBPersistenceFailure).not.toHaveBeenCalled();
  });
});

// =============================================================================
// SEARCH-AI CIRCUIT BREAKER
// =============================================================================

describe('SearchAI circuit breaker persistence observability', () => {
  test('logs warning when breaker persistence fails on recordFailure', async () => {
    const { SearchAICircuitBreaker } =
      await import('../../services/search-ai/search-ai-circuit-breaker.js');
    const wrapper = new SearchAICircuitBreaker('tenant-1');

    await expect(
      wrapper.execute('search', () => Promise.reject(new Error('SearchAI down'))),
    ).rejects.toThrow('SearchAI down');

    expect(mockLogWarn).toHaveBeenCalledWith(
      'Failed to persist circuit breaker state',
      expect.objectContaining({
        breakerName: 'search-ai:tenant-1',
      }),
    );
  });

  test('emits recordCBPersistenceFailure metric with service=search-ai', async () => {
    const { SearchAICircuitBreaker } =
      await import('../../services/search-ai/search-ai-circuit-breaker.js');
    const wrapper = new SearchAICircuitBreaker('tenant-2');

    await expect(
      wrapper.execute('ingest', () => Promise.reject(new Error('SearchAI timeout'))),
    ).rejects.toThrow('SearchAI timeout');

    expect(mockRecordCBPersistenceFailure).toHaveBeenCalledWith('search-ai', 'record_failure');
  });

  test('does not emit persistence failure metric when recordFailure succeeds', async () => {
    mockRecordFailure.mockResolvedValueOnce(undefined);

    const { SearchAICircuitBreaker } =
      await import('../../services/search-ai/search-ai-circuit-breaker.js');
    const wrapper = new SearchAICircuitBreaker('tenant-3');

    await expect(
      wrapper.execute('search', () => Promise.reject(new Error('SearchAI down'))),
    ).rejects.toThrow('SearchAI down');

    expect(mockRecordCBPersistenceFailure).not.toHaveBeenCalled();
  });
});

// =============================================================================
// MULTIMODAL CIRCUIT BREAKER
// =============================================================================

describe('Multimodal circuit breaker persistence observability', () => {
  test('logs warning when breaker persistence fails on recordFailure', async () => {
    const { MultimodalCircuitBreaker } =
      await import('../../attachments/multimodal-circuit-breaker.js');
    const wrapper = new MultimodalCircuitBreaker('tenant-1');

    await expect(
      wrapper.execute('transcribe', () => Promise.reject(new Error('Multimodal down'))),
    ).rejects.toThrow('Multimodal down');

    expect(mockLogWarn).toHaveBeenCalledWith(
      'Failed to persist circuit breaker state',
      expect.objectContaining({
        breakerName: 'multimodal:tenant-1',
      }),
    );
  });

  test('emits recordCBPersistenceFailure metric with service=multimodal', async () => {
    const { MultimodalCircuitBreaker } =
      await import('../../attachments/multimodal-circuit-breaker.js');
    const wrapper = new MultimodalCircuitBreaker('tenant-2');

    await expect(
      wrapper.execute('analyze', () => Promise.reject(new Error('Multimodal timeout'))),
    ).rejects.toThrow('Multimodal timeout');

    expect(mockRecordCBPersistenceFailure).toHaveBeenCalledWith('multimodal', 'record_failure');
  });

  test('does not emit persistence failure metric when recordFailure succeeds', async () => {
    mockRecordFailure.mockResolvedValueOnce(undefined);

    const { MultimodalCircuitBreaker } =
      await import('../../attachments/multimodal-circuit-breaker.js');
    const wrapper = new MultimodalCircuitBreaker('tenant-3');

    await expect(
      wrapper.execute('transcribe', () => Promise.reject(new Error('Multimodal down'))),
    ).rejects.toThrow('Multimodal down');

    expect(mockRecordCBPersistenceFailure).not.toHaveBeenCalled();
  });
});
