import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const mockFindOne = vi.fn();
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  return {
    mockFindOne,
    mockLogger,
  };
});

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => mocks.mockLogger),
}));

vi.mock('@agent-platform/database/models', () => ({
  TenantServiceInstance: {
    findOne: (...args: unknown[]) => mocks.mockFindOne(...args),
  },
}));

import { findDefaultActiveVoiceServiceInstance } from '../../services/voice/voice-service-instance-repo.js';

describe('voice-service-instance-repo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockFindOne.mockReset();
  });

  it('prefers the default active tenant instance before falling back', async () => {
    const defaultInstance = {
      id: 'elevenlabs-default',
      tenantId: 'tenant-1',
      serviceType: 'elevenlabs',
    };

    mocks.mockFindOne.mockImplementation(
      async (filter: {
        tenantId: string;
        serviceType: string;
        isDefault?: boolean;
        isActive: boolean;
      }) => {
        if (
          filter.tenantId === 'tenant-1' &&
          filter.serviceType === 'elevenlabs' &&
          filter.isDefault === true &&
          filter.isActive === true
        ) {
          return defaultInstance;
        }
        return null;
      },
    );

    const result = await findDefaultActiveVoiceServiceInstance('tenant-1', 'elevenlabs');

    expect(result).toBe(defaultInstance);
    expect(mocks.mockFindOne).toHaveBeenCalledTimes(1);
    expect(mocks.mockFindOne).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      serviceType: 'elevenlabs',
      isDefault: true,
      isActive: true,
    });
  });

  it('falls back to any active tenant instance when no default exists', async () => {
    const fallbackInstance = {
      id: 'deepgram-fallback',
      tenantId: 'tenant-1',
      serviceType: 'deepgram',
    };

    mocks.mockFindOne.mockImplementation(
      async (filter: {
        tenantId: string;
        serviceType: string;
        isDefault?: boolean;
        isActive: boolean;
      }) => {
        if (
          filter.tenantId === 'tenant-1' &&
          filter.serviceType === 'deepgram' &&
          filter.isDefault === true &&
          filter.isActive === true
        ) {
          return null;
        }

        if (filter.tenantId === 'tenant-1' && filter.serviceType === 'deepgram') {
          return fallbackInstance;
        }

        return null;
      },
    );

    const result = await findDefaultActiveVoiceServiceInstance('tenant-1', 'deepgram');

    expect(result).toBe(fallbackInstance);
    expect(mocks.mockFindOne).toHaveBeenCalledTimes(2);
    expect(mocks.mockFindOne).toHaveBeenNthCalledWith(1, {
      tenantId: 'tenant-1',
      serviceType: 'deepgram',
      isDefault: true,
      isActive: true,
    });
    expect(mocks.mockFindOne).toHaveBeenNthCalledWith(2, {
      tenantId: 'tenant-1',
      serviceType: 'deepgram',
      isActive: true,
    });
  });

  it('returns null and logs a warning when the DB lookup fails', async () => {
    mocks.mockFindOne.mockRejectedValue(new Error('db unavailable'));

    const result = await findDefaultActiveVoiceServiceInstance('tenant-1', 'deepgram');

    expect(result).toBeNull();
    expect(mocks.mockLogger.warn).toHaveBeenCalledWith('Failed to resolve service instance', {
      tenantId: 'tenant-1',
      serviceType: 'deepgram',
      error: 'db unavailable',
    });
  });
});
