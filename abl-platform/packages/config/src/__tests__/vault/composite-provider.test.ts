import { describe, it, expect, vi } from 'vitest';
import { CompositeVaultProvider } from '../../vault/composite-provider.js';
import type { VaultProvider } from '../../vault/index.js';

function createMockProvider(
  name: string,
  values: Record<string, string>,
  available = true,
): VaultProvider {
  return {
    name,
    initialize: vi.fn(),
    get: vi.fn(async (key: string) => values[key]),
    getAll: vi.fn(async () => values),
    isAvailable: vi.fn(() => available),
    close: vi.fn(),
  };
}

describe('CompositeVaultProvider', () => {
  it('should return value from highest priority provider', async () => {
    const high = createMockProvider('high', { KEY: 'high-value' });
    const low = createMockProvider('low', { KEY: 'low-value' });

    const composite = new CompositeVaultProvider([high, low]);
    await composite.initialize();

    expect(await composite.get('KEY')).toBe('high-value');
  });

  it('should fall back to lower priority if high does not have key', async () => {
    const high = createMockProvider('high', {});
    const low = createMockProvider('low', { FALLBACK: 'found-it' });

    const composite = new CompositeVaultProvider([high, low]);
    await composite.initialize();

    expect(await composite.get('FALLBACK')).toBe('found-it');
  });

  it('should skip unavailable providers', async () => {
    const unavailable = createMockProvider('down', { KEY: 'unreachable' }, false);
    const available = createMockProvider('up', { KEY: 'reachable' });

    const composite = new CompositeVaultProvider([unavailable, available]);
    await composite.initialize();

    expect(await composite.get('KEY')).toBe('reachable');
  });

  it('should merge getAll with higher priority winning', async () => {
    const high = createMockProvider('high', { A: 'h-a', B: 'h-b' });
    const low = createMockProvider('low', { B: 'l-b', C: 'l-c' });

    const composite = new CompositeVaultProvider([high, low]);
    await composite.initialize();

    const all = await composite.getAll();
    expect(all).toEqual({ A: 'h-a', B: 'h-b', C: 'l-c' });
  });

  it('should close all providers', async () => {
    const p1 = createMockProvider('p1', {});
    const p2 = createMockProvider('p2', {});

    const composite = new CompositeVaultProvider([p1, p2]);
    await composite.close();

    expect(p1.close).toHaveBeenCalled();
    expect(p2.close).toHaveBeenCalled();
  });

  it('should be available if any provider is available', () => {
    const unavailable = createMockProvider('down', {}, false);
    const available = createMockProvider('up', {});

    const composite = new CompositeVaultProvider([unavailable, available]);
    expect(composite.isAvailable()).toBe(true);
  });

  it('should not be available if no providers are available', () => {
    const p1 = createMockProvider('p1', {}, false);
    const p2 = createMockProvider('p2', {}, false);

    const composite = new CompositeVaultProvider([p1, p2]);
    expect(composite.isAvailable()).toBe(false);
  });

  it('should report provider status after initialization', async () => {
    const good = createMockProvider('good', {});
    const bad: VaultProvider = {
      name: 'bad',
      initialize: vi.fn().mockRejectedValue(new Error('init failed')),
      get: vi.fn(),
      getAll: vi.fn(),
      isAvailable: vi.fn(() => false),
      close: vi.fn(),
    };

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const composite = new CompositeVaultProvider([good, bad]);
    await composite.initialize();

    const status = composite.getProviderStatus();
    expect(status.succeeded).toEqual(['good']);
    expect(status.failed).toEqual(['bad']);

    errorSpy.mockRestore();
  });

  it('should throw when ALL providers fail to initialize', async () => {
    const bad1: VaultProvider = {
      name: 'bad1',
      initialize: vi.fn().mockRejectedValue(new Error('fail1')),
      get: vi.fn(),
      getAll: vi.fn(),
      isAvailable: vi.fn(() => false),
      close: vi.fn(),
    };
    const bad2: VaultProvider = {
      name: 'bad2',
      initialize: vi.fn().mockRejectedValue(new Error('fail2')),
      get: vi.fn(),
      getAll: vi.fn(),
      isAvailable: vi.fn(() => false),
      close: vi.fn(),
    };

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const composite = new CompositeVaultProvider([bad1, bad2]);
    await expect(composite.initialize()).rejects.toThrow('all providers failed');

    errorSpy.mockRestore();
  });

  it('should delegate set to first available provider that supports writes', async () => {
    const writeable: VaultProvider = {
      name: 'writeable',
      initialize: vi.fn(),
      get: vi.fn(),
      getAll: vi.fn(async () => ({})),
      isAvailable: vi.fn(() => true),
      close: vi.fn(),
      set: vi.fn(),
    };

    const composite = new CompositeVaultProvider([writeable]);
    await composite.initialize();
    await composite.set('KEY', 'VALUE');

    expect(writeable.set).toHaveBeenCalledWith('KEY', 'VALUE');
  });

  it('should delegate delete to first available provider that supports deletes', async () => {
    const deleteable: VaultProvider = {
      name: 'deleteable',
      initialize: vi.fn(),
      get: vi.fn(),
      getAll: vi.fn(async () => ({})),
      isAvailable: vi.fn(() => true),
      close: vi.fn(),
      delete: vi.fn(),
    };

    const composite = new CompositeVaultProvider([deleteable]);
    await composite.initialize();
    await composite.delete('KEY');

    expect(deleteable.delete).toHaveBeenCalledWith('KEY');
  });

  it('should throw when no provider supports writes', async () => {
    const readOnly = createMockProvider('readonly', {});

    const composite = new CompositeVaultProvider([readOnly]);
    await composite.initialize();
    await expect(composite.set('KEY', 'VALUE')).rejects.toThrow('No provider supports writes');
  });

  it('should throw when no provider supports deletes', async () => {
    const readOnly = createMockProvider('readonly', {});

    const composite = new CompositeVaultProvider([readOnly]);
    await composite.initialize();
    await expect(composite.delete('KEY')).rejects.toThrow('No provider supports deletes');
  });
});
