/**
 * Proxy Resolver
 *
 * Resolves outbound HTTP tool URLs to organization-level proxy configurations.
 * Supports URL pattern matching, priority ordering, auth injection (basic, bearer, api_key),
 * custom CA certificates, and mTLS client certificates.
 *
 * SECURITY:
 * - Proxy URLs themselves are validated for SSRF before use
 * - Proxy credentials are decrypted on load and never logged
 * - Bypass patterns allow skipping proxy for specific targets
 */

import { assertUrlSafeForSSRF } from '@agent-platform/shared-kernel/security';
import { createLogger } from '../../logger.js';

const log = createLogger('proxy-resolver');

// =============================================================================
// TYPES
// =============================================================================

export interface ProxyConfig {
  /** The proxy URL (http(s)://proxy.corp.com:8080) */
  proxyUrl: string;
  /** Authentication type */
  authType: 'none' | 'basic' | 'bearer' | 'api_key';
  /** For basic auth */
  username?: string;
  /** For basic auth */
  password?: string;
  /** For bearer or api_key auth */
  token?: string;
  /** PEM-encoded custom CA certificate */
  caCertificate?: string;
  /** PEM-encoded client certificate for mTLS */
  clientCert?: string;
  /** PEM-encoded client private key for mTLS */
  clientKey?: string;
}

export interface OrgProxyConfigRecord {
  id: string;
  tenantId: string;
  name: string;
  proxyUrl: string;
  proxyAuthType: string;
  encryptedProxyUsername?: string | null;
  encryptedProxyPassword?: string | null;
  encryptedProxyToken?: string | null;
  encryptedCaCertificate?: string | null;
  encryptedClientCert?: string | null;
  encryptedClientKey?: string | null;
  urlPatterns: string;
  bypassPatterns?: string | null;
  environment: string;
  priority: number;
  enabled: boolean;
  _resolvedProxyUsername?: string;
  _resolvedProxyPassword?: string;
  _resolvedProxyToken?: string;
  _resolvedCaCertificate?: string;
  _resolvedClientCert?: string;
  _resolvedClientKey?: string;
}

export type DecryptFn = (encrypted: string, tenantId: string) => Promise<string>;

// =============================================================================
// PATTERN MATCHING
// =============================================================================

/**
 * Convert a glob pattern to a RegExp.
 * Supports: `*` (any chars within segment), `**` (unused, same as *), `?` (single char).
 * Patterns are anchored to match the full string.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars (except * and ?)
    .replace(/\*/g, '.*') // * → match anything
    .replace(/\?/g, '.'); // ? → match single char
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Test if a URL matches a comma-separated pattern list.
 * Patterns are matched against the hostname of the URL.
 * Special case: "*" matches everything.
 */
function matchesPatterns(url: string, patterns: string): boolean {
  const patternList = patterns
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (patternList.length === 0) return false;

  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }

  for (const pattern of patternList) {
    if (pattern === '*') return true;
    const regex = globToRegex(pattern.toLowerCase());
    if (regex.test(hostname)) return true;
  }

  return false;
}

// =============================================================================
// PROXY RESOLVER
// =============================================================================

interface ResolvedConfig {
  record: OrgProxyConfigRecord;
  proxy: ProxyConfig;
}

export class ProxyResolver {
  private configs: ResolvedConfig[];

  /**
   * Create a ProxyResolver with pre-resolved proxy configurations.
   * @param records - Org proxy configs from DB (ordered by priority desc)
   */
  constructor(records: OrgProxyConfigRecord[]) {
    this.configs = [];

    // Filter enabled, sort by priority descending (highest first)
    const sorted = [...records].filter((r) => r.enabled).sort((a, b) => b.priority - a.priority);

    for (const record of sorted) {
      try {
        // Validate proxy URL for SSRF (don't allow proxy to private IP)
        assertUrlSafeForSSRF(record.proxyUrl);

        const proxy: ProxyConfig = {
          proxyUrl: record.proxyUrl,
          authType: record.proxyAuthType as ProxyConfig['authType'],
        };

        proxy.username = record._resolvedProxyUsername;
        proxy.password = record._resolvedProxyPassword;
        proxy.token = record._resolvedProxyToken;
        proxy.caCertificate = record._resolvedCaCertificate;
        proxy.clientCert = record._resolvedClientCert;
        proxy.clientKey = record._resolvedClientKey;

        this.configs.push({ record, proxy });
      } catch (error) {
        log.error('Skipping invalid proxy config — tools may bypass proxy policy', {
          name: record.name,
          proxyUrl: record.proxyUrl,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  /**
   * Validate a proxy URL at write time (e.g., when admin creates/updates config).
   * Call this from the admin API before persisting to the database.
   * Throws descriptive error if the proxy URL is invalid or targets private IPs.
   */
  static validateProxyUrl(proxyUrl: string): void {
    if (!proxyUrl || typeof proxyUrl !== 'string') {
      throw new Error('Proxy URL is required');
    }
    let parsed: URL;
    try {
      parsed = new URL(proxyUrl);
    } catch {
      throw new Error(`Invalid proxy URL: ${proxyUrl}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Proxy URL must use http or https scheme, got: ${parsed.protocol}`);
    }
    assertUrlSafeForSSRF(proxyUrl);
  }

  /**
   * Resolve the proxy config for a target URL.
   * Returns the highest-priority matching config, or null if no proxy should be used.
   */
  resolve(targetUrl: string): ProxyConfig | null {
    for (const { record, proxy } of this.configs) {
      // Check bypass patterns first — if URL matches bypass, skip this config
      if (record.bypassPatterns && matchesPatterns(targetUrl, record.bypassPatterns)) {
        continue;
      }

      // Check URL patterns — must match to use this proxy
      if (matchesPatterns(targetUrl, record.urlPatterns)) {
        return proxy;
      }
    }

    return null;
  }

  /**
   * Apply proxy authentication headers to a fetch options object.
   * Modifies headers in place. Instance method for use when only the resolver instance is available.
   */
  applyProxyAuth(proxyConfig: ProxyConfig, headers: Record<string, string>): void {
    ProxyResolver.applyProxyAuth(proxyConfig, headers);
  }

  /**
   * Apply proxy authentication headers (static implementation).
   * Modifies headers in place.
   */
  static applyProxyAuth(proxyConfig: ProxyConfig, headers: Record<string, string>): void {
    switch (proxyConfig.authType) {
      case 'basic': {
        if (proxyConfig.username && proxyConfig.password) {
          const credentials = Buffer.from(
            `${proxyConfig.username}:${proxyConfig.password}`,
          ).toString('base64');
          headers['Proxy-Authorization'] = `Basic ${credentials}`;
        }
        break;
      }
      case 'bearer': {
        if (proxyConfig.token) {
          headers['Proxy-Authorization'] = `Bearer ${proxyConfig.token}`;
        }
        break;
      }
      case 'api_key': {
        if (proxyConfig.token) {
          headers['Proxy-Authorization'] = proxyConfig.token;
        }
        break;
      }
      case 'none':
      default:
        break;
    }
  }

  /** Check if any proxy configs are loaded */
  get hasConfigs(): boolean {
    return this.configs.length > 0;
  }
}
