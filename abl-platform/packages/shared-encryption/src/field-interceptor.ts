export const ENC_VALUE_PREFIX = 'ENC:v3:';

export interface TenantFieldEncryptionService {
  encryptForTenant(
    plaintext: string,
    tenantId: string,
    projectId?: string,
    environment?: string,
  ): Promise<string>;
  decryptForTenant(encryptedData: string, tenantId: string): Promise<string>;
}

export async function encryptFields(
  row: Record<string, unknown>,
  fields: readonly string[],
  tenantId: string,
  encryptionService: TenantFieldEncryptionService,
): Promise<Record<string, unknown>> {
  if (row._enc) {
    throw new Error(`Row already encrypted (_enc=${row._enc})`);
  }

  const result = { ...row };

  for (const field of fields) {
    const value = result[field];
    if (value == null) continue;

    const str = typeof value === 'string' ? value : JSON.stringify(value);

    if (str.startsWith(ENC_VALUE_PREFIX)) {
      throw new Error(
        `Field "${field}" already has encryption prefix — double encryption detected`,
      );
    }

    result[field] = ENC_VALUE_PREFIX + (await encryptionService.encryptForTenant(str, tenantId));
  }

  result._enc = 'v3';
  return result;
}

export async function decryptFields(
  row: Record<string, unknown>,
  fields: readonly string[],
  tenantId: string,
  encryptionService: TenantFieldEncryptionService,
): Promise<Record<string, unknown>> {
  if (!row._enc) return row;

  const result = { ...row };

  for (const field of fields) {
    const value = result[field];
    if (value == null || typeof value !== 'string') continue;
    if (!value.startsWith(ENC_VALUE_PREFIX)) continue;

    const ciphertext = value.slice(ENC_VALUE_PREFIX.length);
    result[field] = await encryptionService.decryptForTenant(ciphertext, tenantId);
  }

  delete result._enc;
  return result;
}
