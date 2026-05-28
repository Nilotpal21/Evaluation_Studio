export const TENANT_DETAIL_TAB_IDS = [
  'overview',
  'members',
  'projects',
  'config',
  'deals',
  'usage',
  'attachments',
] as const;

export type TenantDetailTabId = (typeof TENANT_DETAIL_TAB_IDS)[number];

const DEFAULT_TENANT_DETAIL_TAB: TenantDetailTabId = 'overview';
const TENANT_DETAIL_TAB_ID_SET = new Set<string>(TENANT_DETAIL_TAB_IDS);

export function resolveTenantDetailTab(tab: string | null | undefined): TenantDetailTabId {
  if (tab && TENANT_DETAIL_TAB_ID_SET.has(tab)) {
    return tab as TenantDetailTabId;
  }

  return DEFAULT_TENANT_DETAIL_TAB;
}

export function buildTenantUsageDetailHref(tenantId: string): string {
  return `/tenants/${encodeURIComponent(tenantId)}?tab=usage#publication-visibility`;
}
