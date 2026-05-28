/**
 * Shared SSO Helpers
 *
 * Common utilities used across SSO route handlers (SAML, OIDC, init).
 */

// NOTE: Manual encryption retained — SSO configs are stored inside Organization.ssoConfigs[]
// array subdocuments, which are NOT covered by the Mongoose encryption plugin.
import { decryptForTenantAuto, isTenantEncryptionReady } from '@agent-platform/shared/encryption';

/**
 * Decrypt SSO config stored via tenant-scoped DEK envelope encryption.
 */
export async function decryptSSOConfig(encryptedConfig: string, orgId: string): Promise<any> {
  if (!isTenantEncryptionReady()) {
    throw new Error('Tenant DEK encryption is not initialized for SSO config decryption');
  }

  try {
    const decrypted = await decryptForTenantAuto(encryptedConfig, orgId);
    return JSON.parse(decrypted);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to decrypt SSO config: ${message}`);
  }
}
