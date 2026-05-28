import { describe, expect, it } from 'vitest';
import { buildTenantUsageDetailHref, resolveTenantDetailTab } from '../lib/tenant-detail-tabs.js';

describe('tenant detail tab helpers', () => {
  it('resolves valid tenant detail tabs from query params', () => {
    expect(resolveTenantDetailTab('usage')).toBe('usage');
    expect(resolveTenantDetailTab('attachments')).toBe('attachments');
  });

  it('falls back to overview for unknown tenant detail tabs', () => {
    expect(resolveTenantDetailTab(null)).toBe('overview');
    expect(resolveTenantDetailTab(undefined)).toBe('overview');
    expect(resolveTenantDetailTab('billing')).toBe('overview');
  });

  it('builds usage drilldown hrefs that land on the publication section', () => {
    expect(buildTenantUsageDetailHref('tenant-123')).toBe(
      '/tenants/tenant-123?tab=usage#publication-visibility',
    );
    expect(buildTenantUsageDetailHref('tenant/needs encoding')).toBe(
      '/tenants/tenant%2Fneeds%20encoding?tab=usage#publication-visibility',
    );
  });
});
