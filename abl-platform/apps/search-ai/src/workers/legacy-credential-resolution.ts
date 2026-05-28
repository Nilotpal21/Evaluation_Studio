import { resolveTenantPlaintextValue } from '@agent-platform/database';

export interface LegacyCredentialApiKeyRecord {
  encryptedApiKey?: string | null;
  _decryptionFailed?: boolean;
}

export async function resolveLegacyCredentialApiKey(
  credential: LegacyCredentialApiKeyRecord | null,
  tenantId: string,
  credentialId: string,
): Promise<string> {
  if (!credential) {
    throw new Error(`LLM Credential ${credentialId} not found or inactive`);
  }

  let apiKey: string | null;
  try {
    apiKey = await resolveTenantPlaintextValue(credential.encryptedApiKey ?? null, tenantId, {
      decryptionFailed: Boolean(credential._decryptionFailed),
    });
  } catch {
    throw new Error(`LLM Credential ${credentialId} could not be decrypted`);
  }

  if (!apiKey) {
    throw new Error(`LLM Credential ${credentialId} does not have a usable API key`);
  }

  return apiKey;
}
