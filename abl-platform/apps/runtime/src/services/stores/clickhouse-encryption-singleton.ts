/**
 * ClickHouse Encryption Interceptor Singleton
 *
 * Provides a lazily-initialized interceptor that encrypts/decrypts fields
 * on ClickHouse rows based on the encryption manifest.
 *
 * The interceptor is wired into every BufferedClickHouseWriter that writes
 * to tables with fieldsToEncrypt > 0 (messages, traces, platform_events, etc.).
 */

import { ClickHouseEncryptionInterceptor } from '@agent-platform/database';
import {
  getEncryptionFacade,
  encryptForTenantAuto,
  decryptForTenantAuto,
  encryptFields,
  decryptFields,
  getClickHouseManifest,
} from '@agent-platform/shared/encryption';

let interceptor: ClickHouseEncryptionInterceptor | null = null;

/**
 * Get the ClickHouse encryption interceptor singleton.
 * Returns null if the tenant DEK facade is not available.
 */
export function getClickHouseEncryptionInterceptor(): ClickHouseEncryptionInterceptor | null {
  if (interceptor) return interceptor;
  if (!getEncryptionFacade()) return null;

  const encryptionService = {
    encryptForTenant: (plaintext: string, tenantId: string) =>
      encryptForTenantAuto(plaintext, tenantId),
    decryptForTenant: (ciphertext: string, tenantId: string) =>
      decryptForTenantAuto(ciphertext, tenantId),
  };

  interceptor = new ClickHouseEncryptionInterceptor({
    encryptFields: async (row, fields, tenantId, svc) =>
      await encryptFields(row, fields, tenantId, svc as typeof encryptionService),
    decryptFields: async (row, fields, tenantId, svc) =>
      await decryptFields(row, fields, tenantId, svc as typeof encryptionService),
    getManifest: getClickHouseManifest,
    encryptionService,
  });

  return interceptor;
}

/**
 * Reset the singleton (for testing only).
 */
export function _resetClickHouseEncryptionInterceptorForTesting(): void {
  interceptor = null;
}
