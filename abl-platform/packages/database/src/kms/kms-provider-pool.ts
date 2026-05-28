/**
 * KMS Provider Pool
 *
 * Caches KMS provider instances keyed by config fingerprint.
 * Uses LRU eviction when pool reaches capacity.
 * Always keeps a local provider available as the platform default.
 */

import type { KMSAADContext, KMSProvider } from './types.js';
import type { IResolvedProviderRef } from '../models/materialized-kms-config.model.js';
import { LocalKMSProvider } from './local-kms-provider.js';
import { decryptAuthConfig } from './auth-config-crypto.js';
import { verifyProviderReadiness } from './provider-readiness.js';

// Lightweight log stub — database package cannot import @abl/compiler/platform
// (circular dependency). Uses console.warn intentionally.
const log = {
  warn: (msg: string, meta?: Record<string, unknown>) =>
    console.warn(`[kms-provider-pool] ${msg}`, meta ?? ''),
};

// =============================================================================
// TYPES
// =============================================================================

interface PooledProvider {
  provider: KMSProvider;
  fingerprint: string;
  lastUsedAt: number;
  lastHealthCheckAt: number;
}

const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const AUTH_CONFIG_RESOURCE_TYPE = 'kms-provider';
const AUTH_CONFIG_FIELD_NAME = 'authConfigEncrypted';

export interface KMSProviderPoolOptions {
  masterKeyHex: string;
  maxSize?: number;
  idleTimeoutMs?: number;
}

function buildAuthConfigAAD(tenantId?: string): KMSAADContext | undefined {
  if (!tenantId) {
    return undefined;
  }

  return {
    tenantId,
    resourceType: AUTH_CONFIG_RESOURCE_TYPE,
    fieldName: AUTH_CONFIG_FIELD_NAME,
  };
}

// =============================================================================
// FINGERPRINT
// =============================================================================

import { createHash } from 'node:crypto';

/**
 * Compute the cache key for a pooled KMS provider.
 *
 * SECURITY (ABLP-576 review #1): the fingerprint must distinguish providers
 * with different per-tenant credentials. Two tenants pointing at the same
 * underlying CMK / vault / endpoint can have different `authConfigEncrypted`
 * blobs (per-tenant IAM creds, certs, HMAC keys) and the resulting decrypt
 * paths bind tenant-scoped AAD. If the cache key only included the
 * provider-type + keyId, tenant B would reuse tenant A's pooled provider
 * (or the platform pre-warm) and never decrypt against B's auth config.
 *
 * Include `tenantId` and a SHA-256 hash of `authConfigEncrypted` in the key
 * whenever per-tenant credentials are present. Platform-default providers
 * (no `authConfigEncrypted`) keep the original short key.
 */
export function computeFingerprint(
  config: IResolvedProviderRef,
  tenantId: string = 'platform',
): string {
  const authPart = config.authConfigEncrypted
    ? `:tenant:${tenantId}:authcfg:${createHash('sha256')
        .update(config.authConfigEncrypted)
        .digest('hex')
        .slice(0, 16)}`
    : '';
  switch (config.providerType) {
    case 'local':
      return `local:${config.keyId}${authPart}`;
    case 'aws-kms':
      return `aws-kms:${config.region}:${config.keyId}${authPart}`;
    case 'azure-keyvault':
    case 'azure-managed-hsm':
      return `${config.providerType}:${config.vaultUrl}:${config.keyId}${authPart}`;
    case 'gcp-cloud-kms':
      return `gcp-cloud-kms:${config.region}:${config.keyId}${authPart}`;
    case 'external': {
      const authMethod = config.authMethod === 'hmac' ? 'hmac-sha256' : config.authMethod;
      const methodPart = authMethod ? `:${authMethod}` : '';
      return `external:${config.externalEndpoint}${methodPart}${authPart}`;
    }
    default:
      return `${config.providerType}:${config.keyId}${authPart}`;
  }
}

// =============================================================================
// POOL
// =============================================================================

export class KMSProviderPool {
  private providers = new Map<string, PooledProvider>();
  private localProvider: LocalKMSProvider | null = null;
  private readonly masterKeyHex: string;
  private readonly maxSize: number;
  private readonly idleTimeoutMs: number;

  constructor(options: KMSProviderPoolOptions) {
    this.masterKeyHex = options.masterKeyHex;
    this.maxSize = options.maxSize ?? 50;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60 * 1000;
  }

