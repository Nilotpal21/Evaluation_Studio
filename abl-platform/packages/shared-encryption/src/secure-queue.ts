import {
  encryptFields,
  decryptFields,
  type TenantFieldEncryptionService,
} from './field-interceptor.js';
import { getRedisQueueManifest } from './encryption-manifest.js';

export async function wrapJobDataForEncrypt(
  queueName: string,
  data: Record<string, unknown>,
  encryptionService: TenantFieldEncryptionService,
): Promise<Record<string, unknown>> {
  const manifest = getRedisQueueManifest(queueName);
  if (manifest.fieldsToEncrypt.length === 0) return data;

  const tenantId = data.tenantId as string;
  if (!tenantId) {
    throw new Error(`tenantId required in job data for encrypted queue "${queueName}"`);
  }

  return await encryptFields(data, manifest.fieldsToEncrypt, tenantId, encryptionService);
}

export async function unwrapJobDataForDecrypt(
  queueName: string,
  data: Record<string, unknown>,
  encryptionService: TenantFieldEncryptionService,
): Promise<Record<string, unknown>> {
  const manifest = getRedisQueueManifest(queueName);
  if (manifest.fieldsToEncrypt.length === 0) return data;

  const tenantId = data.tenantId as string;
  if (!tenantId) {
    throw new Error(`tenantId required in job data for decrypting queue "${queueName}"`);
  }

  return await decryptFields(data, manifest.fieldsToEncrypt, tenantId, encryptionService);
}
