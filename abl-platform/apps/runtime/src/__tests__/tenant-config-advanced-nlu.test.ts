import { describe, it, expect } from 'vitest';

describe('advancedNlu entitlement', () => {
  it('should include advancedNlu in ENTERPRISE plan features', async () => {
    const { PLAN_FEATURES } = await import('../services/tenant-config.js');
    expect(PLAN_FEATURES.ENTERPRISE.advancedNlu).toBe(true);
  });

  it('should NOT include advancedNlu in BUSINESS plan features', async () => {
    const { PLAN_FEATURES } = await import('../services/tenant-config.js');
    expect(PLAN_FEATURES.BUSINESS.advancedNlu).toBeFalsy();
  });

  it('should NOT include advancedNlu in TEAM plan features', async () => {
    const { PLAN_FEATURES } = await import('../services/tenant-config.js');
    expect(PLAN_FEATURES.TEAM.advancedNlu).toBeFalsy();
  });

  it('should NOT include advancedNlu in FREE plan features', async () => {
    const { PLAN_FEATURES } = await import('../services/tenant-config.js');
    expect(PLAN_FEATURES.FREE.advancedNlu).toBeFalsy();
  });
});
