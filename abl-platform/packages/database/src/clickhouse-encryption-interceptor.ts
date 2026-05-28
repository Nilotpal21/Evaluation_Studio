/**
 * ClickHouse Encryption Interceptor
 *
 * Encrypts fields before insert and decrypts after query, driven by a manifest.
 * Uses dependency injection to avoid circular dependency between database ↔ shared.
 * Wired by the app layer (runtime) which owns both packages.
 */

export interface StoreEncryptionConfig {
  readonly fieldsToEncrypt: readonly string[];
}

export interface ClickHouseEncryptionDeps {
  encryptFields: (
    row: Record<string, unknown>,
    fields: readonly string[],
    tenantId: string,
    encryptionService: unknown,
  ) => Promise<Record<string, unknown>>;
  decryptFields: (
    row: Record<string, unknown>,
    fields: readonly string[],
    tenantId: string,
    encryptionService: unknown,
  ) => Promise<Record<string, unknown>>;
  getManifest: (table: string) => StoreEncryptionConfig;
  encryptionService: unknown;
}

export class ClickHouseEncryptionInterceptor {
  private readonly deps: ClickHouseEncryptionDeps;

  constructor(deps: ClickHouseEncryptionDeps) {
    this.deps = deps;
  }

  async beforeInsert(
    table: string,
    rows: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    const manifest = this.deps.getManifest(table);
    if (manifest.fieldsToEncrypt.length === 0) return rows;

    return await Promise.all(
      rows.map(async (row) => {
        const tenantId = row.tenant_id as string;
        if (!tenantId) {
          throw new Error(`tenant_id required for encrypted ClickHouse table "${table}"`);
        }
        return await this.deps.encryptFields(
          row,
          manifest.fieldsToEncrypt,
          tenantId,
          this.deps.encryptionService,
        );
      }),
    );
  }

  async afterQuery(
    table: string,
    rows: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    const manifest = this.deps.getManifest(table);
    if (manifest.fieldsToEncrypt.length === 0) return rows;

    return await Promise.all(
      rows.map(async (row) => {
        if (row._enc) {
          const tenantId = row.tenant_id as string;
          if (!tenantId) {
            throw new Error(`tenant_id required to decrypt ClickHouse table "${table}"`);
          }
          try {
            return await this.deps.decryptFields(
              row,
              manifest.fieldsToEncrypt,
              tenantId,
              this.deps.encryptionService,
            );
          } catch (err) {
            // Null out encrypted fields to prevent ciphertext leaking to consumers.
            // Return the row with nulled fields rather than crashing the entire query.
            const result = { ...row };
            for (const field of manifest.fieldsToEncrypt) {
              if (result[field] != null) {
                result[field] = null;
              }
            }
            result._decryptionFailed = true;
            delete result._enc;
            return result;
          }
        }
        return row;
      }),
    );
  }
}
