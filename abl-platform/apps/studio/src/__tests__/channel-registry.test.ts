import { describe, it, expect } from 'vitest';

describe('channel-registry', () => {
  it('exports CHANNEL_CATALOG_ORDER with all registry entries', async () => {
    const { CHANNEL_CATALOG_ORDER, CHANNEL_REGISTRY } =
      await import('../components/deployments/channels/channel-registry');
    expect(CHANNEL_CATALOG_ORDER.length).toBeGreaterThanOrEqual(14);
    // Every entry in CHANNEL_CATALOG_ORDER must exist in the registry
    for (const id of CHANNEL_CATALOG_ORDER) {
      expect(
        CHANNEL_REGISTRY[id],
        `${id} in CHANNEL_CATALOG_ORDER but not in registry`,
      ).toBeDefined();
    }
    // Every registry entry must be in CHANNEL_CATALOG_ORDER
    for (const id of Object.keys(CHANNEL_REGISTRY)) {
      expect(CHANNEL_CATALOG_ORDER).toContain(id);
    }
  });

  it('every registry entry has required fields', async () => {
    const { CHANNEL_REGISTRY } =
      await import('../components/deployments/channels/channel-registry');
    for (const [id, def] of Object.entries(CHANNEL_REGISTRY)) {
      expect(def.id).toBe(id);
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.category).toMatch(/^(messaging|sdk|webhook|voice|protocol)$/);
      expect(def.capabilities).toBeDefined();
      expect(typeof def.capabilities.multiConnection).toBe('boolean');
      expect(typeof def.capabilities.hasCredentials).toBe('boolean');
      expect(Array.isArray(def.credentialFields)).toBe(true);
    }
  });

  it('credential fields have unique keys per channel type', async () => {
    const { CHANNEL_REGISTRY } =
      await import('../components/deployments/channels/channel-registry');
    for (const def of Object.values(CHANNEL_REGISTRY)) {
      const keys = (def as { credentialFields: { key: string }[] }).credentialFields.map(
        (f: { key: string }) => f.key,
      );
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});
