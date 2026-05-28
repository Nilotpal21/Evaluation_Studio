import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mockInitialize = vi.fn().mockResolvedValue(undefined);
const mockReset = vi.fn().mockResolvedValue(undefined);
const mockSetMasterKey = vi.fn();

vi.mock('@agent-platform/database/mongo', () => ({
  MongoConnectionManager: {
    initialize: (...args: unknown[]) => mockInitialize(...args),
    reset: (...args: unknown[]) => mockReset(...args),
  },
  setMasterKey: (...args: unknown[]) => mockSetMasterKey(...args),
}));

describe('studio db bootstrap', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalEncryptionEnabled = process.env.ENCRYPTION_ENABLED;
  const originalEncryptionMasterKey = process.env.ENCRYPTION_MASTER_KEY;

  beforeEach(() => {
    vi.resetModules();
    mockInitialize.mockClear();
    mockReset.mockClear();
    mockSetMasterKey.mockClear();
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }

    if (originalEncryptionEnabled === undefined) {
      delete process.env.ENCRYPTION_ENABLED;
    } else {
      process.env.ENCRYPTION_ENABLED = originalEncryptionEnabled;
    }

    if (originalEncryptionMasterKey === undefined) {
      delete process.env.ENCRYPTION_MASTER_KEY;
    } else {
      process.env.ENCRYPTION_MASTER_KEY = originalEncryptionMasterKey;
    }
  });

  test('disables autoIndex in production bootstrap', async () => {
    process.env.NODE_ENV = 'production';

    const { dbReady } = await import('../db');
    await dbReady;

    expect(mockInitialize).toHaveBeenCalledWith(
      expect.objectContaining({
        autoIndex: false,
      }),
    );
  });

  test('sets the encryption master key before initialization when configured', async () => {
    process.env.NODE_ENV = 'test';
    process.env.ENCRYPTION_MASTER_KEY = 'abc123';

    const { dbReady } = await import('../db');
    await dbReady;

    expect(mockSetMasterKey).toHaveBeenCalledWith('abc123');
  });
});
