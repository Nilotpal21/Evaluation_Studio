export interface TenantEncryptionAADContext {
  resourceType: string;
  fieldName: string;
}

function requireNonEmpty(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Tenant encryption ${label} must be a non-empty string`);
  }
  return trimmed;
}

/**
 * Canonical AAD format used for tenant-scoped DEK encryption.
 *
 * - No context: tenant-only binding for legacy/general ciphertext.
 * - With context: tenant + resource + field binding for field-swap protection.
 */
export function buildTenantEncryptionAAD(
  tenantId: string,
  context?: TenantEncryptionAADContext,
): string {
  const normalizedTenantId = requireNonEmpty('tenantId', tenantId);
  if (!context) {
    return normalizedTenantId;
  }

  return [
    normalizedTenantId,
    requireNonEmpty('resourceType', context.resourceType),
    requireNonEmpty('fieldName', context.fieldName),
  ].join(':');
}

/**
 * Ordered decrypt fallback candidates:
 * 1. tenant + resource + field
 * 2. tenant only
 * 3. no AAD (legacy)
 */
export function buildTenantEncryptionAADCandidates(
  tenantId: string,
  context?: TenantEncryptionAADContext,
): Array<string | undefined> {
  const tenantOnly = buildTenantEncryptionAAD(tenantId);
  if (!context) {
    return [tenantOnly, undefined];
  }

  const fullContext = buildTenantEncryptionAAD(tenantId, context);
  return fullContext === tenantOnly
    ? [tenantOnly, undefined]
    : [fullContext, tenantOnly, undefined];
}
