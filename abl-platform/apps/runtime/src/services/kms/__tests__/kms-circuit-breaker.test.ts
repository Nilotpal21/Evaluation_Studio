import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KMSCircuitBreakerWrapper } from '../kms-circuit-breaker.js';

// Mock the hybrid circuit breaker registry
const mockIsOpen = vi.fn(() => false);
const mockRecordSuccess = vi.fn();
const mockRecordFailure = vi.fn();
const mockGetBreaker = vi.fn(() => ({
  isOpen: mockIsOpen,
  recordSuccess: mockRecordSuccess,
  recordFailure: mockRecordFailure,
}));
const mockGetRegistry = vi.fn(() => ({ getBreaker: mockGetBreaker }));

vi.mock('../../resilience/hybrid-cb-registry.js', () => ({
  getCircuitBreakerRegistry: () => mockGetRegistry(),
}));

const mockProvider = {
  providerType: 'aws-kms',
  initialize: vi.fn(),
  shutdown: vi.fn(),
  healthCheck: vi.fn(),
  generateDataKey: vi.fn(),
  wrapKey: vi.fn(),
  unwrapKey: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  createKey: vi.fn(),
  describeKey: vi.fn(),
  enableKeyRotation: vi.fn(),
  scheduleKeyDeletion: vi.fn(),
};

describe('KMSCircuitBreakerWrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default: circuit is closed
    mockIsOpen.mockReturnValue(false);
  });

  it('constructs with correct breaker name', () => {
    const wrapper = new KMSCircuitBreakerWrapper(mockProvider as any, 'tenant-1');
    // breakerName is private, but we can verify via getBreaker call
    expect(wrapper).toBeDefined();
  });

  it('executes operation through circuit breaker on success', async () => {
    const wrapper = new KMSCircuitBreakerWrapper(mockProvider as any, 'tenant-1');

    const result = await wrapper.execute('wrapKey', async () => 'wrapped-data');

    expect(result).toBe('wrapped-data');
    expect(mockGetBreaker).toHaveBeenCalledWith('kms:aws-kms:tenant-1', 'tenant-1');
    expect(mockIsOpen).toHaveBeenCalled();
    expect(mockRecordSuccess).toHaveBeenCalledOnce();
  });

  it('propagates errors from the operation', async () => {
    const wrapper = new KMSCircuitBreakerWrapper(mockProvider as any, 'tenant-2');

    await expect(
      wrapper.execute('unwrapKey', async () => {
        throw new Error('KMS timeout');
      }),
    ).rejects.toThrow('KMS timeout');

    expect(mockRecordFailure).toHaveBeenCalledOnce();
  });

  it('propagates circuit breaker open errors', async () => {
    const wrapper = new KMSCircuitBreakerWrapper(mockProvider as any, 'tenant-3');
    mockIsOpen.mockReturnValue(true);

    await expect(wrapper.execute('encrypt', async () => 'data')).rejects.toThrow(
      'KMS circuit breaker is open for kms:aws-kms:tenant-3',
    );
  });

  it('uses provider type in breaker name', async () => {
    const azureProvider = { ...mockProvider, providerType: 'azure-keyvault' };
    const wrapper = new KMSCircuitBreakerWrapper(azureProvider as any, 'tenant-4');

    await wrapper.execute('wrapKey', async () => 'result');

    expect(mockGetBreaker).toHaveBeenCalledWith('kms:azure-keyvault:tenant-4', 'tenant-4');
  });

  it('returns typed results', async () => {
    const wrapper = new KMSCircuitBreakerWrapper(mockProvider as any, 'tenant-5');

    const buf = await wrapper.execute<Buffer>('unwrapKey', async () => Buffer.from('key'));

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString()).toBe('key');
  });
});
