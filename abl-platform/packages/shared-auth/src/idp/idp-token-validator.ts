/**
 * IdP Token Validator (Shared)
 *
 * Validates JWT tokens from Azure AD, Okta, Google, or any OIDC provider using JWKS.
 * Implements Redis-backed JWKS caching to avoid repeated external requests.
 *
 * Moved from apps/search-ai-runtime/src/services/idp/ to packages/shared-auth/src/idp/
 * so all services (search-ai-runtime, studio, runtime) can reuse it.
 *
 * Design:
 * - Detects IdP provider from `iss` claim
 * - Fetches JWKS from provider-specific endpoint
 * - Caches signing keys in Redis (1 hour TTL)
 * - Verifies JWT signature, expiration, issuer
 * - Validates audience (clientId) when config provided
 * - Validates email domain restrictions
 * - Extracts email from provider-specific claims
 *
 * Security:
 * - Signature verification using RS256/ES256
 * - Expiration check (`exp` claim)
 * - Issuer validation (`iss` claim)
 * - Audience validation (`aud` claim, when configured)
 * - Domain restriction (email domain allowlist)
 */

// eslint-disable-next-line custom-auth-lint -- Validates external IdP tokens, not platform auth.
import jwt from 'jsonwebtoken';
import jwksClient, { type SigningKey } from 'jwks-rsa';
import type { IdPProvider, UserIdentity, IdPValidationConfig, RedisLike } from './types.js';

const { verify, decode } = jwt;
type JwtPayload = jwt.JwtPayload;

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
const IDP_CONFIGS: Record<Exclude<IdPProvider, 'custom'>, IdPConfig> = {
  azuread: {
    // Match both v2.0 (login.microsoftonline.com/{tid}/v2.0) and
    // v1.0 (sts.windows.net/{tid}/) issuer formats from Azure AD tokens.
    issuerPattern:
      /^https:\/\/(login\.microsoftonline\.com\/[a-zA-Z0-9-]+\/v2\.0|sts\.windows\.net\/[a-zA-Z0-9-]+\/)$/,
    jwksUri: (issuer) => {
      // v2.0: https://login.microsoftonline.com/{tid}/discovery/v2.0/keys
      // v1.0: https://login.microsoftonline.com/{tid}/discovery/keys (extract tid from sts.windows.net)
      if (issuer.includes('sts.windows.net')) {
        const tid = issuer.match(/sts\.windows\.net\/([a-zA-Z0-9-]+)/)?.[1];
        return `https://login.microsoftonline.com/${tid}/discovery/v2.0/keys`;
      }
      const base = issuer.replace(/\/v2\.0$/, '');
      return `${base}/discovery/v2.0/keys`;
    },
    emailClaim: ['email', 'preferred_username', 'upn'],
    nameClaim: ['name'],
    userIdClaim: 'oid',
  },
  okta: {
    issuerPattern: /^https:\/\/[a-zA-Z0-9-]+\.okta\.com(\/oauth2\/[a-zA-Z0-9]+)?$/,
    jwksUri: (issuer) => `${issuer}/v1/keys`,
    emailClaim: ['email', 'preferred_username'],
    nameClaim: ['name'],
    userIdClaim: 'sub',
  },
  google: {
    issuerPattern: /^https:\/\/accounts\.google\.com$/,
    jwksUri: () => 'https://www.googleapis.com/oauth2/v3/certs',
    emailClaim: ['email'],
    nameClaim: ['name'],
    userIdClaim: 'sub',
  },
};

/**
 * JWKS cache TTL: 1 hour (keys rotate infrequently)
 */
const JWKS_CACHE_TTL = 3600;

/**
 * Max JWKS clients cached in memory.
 * Platform invariant: "Every in-memory Map needs max size, TTL, and eviction."
 */
const MAX_JWKS_CLIENTS = 100;

/**
 * Logger interface — allows callers to inject their own logger.
 */
export interface IdPValidatorLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** No-op logger for environments without logging */
const nullLogger: IdPValidatorLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * IdP Token Validator
 *
 * Validates JWT tokens from external identity providers using JWKS.
 */
export class IdPTokenValidator {
  private redis: RedisLike;
  private jwksClients: Map<string, jwksClient.JwksClient>;
  private logger: IdPValidatorLogger;

  constructor(redis: RedisLike, logger?: IdPValidatorLogger) {
    this.redis = redis;
    this.jwksClients = new Map();
    this.logger = logger ?? nullLogger;
  }

