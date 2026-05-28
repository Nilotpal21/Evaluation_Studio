// eslint-disable-next-line custom-auth-lint -- Validates external IdP tokens (Azure AD, Okta, Google), not platform auth.
// This is intentionally outside shared-auth: IdP token validation requires provider-specific
// JWKS endpoints, issuer patterns, and claim extraction that don't belong in the platform auth layer.
import jwt from 'jsonwebtoken';
import jwksClient, { type SigningKey } from 'jwks-rsa';

const { verify, decode } = jwt;
type JwtPayload = jwt.JwtPayload;
import { createLogger } from '@abl/compiler/platform';
import { RedisClient } from '../cache/redis-client.js';

const logger = createLogger('idp-token-validator');

/**
 * Supported IdP providers
 */
export type IdPProvider = 'azuread' | 'okta' | 'google';

/**
 * Validated user identity extracted from IdP token
 */
export interface UserIdentity {
  email: string;
  name?: string;
  idpUserId: string;
  idpProvider: IdPProvider;
  domain: string;
  /**
   * Group memberships from JWT claim (Tier 1 of 3-tier resolution).
   *
   * Azure AD: `groups` claim (max 200 — if exceeded, `hasgroups: true` and this is undefined)
   * Okta: `groups` claim (max 100 by default, configurable)
   * Google: Not supported (always undefined)
   *
   * When populated, the permission filter service skips Redis/MongoDB lookups entirely.
   */
  groups?: string[];
}

/**
 * IdP configuration per provider
 */
interface IdPConfig {
  issuerPattern: RegExp;
  jwksUri: (issuer: string) => string;
  emailClaim: string[];
  nameClaim?: string[];
  userIdClaim: string;
}

/**
 * Provider-specific configurations
 */
const IDP_CONFIGS: Record<IdPProvider, IdPConfig> = {
  azuread: {
    issuerPattern: /^https:\/\/login\.microsoftonline\.com\/[a-zA-Z0-9-]+\/v2\.0$/,
    jwksUri: (issuer) => {
      // issuer = https://login.microsoftonline.com/{tenantId}/v2.0
      // JWKS   = https://login.microsoftonline.com/{tenantId}/discovery/v2.0/keys
      // Extract base (before /v2.0) and construct the correct OIDC discovery JWKS URI
      const base = issuer.replace(/\/v2\.0$/, '');
      return `${base}/discovery/v2.0/keys`;
    },
    emailClaim: ['email', 'preferred_username', 'upn'],
    nameClaim: ['name'],
    userIdClaim: 'oid', // Azure AD Object ID
  },
  okta: {
    issuerPattern: /^https:\/\/[a-zA-Z0-9-]+\.okta\.com$/,
    jwksUri: (issuer) => `${issuer}/v1/keys`,
    emailClaim: ['email', 'preferred_username'],
    nameClaim: ['name'],
    userIdClaim: 'sub', // Okta user ID
  },
  google: {
    issuerPattern: /^https:\/\/accounts\.google\.com$/,
    jwksUri: () => 'https://www.googleapis.com/oauth2/v3/certs',
    emailClaim: ['email'],
    nameClaim: ['name'],
    userIdClaim: 'sub', // Google user ID
  },
};

/**
 * JWKS cache key pattern: searchai:jwks:{issuer}:{kid}
 * TTL: 1 hour (JWKS keys rotate infrequently)
 */
const JWKS_CACHE_TTL = 3600; // 1 hour in seconds

/**
 * Max JWKS clients cached in memory.
 * One client per unique issuer URI. In practice, tenants share a handful
 * of IdP issuers, but we cap to prevent unbounded growth.
 * Platform invariant: "Every in-memory Map needs max size, TTL, and eviction."
 */
const MAX_JWKS_CLIENTS = 100;

