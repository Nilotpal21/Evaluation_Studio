import { getEncryptionService } from '@agent-platform/shared/encryption';

export function encryptMFASecret(secret: string, userId: string): string {
  return getEncryptionService().encrypt(secret, userId);
}

export function decryptMFASecret(encryptedSecret: string, userId: string): string {
  return getEncryptionService().decrypt(encryptedSecret, userId);
}