  /**
   * Validate IdP token and extract user identity.
   *
   * @param token - JWT token from IdP (Azure AD, Okta, Google, or OIDC)
   * @param tenantId - Tenant ID for cache scoping
   * @param config - Optional validation config (issuer, audience, domain restrictions)
   * @returns Validated user identity
   * @throws Error if token is invalid, expired, or fails validation checks
   */
  async validateToken(
    token: string,
    tenantId: string,
    config?: IdPValidationConfig,
  ): Promise<UserIdentity> {
    // ── Hot-path cache (O3 fix): skip crypto if this token was validated recently ──
    // Uses first 16 + last 16 chars as fingerprint (avoids storing full token in Redis).
    // TTL is bounded to min(token remaining life, 300s) — set after validation.
    const tokenFingerprint =
      token.length > 32 ? `${token.slice(0, 16)}:${token.slice(-16)}` : token;
    const validationCacheKey = `searchai:idp:validated:${tenantId}:${tokenFingerprint}`;

    let cachedResult: string | null = null;
    try {
      cachedResult = await this.redis.get(validationCacheKey);
    } catch (redisErr) {
      this.logger.debug('Redis get failed for validation cache', {
        tenantId,
        error: redisErr instanceof Error ? redisErr.message : String(redisErr),
      });
    }
    if (cachedResult) {
      this.logger.debug('IdP token validation cache hit', { tenantId });
      try {
        return JSON.parse(cachedResult) as UserIdentity;
      } catch (parseErr) {
        this.logger.warn('Corrupted IdP validation cache entry', {
          tenantId,
          error: parseErr instanceof Error ? parseErr.message : String(parseErr),
        });
      }
    }

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
    const providerConfig = provider !== 'custom' ? IDP_CONFIGS[provider] : null;

    // Step 3: Validate issuer against expected value (if configured)
    if (config?.expectedIssuer && issuer !== config.expectedIssuer) {
      throw new Error(
        `Token issuer mismatch: expected "${config.expectedIssuer}", got "${issuer}"`,
      );
    }

    // Step 4: Get signing key (with Redis caching)
    const kid = header.kid;
    if (!kid) {
      throw new Error('Token missing kid in header');
    }

    const signingKey = await this.getSigningKey(provider, issuer, kid, tenantId);

    // Step 5: Verify token signature and claims
    const verifyOptions: jwt.VerifyOptions = {
      algorithms: ['RS256', 'ES256'],
      issuer,
    };

    // Validate audience if configured
    if (config?.expectedAudience) {
      verifyOptions.audience = config.expectedAudience;
    }

    let verified: JwtPayload;
    try {
      verified = verify(token, signingKey, verifyOptions) as JwtPayload;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('audience')) {
        throw new Error(`Token audience mismatch: expected "${config?.expectedAudience}"`);
      }
      throw err;
    }

    // Step 6: Extract email from provider-specific claims (or standard claims for custom)
    const emailClaims = providerConfig?.emailClaim ?? ['email', 'preferred_username', 'upn'];
    const email = this.extractClaim(verified, emailClaims);
    if (!email) {
      throw new Error(`Token missing email claim. Checked: ${emailClaims.join(', ')}`);
    }

    // Step 7: Extract domain and validate against allowed domains
    const domain = email.split('@')[1];
    if (!domain) {
      throw new Error(`Invalid email format: ${email}`);
    }

    if (config?.allowedDomains && config.allowedDomains.length > 0) {
      const normalizedDomain = domain.toLowerCase();
      const allowed = config.allowedDomains.some((d) => d.toLowerCase() === normalizedDomain);
      if (!allowed) {
        throw new Error(
          `Email domain "${normalizedDomain}" not in allowed domains: [${config.allowedDomains.join(', ')}]`,
        );
      }
    }

    // Step 8: Extract user ID
    const userIdClaim = providerConfig?.userIdClaim ?? 'sub';
    const idpUserId = verified[userIdClaim] as string;
    if (!idpUserId) {
      throw new Error(`Token missing user ID claim: ${userIdClaim}`);
    }

    // Step 9: Extract optional name
    const nameClaims = providerConfig?.nameClaim ?? ['name'];
    const name = this.extractClaim(verified, nameClaims) ?? undefined;

