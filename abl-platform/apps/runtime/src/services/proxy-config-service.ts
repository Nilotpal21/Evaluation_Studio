/**
 * Proxy Config Service
 *
 * Loads organization-level proxy configurations from the database,
 * creates ProxyResolver instances, and caches them with a TTL.
 */

import { ProxyResolver } from '@abl/compiler';
import type { OrgProxyConfigRecord, DecryptFn } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import { resolveAuthProfileCredentials } from './auth-profile-resolver.js';

const log = createLogger('proxy-config-service');

/** Cache entry with TTL */
interface CacheEntry {
  resolver: ProxyResolver;
  expiresAt: number;
}

/** Default cache TTL: 5 minutes */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Pluggable store interface for proxy configs (decoupled from DB for testability).
 */
export interface ProxyConfigStore {
  findConfigs(params: { tenantId: string; environment: string }): Promise<OrgProxyConfigRecord[]>;
}

/**
 * Service that manages loading and caching of ProxyResolver instances per org+env.
 */
export class ProxyConfigService {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private store: ProxyConfigStore,
    private decryptFn: DecryptFn,
  ) {}

  private async resolveRecordSecrets(
    record: OrgProxyConfigRecord,
    tenantId: string,
  ): Promise<OrgProxyConfigRecord> {
    const resolvedRecord = { ...record };
    const fields = [
      ['encryptedProxyUsername', '_resolvedProxyUsername'],
      ['encryptedProxyPassword', '_resolvedProxyPassword'],
      ['encryptedProxyToken', '_resolvedProxyToken'],
      ['encryptedCaCertificate', '_resolvedCaCertificate'],
      ['encryptedClientCert', '_resolvedClientCert'],
      ['encryptedClientKey', '_resolvedClientKey'],
    ] as const;

    for (const [encryptedField, resolvedField] of fields) {
      const encryptedValue = resolvedRecord[encryptedField];
      if (!encryptedValue) continue;
      resolvedRecord[resolvedField] = await this.decryptFn(encryptedValue, tenantId);
    }

    return resolvedRecord;
  }

  /**
   * Get or create a ProxyResolver for an organization + environment.
   * Returns null if no proxy configs exist.
   */
  async getResolver(tenantId: string, environment: string = 'dev'): Promise<ProxyResolver | null> {
    const cacheKey = `${tenantId}:${environment}`;

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.resolver;
    }

    try {
      const records = await this.store.findConfigs({
        tenantId,
        environment,
      });

      if (records.length === 0) {
        // Cache empty result to avoid repeated DB queries
        this.cache.set(cacheKey, {
          resolver: new ProxyResolver([]),
          expiresAt: Date.now() + CACHE_TTL_MS,
        });
        return null;
      }

      // ── Auth Profile dual-read for proxy configs ──
      // When authProfileId is present, pre-resolve credentials
      // from auth profile so the ProxyResolver gets decrypted values.
      const resolvedRecords = await Promise.all(
        records.map(async (record) => {
          const resolvedRecord = await this.resolveRecordSecrets(record, tenantId);
          const rec = resolvedRecord as unknown as Record<string, unknown>;
          if (rec.authProfileId && typeof rec.authProfileId === 'string') {
            try {
              const profile = await resolveAuthProfileCredentials(
                rec.authProfileId as string,
                tenantId,
              );
              if (profile?.secrets) {
                // Inject pre-resolved credentials so ProxyResolver doesn't need to decrypt
                if (profile.secrets.caCertificate && !rec.encryptedCaCertificate) {
                  rec._resolvedCaCertificate = profile.secrets.caCertificate;
                }
                if (profile.secrets.clientCert && !rec.encryptedClientCert) {
                  rec._resolvedClientCert = profile.secrets.clientCert;
                }
                if (profile.secrets.clientKey && !rec.encryptedClientKey) {
                  rec._resolvedClientKey = profile.secrets.clientKey;
                }
              }
            } catch (err) {
              log.warn(
                'Auth profile resolution failed for proxy config, using resolved secrets only',
                {
                  tenantId,
                  authProfileId: rec.authProfileId,
                  error: err instanceof Error ? err.message : String(err),
                },
              );
            }
          }
          return resolvedRecord;
        }),
      );

      const resolver = new ProxyResolver(resolvedRecords);

      this.cache.set(cacheKey, {
        resolver,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });

      log.info('Loaded proxy configs', {
        tenantId,
        environment,
        count: records.length,
      });

      return resolver;
    } catch (error) {
      log.error('Failed to load proxy configs', {
        tenantId,
        environment,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  /** Invalidate cached resolver for an org+env (call after config changes) */
  invalidate(tenantId: string, environment?: string): void {
    if (environment) {
      this.cache.delete(`${tenantId}:${environment}`);
    } else {
      // Invalidate all environments for this org
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${tenantId}:`)) {
          this.cache.delete(key);
        }
      }
    }
  }
}