  async initialize(): Promise<void> {
    // Always initialize the local provider (platform-default fallback and auth config decryption)
    this.localProvider = new LocalKMSProvider(this.masterKeyHex);
    await this.localProvider.initialize();

    const fp = 'local:platform-default';
    this.providers.set(fp, {
      provider: this.localProvider,
      fingerprint: fp,
      lastUsedAt: Date.now(),
      lastHealthCheckAt: Date.now(),
    });

    // Pre-warm the platform KMS provider if it's not local (fail-fast on misconfiguration)
    const platformProviderType = process.env.KMS_PROVIDER;
    if (platformProviderType && platformProviderType !== 'local') {
      try {
        const { KMSResolver } = await import('./kms-resolver.js');
        const platformConfig = KMSResolver.getPlatformDefault();
        const provider = await this.createProvider(platformConfig.provider);
        try {
          const readiness = await verifyProviderReadiness(provider, platformConfig.keyId);
          if (!readiness.healthy) {
            throw new Error(`Readiness check failed: ${readiness.message ?? 'unknown'}`);
          }
          const providerFp = computeFingerprint(platformConfig.provider);
          this.providers.set(providerFp, {
            provider,
            fingerprint: providerFp,
            lastUsedAt: Date.now(),
            lastHealthCheckAt: Date.now(),
          });
          log.warn(`Platform KMS provider pre-warmed: ${platformProviderType}`, {
            fingerprint: providerFp,
            latencyMs: readiness.latencyMs,
            cryptoProbeLatencyMs: readiness.cryptoProbeLatencyMs,
          });
        } catch (err) {
          await provider.shutdown().catch((shutdownErr) => {
            log.warn('Failed to shutdown platform provider after pre-warm failure', {
              error: shutdownErr instanceof Error ? shutdownErr.message : String(shutdownErr),
            });
          });
          throw err;
        }
      } catch (err) {
        log.warn(
          `Platform KMS provider (${platformProviderType}) pre-warm failed — will retry on first use`,
          {
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }
  }

  getLocalProvider(): KMSProvider {
    if (!this.localProvider) {
      throw new Error('KMSProviderPool not initialized. Call initialize() first.');
    }
    return this.localProvider;
  }

  async getProvider(config: IResolvedProviderRef, tenantId?: string): Promise<KMSProvider> {
    const fp = computeFingerprint(config, tenantId);

    const existing = this.providers.get(fp);
    if (existing) {
      existing.lastUsedAt = Date.now();

      // Periodic health check for non-local providers
      if (
        existing.provider !== this.localProvider &&
        Date.now() - existing.lastHealthCheckAt > HEALTH_CHECK_INTERVAL_MS
      ) {
        existing.lastHealthCheckAt = Date.now();
        try {
          const readiness = await verifyProviderReadiness(existing.provider, config.keyId);
          if (!readiness.healthy) {
            log.warn('Evicting unhealthy KMS provider', {
              fingerprint: fp,
              message: readiness.message,
            });
            await this.evict(fp);
            // Fall through to create a new provider below
          } else {
            return existing.provider;
          }
        } catch (err) {
          log.warn('Health check failed, evicting provider', {
            fingerprint: fp,
            error: err instanceof Error ? err.message : String(err),
          });
          await this.evict(fp);
          // Fall through to create a new provider below
        }
      } else {
        return existing.provider;
      }
    }

    // Evict LRU if at capacity
    if (this.providers.size >= this.maxSize) {
      this.evictLRU();
    }

    // Create new provider
    const provider = await this.createProvider(config, tenantId);
    if (config.providerType !== 'local') {
      const readiness = await verifyProviderReadiness(provider, config.keyId);
      if (!readiness.healthy) {
        await provider.shutdown().catch((err) => {
          log.warn('Failed to shutdown provider after readiness failure', {
            fingerprint: fp,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        throw new Error(
          `KMS provider readiness check failed for ${fp}: ${readiness.message ?? 'unknown'}`,
        );
      }
    }
    this.providers.set(fp, {
      provider,
      fingerprint: fp,
      lastUsedAt: Date.now(),
      lastHealthCheckAt: Date.now(),
    });

    return provider;
  }

  async evict(fingerprint: string): Promise<void> {
    const entry = this.providers.get(fingerprint);
    if (!entry) return;

    // Never evict the default local provider
    if (entry.provider === this.localProvider) return;

    this.providers.delete(fingerprint);
    await entry.provider.shutdown();
  }

  async shutdown(): Promise<void> {
    const entries = [...this.providers.values()];
    this.providers.clear();
    this.localProvider = null;

    await Promise.allSettled(entries.map((e) => e.provider.shutdown()));
  }

  get size(): number {
    return this.providers.size;
  }

  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.providers) {
      // Never evict the default local provider
      if (entry.provider === this.localProvider) continue;
      if (entry.lastUsedAt < oldestTime) {
        oldestTime = entry.lastUsedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = this.providers.get(oldestKey);
      this.providers.delete(oldestKey);
      entry?.provider.shutdown().catch((err) => {
        log.warn('LRU eviction shutdown failed', {
          fingerprint: oldestKey,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  private async createProvider(
    config: IResolvedProviderRef,
    tenantId?: string,
  ): Promise<KMSProvider> {
    // All "local" variants use LocalKMSProvider with the platform master key
    if (config.providerType === 'local') {
      const provider = new LocalKMSProvider(this.masterKeyHex);
      await provider.initialize();
      return provider;
    }

    // Dynamic import to avoid bundling unused cloud SDKs
    const { createKMSProvider } = await import('./providers/index.js');

    // Resolve auth credentials: env vars for platform default, encrypted blob for per-tenant
    const authConfig = await this.resolveAuthConfig(config, tenantId);
    const externalAuthMethod =
      config.authMethod === 'hmac' ? 'hmac-sha256' : (config.authMethod ?? undefined);

    const provider = await createKMSProvider({
      providerType: config.providerType as any,
      // Common
      keyId: config.keyId,
      region: config.region ?? undefined,
      // Azure Key Vault / Managed HSM
      vaultUrl: config.vaultUrl ?? undefined,
      keyName: config.keyId, // Azure uses keyName, stored as keyId in config
      tenantId: authConfig.tenantId,
      clientId: authConfig.clientId,
      clientSecret: authConfig.clientSecret,
      // AWS KMS
      accessKeyId: authConfig.accessKeyId,
      secretAccessKey: authConfig.secretAccessKey,
      endpoint: authConfig.endpoint,
      // GCP Cloud KMS
      projectId: authConfig.projectId,
      location: config.region ?? undefined,
      keyRing: authConfig.keyRing,
      credentialsPath: authConfig.credentialsPath,
      // External BYOP — per-tenant encrypted blobs use raw key names (apiKey, oauth2ClientId,
      // etc.) while the env-var fallback path uses "external*" prefixed names. Check both.
      externalEndpoint: config.externalEndpoint ?? undefined,
      externalAuthMethod,
      externalApiKey: authConfig.externalApiKey ?? authConfig.apiKey,
      externalOAuth2ClientId: authConfig.externalOAuth2ClientId ?? authConfig.oauth2ClientId,
      externalOAuth2ClientSecret:
        authConfig.externalOAuth2ClientSecret ?? authConfig.oauth2ClientSecret,
      externalOAuth2TokenUrl: authConfig.externalOAuth2TokenUrl ?? authConfig.oauth2TokenUrl,
      externalHmacSecret: authConfig.externalHmacSecret ?? authConfig.hmacSecret,
      externalTlsCert: authConfig.externalTlsCert ?? authConfig.tlsCert,
      externalTlsKey: authConfig.externalTlsKey ?? authConfig.tlsKey,
      externalTlsCa: authConfig.externalTlsCa ?? authConfig.tlsCa,
    });
    await provider.initialize();
    return provider;
  }

  /**
   * Resolve auth credentials for a provider config.
   *
   * For platform default (sourceConfigVersion=0 equivalent, no authConfigEncrypted):
   *   Read from KMS_AZURE_*, KMS_AWS_*, KMS_GCP_* env vars.
   *
   * For per-tenant config (authConfigEncrypted set):
   *   Decrypt the JSON blob using the local provider, then parse credentials.
   *   Note: per-tenant authConfigEncrypted is decrypted with the local/platform key
   *   since it's platform-level config (avoids chicken-and-egg with the tenant's own KMS).
   */
  private async resolveAuthConfig(
    config: IResolvedProviderRef,
    tenantId?: string,
  ): Promise<Record<string, string | undefined>> {
    // Per-tenant encrypted credentials — decrypt with the local provider
    if (config.authConfigEncrypted && this.localProvider) {
      try {
        return await decryptAuthConfig(
          config.authConfigEncrypted,
          this.localProvider,
          'platform-default',
          buildAuthConfigAAD(tenantId),
        );
      } catch (err) {
        // FAIL CLOSED — per-tenant auth config decrypt failure must NOT
        // fall back to platform env var credentials (privilege escalation).
        throw new Error(
          `Failed to decrypt per-tenant authConfigEncrypted for ${config.providerType}: ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            `Per-tenant KMS configs must have valid encrypted credentials.`,
        );
      }
    }

    // Fallback: read from env vars (platform-level config)
    const type = config.providerType;

    if (type === 'azure-keyvault' || type === 'azure-managed-hsm') {
      return {
        tenantId: process.env.KMS_AZURE_TENANT_ID,
        clientId: process.env.KMS_AZURE_CLIENT_ID,
        clientSecret: process.env.KMS_AZURE_CLIENT_SECRET,
      };
    }

    if (type === 'aws-kms') {
      return {
        accessKeyId: process.env.KMS_AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.KMS_AWS_SECRET_ACCESS_KEY,
        endpoint: process.env.KMS_AWS_ENDPOINT,
      };
    }

    if (type === 'gcp-cloud-kms') {
      return {
        projectId: process.env.KMS_GCP_PROJECT_ID,
        keyRing: process.env.KMS_GCP_KEY_RING,
        credentialsPath: process.env.KMS_GCP_CREDENTIALS_PATH,
      };
    }

    if (type === 'external') {
      return {
        externalApiKey: process.env.KMS_EXTERNAL_API_KEY,
      };
    }

    return {};
  }
}