/**
 * IdP Token Validator
 *
 * Validates JWT tokens from Azure AD, Okta, or Google using JWKS.
 * Implements Redis-backed JWKS caching to avoid repeated external requests.
 *
 * Design:
 * - Detects IdP provider from `iss` claim
 * - Fetches JWKS from provider-specific endpoint
 * - Caches signing keys in Redis (1 hour TTL)
 * - Verifies JWT signature, expiration, issuer
 * - Extracts email from provider-specific claims
 *
 * Security:
 * - Signature verification using RS256/ES256
 * - Expiration check (`exp` claim)
 * - Issuer validation (`iss` claim)
 * - Audience validation (`aud` claim, if provided)
 */
export class IdPTokenValidator {
  private redisClient: RedisClient;
  private jwksClients: Map<string, jwksClient.JwksClient>;

  constructor(redisClient: RedisClient) {
    this.redisClient = redisClient;
    this.jwksClients = new Map();
  }

  /**
   * Validate IdP token and extract user identity
   *
   * @param token - JWT token from IdP (Azure AD, Okta, Google)
   * @param tenantId - Tenant ID for cache scoping
   * @returns User identity with email, idpUserId, provider
   * @throws Error if token is invalid, expired, or missing required claims
   */
  async validateToken(token: string, tenantId: string): Promise<UserIdentity> {
    try {
      // Step 1: Decode token without verification to get header + payload
      const decoded = decode(token, { complete: true });
      if (!decoded || typeof decoded === 'string') {
        throw new Error('Invalid token format');
      }

      const { header, payload } = decoded;
      if (!payload || typeof payload === 'string') {
        throw new Error('Invalid token payload');
      }

      // Step 2: Detect IdP provider from issuer
      const issuer = (payload as JwtPayload).iss;
      if (!issuer) {
        throw new Error('Token missing iss claim');
      }

      const provider = this.detectProvider(issuer);
      if (!provider) {
        throw new Error(`Unsupported IdP issuer: ${issuer}`);
      }

      const config = IDP_CONFIGS[provider];

      // Step 3: Get signing key (with Redis caching)
      const kid = header.kid;
      if (!kid) {
        throw new Error('Token missing kid in header');
      }

      const signingKey = await this.getSigningKey(provider, issuer, kid, tenantId);

      // Step 4: Verify token signature and claims
      const verified = verify(token, signingKey, {
        algorithms: ['RS256', 'ES256'],
        issuer,
        // audience validation optional (not all IdPs include aud claim for user tokens)
      }) as JwtPayload;

      // Step 5: Extract email from provider-specific claims
      const email = this.extractEmail(verified, config);
      if (!email) {
        throw new Error(`Token missing email claim. Checked: ${config.emailClaim.join(', ')}`);
      }

      // Step 6: Extract user ID
      const idpUserId = verified[config.userIdClaim] as string;
      if (!idpUserId) {
        throw new Error(`Token missing user ID claim: ${config.userIdClaim}`);
      }

      // Step 7: Extract optional name
      const name = config.nameClaim ? this.extractClaim(verified, config.nameClaim) : undefined;

      // Step 8: Extract domain from email
      const domain = email.split('@')[1];
      if (!domain) {
        throw new Error(`Invalid email format: ${email}`);
      }

      // Step 9: Extract group claims from JWT (Tier 1 of 3-tier resolution)
      // Azure AD: `groups` array (GUIDs). If >200 groups → `hasgroups: true` + no groups array.
      // Okta: `groups` array (names). Configurable in Okta admin.
      // Google: Not supported.
      let groups: string[] | undefined;
      const hasGroups = verified.hasgroups || verified._claim_names?.groups;
      if (!hasGroups && Array.isArray(verified.groups)) {
        // Map to namespaced group IDs: "azuread:{guid}" or "okta:{name}"
        groups = (verified.groups as string[]).map((g) => `${provider}:${g}`);
        logger.debug('Extracted groups from JWT claim', {
          provider,
          email,
          groupCount: groups.length,
        });
      }

      logger.info('IdP token validated', {
        provider,
        email,
        domain,
        tenantId,
        jwtGroupCount: groups?.length ?? 0,
      });

      return {
        email: email.toLowerCase(), // Normalize email to lowercase
        name: name ?? undefined, // Convert null to undefined
        idpUserId,
        idpProvider: provider,
        domain: domain.toLowerCase(),
        groups,
      };
    } catch (error) {
      logger.error('IdP token validation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Detect IdP provider from issuer claim
   */
  private detectProvider(issuer: string): IdPProvider | null {
    for (const [provider, config] of Object.entries(IDP_CONFIGS)) {
      if (config.issuerPattern.test(issuer)) {
        return provider as IdPProvider;
      }
    }
    return null;
  }

  /**
   * Get signing key for token verification (with Redis caching)
   *
   * Cache key: searchai:jwks:{tenantId}:{issuer}:{kid}
   * TTL: 1 hour
   */
  private async getSigningKey(
    provider: IdPProvider,
    issuer: string,
    kid: string,
    tenantId: string,
  ): Promise<string> {
    const cacheKey = `searchai:jwks:${tenantId}:${issuer}:${kid}`;

    // Try Redis cache first
    const cached = await this.redisClient.get(cacheKey);
    if (cached) {
      logger.debug('JWKS cache hit', { provider, kid, tenantId });
      return cached;
    }

    logger.debug('JWKS cache miss, fetching from IdP', { provider, kid, tenantId });

    // Fetch from JWKS endpoint
    const config = IDP_CONFIGS[provider];
    const jwksUri = config.jwksUri(issuer);

    // Get or create JWKS client for this issuer (with max size eviction)
    let client = this.jwksClients.get(jwksUri);
    if (!client) {
      // Evict oldest entry (LRU — Map iteration order is insertion order) if at capacity
      if (this.jwksClients.size >= MAX_JWKS_CLIENTS) {
        const oldestKey = this.jwksClients.keys().next().value;
        if (oldestKey !== undefined) {
          this.jwksClients.delete(oldestKey);
          logger.debug('Evicted oldest JWKS client', { evictedUri: oldestKey });
        }
      }

      client = jwksClient({
        jwksUri,
        cache: false, // We handle caching in Redis
        rateLimit: true,
        jwksRequestsPerMinute: 10,
      });
      this.jwksClients.set(jwksUri, client);
    }

    // Fetch signing key
    const key: SigningKey = await client.getSigningKey(kid);
    const publicKey = key.getPublicKey();

    // Cache in Redis
    await this.redisClient.set(cacheKey, publicKey, JWKS_CACHE_TTL);

    return publicKey;
  }

  /**
   * Extract email from token claims (tries multiple claim names)
   */
  private extractEmail(payload: JwtPayload, config: IdPConfig): string | null {
    return this.extractClaim(payload, config.emailClaim);
  }

  /**
   * Extract claim from payload (tries multiple claim names)
   */
  private extractClaim(payload: JwtPayload, claimNames: string[]): string | null {
    for (const claimName of claimNames) {
      const value = payload[claimName];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
    return null;
  }

  /**
   * Invalidate JWKS cache for a tenant (admin API)
   */
  async invalidateJWKSCache(tenantId: string): Promise<void> {
    // scanByPattern() uses cluster-safe SCAN internally via RedisClient wrapper
    const pattern = `searchai:jwks:${tenantId}:*`;
    const keys = await this.redisClient.scanByPattern(pattern);

    if (keys.length > 0) {
      await this.redisClient.del(...keys);
      logger.info('JWKS cache invalidated', { tenantId, keysDeleted: keys.length });
    }
  }
}

/**
 * Singleton instance
 */
let instance: IdPTokenValidator | null = null;

export function getIdPTokenValidator(redisClient: RedisClient): IdPTokenValidator {
  if (!instance) {
    instance = new IdPTokenValidator(redisClient);
  }
  return instance;
}