    // Step 10: Extract group claims from JWT (Tier 1 of 3-tier resolution)
    let groups: string[] | undefined;
    const hasGroups = verified.hasgroups || verified._claim_names?.groups;
    if (!hasGroups && Array.isArray(verified.groups)) {
      groups = (verified.groups as string[]).map((g) => `${provider}:${g}`);
      this.logger.debug('Extracted groups from JWT claim', {
        provider,
        email,
        groupCount: groups.length,
      });
    }

    this.logger.info('IdP token validated', {
      provider,
      email: email.toLowerCase(),
      domain: domain.toLowerCase(),
      tenantId,
      jwtGroupCount: groups?.length ?? 0,
    });

    const result: UserIdentity = {
      email: email.toLowerCase(),
      name,
      idpUserId,
      idpProvider: provider,
      domain: domain.toLowerCase(),
      groups,
    };

    // ── Hot-path cache WRITE (O3 fix): store validated result to skip crypto on repeat calls ──
    // TTL is bounded to min(token remaining lifetime, 300s) to avoid stale cache beyond expiry.
    const exp = (payload as JwtPayload).exp;
    const now = Math.floor(Date.now() / 1000);
    const remainingLife = exp ? exp - now : 300;
    const cacheTtl = Math.min(Math.max(remainingLife, 10), 300);

    // Fire-and-forget cache write — intentional best-effort, don't block auth response.
    // Promise rejection handled via .catch() to prevent unhandled rejection.
    this.redis.set(validationCacheKey, JSON.stringify(result), cacheTtl).catch((cacheWriteErr) => {
      this.logger.warn('Failed to cache IdP validation result', {
        tenantId,
        error: cacheWriteErr instanceof Error ? cacheWriteErr.message : String(cacheWriteErr),
      });
    });

    return result;
  }

  /**
   * Detect IdP provider from issuer claim.
   */
  private detectProvider(issuer: string): IdPProvider {
    for (const [provider, config] of Object.entries(IDP_CONFIGS)) {
      if (config.issuerPattern.test(issuer)) {
        return provider as IdPProvider;
      }
    }
    return 'custom';
  }

  /**
   * Get signing key for token verification (with Redis caching).
   */
  private async getSigningKey(
    provider: IdPProvider,
    issuer: string,
    kid: string,
    tenantId: string,
  ): Promise<string> {
    const cacheKey = `searchai:jwks:${tenantId}:${issuer}:${kid}`;

    // Try Redis cache first
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      this.logger.debug('JWKS cache hit', { provider, kid, tenantId });
      return cached;
    }

    this.logger.debug('JWKS cache miss, fetching from IdP', { provider, kid, tenantId });

    // Determine JWKS URI
    const jwksUri = this.resolveJwksUri(provider, issuer);

    // Get or create JWKS client (with max size eviction)
    let client = this.jwksClients.get(jwksUri);
    if (!client) {
      if (this.jwksClients.size >= MAX_JWKS_CLIENTS) {
        const oldestKey = this.jwksClients.keys().next().value;
        if (oldestKey !== undefined) {
          this.jwksClients.delete(oldestKey);
          this.logger.debug('Evicted oldest JWKS client', { evictedUri: oldestKey });
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
    await this.redis.set(cacheKey, publicKey, JWKS_CACHE_TTL);

    return publicKey;
  }

  /**
   * Resolve JWKS URI for a given provider + issuer.
   */
  private resolveJwksUri(provider: IdPProvider, issuer: string): string {
    if (provider !== 'custom') {
      return IDP_CONFIGS[provider].jwksUri(issuer);
    }
    // For custom OIDC providers, derive JWKS URI from issuer
    // Standard: {issuer}/.well-known/openid-configuration → jwks_uri
    // Fallback: {issuer}/.well-known/jwks.json
    return `${issuer.replace(/\/$/, '')}/.well-known/jwks.json`;
  }

  /**
   * Extract claim from payload (tries multiple claim names).
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
   * Invalidate JWKS cache for a tenant (admin API).
   */
  async invalidateJWKSCache(tenantId: string): Promise<void> {
    const pattern = `searchai:jwks:${tenantId}:*`;
    const keys = await this.redis.scanByPattern(pattern);

    if (keys.length > 0) {
      // Delete keys individually (cluster-safe — keys may hash to different slots)
      await Promise.all(keys.map((k) => this.redis.del(k)));
      this.logger.info('JWKS cache invalidated', { tenantId, keysDeleted: keys.length });
    }
  }
}
