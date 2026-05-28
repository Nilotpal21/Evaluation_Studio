/**
 * KMS Provider Factory
 *
 * Creates KMS provider instances based on configuration.
 * Uses dynamic imports to avoid bundling unused cloud SDKs.
 */

import type { KMSProvider } from '../types.js';

export type KMSProviderType =
  | 'local'
  | 'aws-kms'
  | 'azure-keyvault'
  | 'azure-managed-hsm'
  | 'gcp-cloud-kms'
  | 'external';

export interface KMSProviderConfig {
  providerType: KMSProviderType;
  /** Required for local provider */
  masterKeyHex?: string;
  /** AWS KMS config */
  region?: string;
  keyId?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Azure Key Vault / Managed HSM config */
  vaultUrl?: string;
  keyName?: string;
  keyVersion?: string;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  /** GCP Cloud KMS config */
  projectId?: string;
  location?: string;
  keyRing?: string;
  credentialsPath?: string;
  /** External KMS (BYOP) config */
  externalEndpoint?: string;
  externalAuthMethod?: string;
  externalApiKey?: string;
  externalOAuth2ClientId?: string;
  externalOAuth2ClientSecret?: string;
  externalOAuth2TokenUrl?: string;
  externalHmacSecret?: string;
  externalTlsCert?: string;
  externalTlsKey?: string;
  externalTlsCa?: string;
}

/**
 * Create a KMS provider instance from configuration.
 * Dynamic imports keep cloud SDKs out of the bundle until needed.
 */
export async function createKMSProvider(config: KMSProviderConfig): Promise<KMSProvider> {
  switch (config.providerType) {
    case 'local': {
      const { LocalKMSProvider } = await import('../local-kms-provider.js');
      if (!config.masterKeyHex) {
        throw new Error('LocalKMSProvider requires masterKeyHex');
      }
      return new LocalKMSProvider(config.masterKeyHex);
    }

    case 'aws-kms': {
      const { AWSKMSProvider } = await import('./aws-kms-provider.js');
      if (!config.region || !config.keyId) {
        throw new Error('AWSKMSProvider requires region and keyId');
      }
      return new AWSKMSProvider({
        region: config.region,
        keyId: config.keyId,
        endpoint: config.endpoint,
        credentials:
          config.accessKeyId && config.secretAccessKey
            ? {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey,
              }
            : undefined,
      });
    }

    case 'azure-keyvault': {
      const { AzureKeyVaultProvider } = await import('./azure-keyvault-provider.js');
      if (!config.vaultUrl || !config.keyName) {
        throw new Error('AzureKeyVaultProvider requires vaultUrl and keyName');
      }
      return new AzureKeyVaultProvider({
        vaultUrl: config.vaultUrl,
        keyName: config.keyName,
        keyVersion: config.keyVersion,
        tenantId: config.tenantId,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
      });
    }

    case 'azure-managed-hsm': {
      const { AzureManagedHSMProvider } = await import('./azure-managed-hsm-provider.js');
      if (!config.vaultUrl || !config.keyName) {
        throw new Error('AzureManagedHSMProvider requires vaultUrl and keyName');
      }
      return new AzureManagedHSMProvider({
        vaultUrl: config.vaultUrl,
        keyName: config.keyName,
        keyVersion: config.keyVersion,
        tenantId: config.tenantId,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
      });
    }

    case 'gcp-cloud-kms': {
      const { GCPCloudKMSProvider } = await import('./gcp-cloud-kms-provider.js');
      if (!config.projectId || !config.location || !config.keyRing || !config.keyName) {
        throw new Error('GCPCloudKMSProvider requires projectId, location, keyRing, and keyName');
      }
      return new GCPCloudKMSProvider({
        projectId: config.projectId,
        location: config.location,
        keyRing: config.keyRing,
        keyName: config.keyName,
        keyVersion: config.keyVersion,
        credentialsPath: config.credentialsPath,
      });
    }

    case 'external': {
      const { ExternalKMSProvider } = await import('./external-kms-provider.js');
      if (!config.externalEndpoint || !config.externalAuthMethod) {
        throw new Error('ExternalKMSProvider requires externalEndpoint and externalAuthMethod');
      }
      return new ExternalKMSProvider({
        endpoint: config.externalEndpoint,
        authMethod: config.externalAuthMethod as any,
        apiKey: config.externalApiKey,
        oauth2ClientId: config.externalOAuth2ClientId,
        oauth2ClientSecret: config.externalOAuth2ClientSecret,
        oauth2TokenUrl: config.externalOAuth2TokenUrl,
        hmacSecret: config.externalHmacSecret,
        tlsCert: config.externalTlsCert,
        tlsKey: config.externalTlsKey,
        tlsCa: config.externalTlsCa,
      });
    }

    default:
      throw new Error(`Unknown KMS provider type: ${config.providerType}`);
  }
}

// Type-only re-exports — no runtime module resolution, safe for bundlers
export type { AWSKMSProviderConfig } from './aws-kms-provider.js';
export type { AzureKeyVaultProviderConfig } from './azure-keyvault-provider.js';
export type { GCPCloudKMSProviderConfig } from './gcp-cloud-kms-provider.js';
export type { ExternalKMSProviderConfig, ExternalAuthMethod } from './external-kms-provider.js';
