import { describe, it, expect } from 'vitest';

describe('EditModuleConfigDialog', () => {
  it('should be importable', async () => {
    const mod = await import('../../components/modules/EditModuleConfigDialog');
    expect(mod.EditModuleConfigDialog).toBeDefined();
  });
});
