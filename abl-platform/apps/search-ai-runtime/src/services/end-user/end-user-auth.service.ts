/**
 * End-User Auth Service
 *
 * Business logic for authenticating end-users via IdP tokens,
 * issuing search session tokens, and resolving/creating Contact cards.
 *
 * Orchestrates:
 * - SearchIndex lookup (indexId → tenantId, projectId)
 * - ProjectSettings lookup (publicApiAccess configuration)
 * - AuthProfile lookup (OIDC config: issuer, clientId)
 * - IdP token validation (via shared-auth IdPTokenValidator)
 * - Contact resolution/creation (platform invariant: identityTier ≥ 2)
 * - Search session token issuance
 */

import { createLogger } from '@abl/compiler/platform';
// eslint-disable-next-line custom-auth-lint -- decode() used for issuer pre-match routing, not auth verification
import jwt from 'jsonwebtoken';
import {
  IdPTokenValidator,
  issueSearchSessionToken,
  verifySearchSessionToken,
} from '@agent-platform/shared-auth/idp';
import type {
  UserIdentity,
  RedisLike,
  SearchSessionTokenPayload,
  IdPValidationConfig,
} from '@agent-platform/shared-auth/idp';
import type {
  ISearchIndex,
  IProjectSettings,
  IAuthProfile,
  IContact,
} from '@agent-platform/database/models';
import type { IPublicApiAccessScopeConfig } from '@agent-platform/database/models';
import { getLazyModel } from '../../db/index.js';
import { getGlobalRedisClient, RedisClient } from '../cache/redis-client.js';
import { getConfig } from '../../config/index.js';

const logger = createLogger('end-user-auth-service');

const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
const ProjectSettings = getLazyModel<IProjectSettings>('ProjectSettings');
const AuthProfile = getLazyModel<IAuthProfile>('AuthProfile');
const Contact = getLazyModel<IContact>('Contact');

// ─── Types ──────────────────────────────────────────────────────────────

export interface EndUserAuthResult {
  sessionToken: string;
  expiresIn: number;
  user: {
    email: string;
    domain: string;
    contactId?: string;
  };
}

export interface EndUserIdentityResult {
  tenantId: string;
  projectId: string;
  userIdentity: UserIdentity;
  contactId?: string;
  rateLimits?: {
    perUserPerMinute: number;
    perProjectPerMinute: number;
  };
}

// ─── Redis Adapter ──────────────────────────────────────────────────────

class RedisClientAdapter implements RedisLike {
  constructor(private client: RedisClient) {}

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttl: number): Promise<void> {
    await this.client.set(key, value, ttl);
  }

  async del(...keys: string[]): Promise<void> {
    await this.client.del(...keys);
  }

  async scanByPattern(pattern: string): Promise<string[]> {
    return this.client.scanByPattern(pattern);
  }
}

// ─── Service ────────────────────────────────────────────────────────────

export class EndUserAuthService {
  private idpValidator: IdPTokenValidator;

  constructor() {
    const redisClient = getGlobalRedisClient();
    const adapter = new RedisClientAdapter(redisClient);
    this.idpValidator = new IdPTokenValidator(adapter, {
      debug: (msg, meta) => logger.debug(msg, meta ?? {}),
      info: (msg, meta) => logger.info(msg, meta ?? {}),
      warn: (msg, meta) => logger.warn(msg, meta ?? {}),
      error: (msg, meta) => logger.error(msg, meta ?? {}),
    });
  }

  /**
   * Authenticate end-user and issue search session token (Path A: /auth/token).
   *
   * Flow:
   * 1. indexId → SearchIndex → tenantId, projectId
   * 2. ProjectSettings.publicApiAccess.scopes['search.query'].enabled?
   * 3. Load auth profile → OIDC config
   * 4. Validate IdP token
   * 5. Create/resolve Contact card
   * 6. Issue search session token
   */
  async authenticateAndIssueToken(params: {
    idpToken: string;
    indexId: string;
  }): Promise<EndUserAuthResult> {
    const { idpToken, indexId } = params;

    // Step 1: Resolve index → tenant + project
    const { tenantId, projectId } = await this.resolveIndexContext(indexId);

    // Step 2: Load and validate public API access config
    const scopeConfig = await this.getSearchQueryScopeConfig(tenantId, projectId);

    // Step 3: Load auth profile(s) for OIDC config (multi-IdP issuer pre-match)
    const validationConfig = await this.buildValidationConfig(tenantId, scopeConfig, idpToken);

    // Step 4: Validate IdP token
    const userIdentity = await this.idpValidator.validateToken(
      idpToken,
      tenantId,
      validationConfig,
    );

    // Step 5: Create/resolve Contact card (platform invariant: identityTier ≥ 2)
    const contactId = await this.resolveOrCreateContact(tenantId, userIdentity);

    // Step 6: Issue search session token
    const ttlSeconds = scopeConfig.sessionTokenTtlSeconds || 900;
    const jwtSecret = getConfig().jwt.secret;

    const sessionToken = issueSearchSessionToken(
      {
        email: userIdentity.email,
        tenantId,
        projectId,
        domain: userIdentity.domain,
        // groups intentionally omitted — resolved per-query via 3-tier resolver
        // to avoid JWT bloat for enterprise users with 200+ group memberships (O1)
        contactId,
        idpProvider: userIdentity.idpProvider,
        ttlSeconds,
      },
      jwtSecret,
    );

    logger.info('End-user session token issued', {
      tenantId,
      projectId,
      email: userIdentity.email,
      provider: userIdentity.idpProvider,
      ttlSeconds,
    });

    return {
      sessionToken,
      expiresIn: ttlSeconds,
      user: {
        email: userIdentity.email,
        domain: userIdentity.domain,
        contactId,
      },
    };
  }

  /**
   * Resolve end-user identity for /query endpoint (Paths C).
   *
   * Handles two sub-paths:
   * - X-Search-Session-Token: validate local JWT (no IdP round-trip)
   * - X-End-User-Token: validate raw IdP token (full validation)
   */
  async resolveEndUserIdentity(params: {
    indexId: string;
    sessionToken?: string;
    idpToken?: string;
  }): Promise<EndUserIdentityResult> {
    const { indexId, sessionToken, idpToken } = params;

    // Step 1: Resolve index → tenant + project
    const { tenantId, projectId } = await this.resolveIndexContext(indexId);

    // Step 2: Validate public API access enabled
    const scopeConfig = await this.getSearchQueryScopeConfig(tenantId, projectId);

    const rateLimits = scopeConfig.rateLimits;

    // Path: Session token (pre-authenticated)
    if (sessionToken) {
      const result = await this.resolveFromSessionToken(sessionToken, tenantId, projectId, indexId);
      return { ...result, rateLimits };
    }

    // Path: Raw IdP token (per-request validation)
    if (idpToken) {
      const result = await this.resolveFromIdpToken(idpToken, tenantId, projectId, scopeConfig);
      return { ...result, rateLimits };
    }

    throw new Error('No authentication token provided');
  }

  // ─── Private Methods ──────────────────────────────────────────────────

  private async resolveFromSessionToken(
    token: string,
    tenantId: string,
    projectId: string,
    indexId: string,
  ): Promise<EndUserIdentityResult> {
    const jwtSecret = getConfig().jwt.secret;
    const payload: SearchSessionTokenPayload = verifySearchSessionToken(token, jwtSecret);

    // Verify token is for the correct tenant and project
    if (payload.tenantId !== tenantId) {
      throw new Error('Session token tenant mismatch');
    }
    if (payload.projectId !== projectId) {
      throw new Error(
        `Session token project mismatch: token is for project "${payload.projectId}", but index "${indexId}" belongs to project "${projectId}"`,
      );
    }

    return {
      tenantId,
      projectId,
      userIdentity: {
        email: payload.sub,
        idpUserId: payload.sub,
        idpProvider: payload.idpProvider as any,
        domain: payload.domain,
        groups: payload.groups,
      },
      contactId: payload.contactId,
    };
  }

  private async resolveFromIdpToken(
    idpToken: string,
    tenantId: string,
    projectId: string,
    scopeConfig: IPublicApiAccessScopeConfig,
  ): Promise<EndUserIdentityResult> {
    // Load auth profile(s) for OIDC validation config (multi-IdP issuer pre-match)
    const validationConfig = await this.buildValidationConfig(tenantId, scopeConfig, idpToken);

    // Validate IdP token
    const userIdentity = await this.idpValidator.validateToken(
      idpToken,
      tenantId,
      validationConfig,
    );

    // Create/resolve Contact card
    const contactId = await this.resolveOrCreateContact(tenantId, userIdentity);

    return {
      tenantId,
      projectId,
      userIdentity,
      contactId,
    };
  }

  /**
   * Resolve indexId → tenantId + projectId via SearchIndex lookup.
   */
  private async resolveIndexContext(indexId: string): Promise<{
    tenantId: string;
    projectId: string;
  }> {
    const index = await SearchIndex.findOne({ _id: indexId }).lean();
    if (!index) {
      throw new EndUserAuthError('INDEX_NOT_FOUND', `Index "${indexId}" not found`, 404);
    }
    return { tenantId: index.tenantId, projectId: index.projectId };
  }

  /**
   * Load and validate the search.query scope config from ProjectSettings.
   */
  private async getSearchQueryScopeConfig(
    tenantId: string,
    projectId: string,
  ): Promise<IPublicApiAccessScopeConfig> {
    const settings = await ProjectSettings.findOne({ tenantId, projectId }).lean();

    const scopeConfig = settings?.publicApiAccess?.scopes?.['search.query'];
    if (!scopeConfig?.enabled) {
      throw new EndUserAuthError(
        'END_USER_ACCESS_DISABLED',
        'End-user search access is not enabled for this project',
        403,
      );
    }

    return scopeConfig;
  }

  /**
   * Build IdP validation config from auth profiles using issuer pre-match.
   *
   * Multi-IdP strategy (V2):
   * 1. jwt.decode(token) — NO crypto, ~0.1ms — read iss + aud
   * 2. Load all configured profiles (batch query, cached 60s in Redis)
   * 3. Match profile by issuer (+ audience disambiguation)
   * 4. Return matched profile's validation config
   *
   * Backward compat: if authProfileIds is empty, returns config without
   * issuer/audience enforcement (JWKS-only, same as V1).
   */
  private async buildValidationConfig(
    tenantId: string,
    scopeConfig: IPublicApiAccessScopeConfig,
    idpToken?: string,
  ): Promise<IdPValidationConfig> {
    const profileIds = scopeConfig.authProfileIds ?? [];

    // Backward compat: no profiles configured → JWKS-only validation
    if (profileIds.length === 0) {
      return {
        allowedDomains: scopeConfig.allowedDomains,
      };
    }

    // Single profile shortcut: still need to read token issuer for v1/v2 disambiguation
    if (profileIds.length === 1) {
      if (idpToken) {
        const { iss: tokenIssuer } = this.decodeTokenIssuer(idpToken);
        return this.buildConfigFromProfile(
          tenantId,
          profileIds[0],
          scopeConfig.allowedDomains,
          tokenIssuer,
        );
      }
      return this.buildConfigFromProfile(tenantId, profileIds[0], scopeConfig.allowedDomains);
    }

    // Multi-IdP: decode token to read issuer for pre-match
    if (!idpToken) {
      throw new EndUserAuthError(
        'MISSING_TOKEN',
        'IdP token required for multi-IdP issuer pre-match',
        400,
      );
    }

    const { iss: tokenIssuer, aud: tokenAudience } = this.decodeTokenIssuer(idpToken);

    // Batch-load all profiles
    const profiles = await this.loadAuthProfiles(tenantId, profileIds);

    // Issuer pre-match with audience disambiguation.
    // Azure AD profiles match BOTH v1 (sts.windows.net) and v2 (login.microsoftonline.com) issuers.
    const matched = profiles.find((profile) => {
      const profileIssuers = this.deriveIssuersFromProfile(profile);
      if (profileIssuers.length === 0 || !profileIssuers.includes(tokenIssuer)) return false;

      const profileAudience = this.deriveAudienceFromProfile(profile);
      // If profile has audience, it must match; otherwise accept any audience
      return !profileAudience || profileAudience === tokenAudience;
    });

    if (!matched) {
      logger.warn('enduser_auth.issuer_match_failed', {
        tokenIssuer,
        configuredCount: profiles.length,
        tenantId,
      });
      throw new EndUserAuthError(
        'ISSUER_NOT_CONFIGURED',
        'No configured identity provider matches token issuer',
        401,
      );
    }

    logger.info('enduser_auth.issuer_match', {
      matched: true,
      profileId: matched._id,
      provider: matched.authType,
      configuredCount: profiles.length,
      tenantId,
    });

    // Pass the token's actual issuer so the validator enforces the correct format (v1 or v2)
    return this.extractValidationConfig(matched, scopeConfig.allowedDomains, tokenIssuer);
  }

  /**
   * Decode token to read issuer and audience WITHOUT cryptographic verification.
   * Used for issuer pre-match — actual crypto happens in IdPTokenValidator.
   */
  private decodeTokenIssuer(token: string): { iss: string; aud?: string } {
    const decoded = jwt.decode(token, { complete: true });
    if (
      !decoded ||
      typeof decoded === 'string' ||
      !decoded.payload ||
      typeof decoded.payload === 'string'
    ) {
      throw new EndUserAuthError('INVALID_TOKEN_FORMAT', 'Cannot decode token to read issuer', 400);
    }
    const payload = decoded.payload as Record<string, unknown>;
    const iss = payload.iss as string | undefined;
    if (!iss) {
      throw new EndUserAuthError('INVALID_TOKEN_FORMAT', 'Token missing iss claim', 400);
    }
    return { iss, aud: payload.aud as string | undefined };
  }

  /**
   * Derive ALL possible issuers from auth profile config.
   * Azure AD v1.0 tokens use: https://sts.windows.net/{tid}/
   * Azure AD v2.0 tokens use: https://login.microsoftonline.com/{tid}/v2.0
   *
   * Returns an array of possible issuers for pre-match comparison.
   * - azure_ad: returns both v1 AND v2 format (unless explicit issuer set)
   * - oauth2_app: returns config.issuer directly
   */
  private deriveIssuersFromProfile(profile: IAuthProfile): string[] {
    const config = profile.config as Record<string, unknown>;
    if (config.issuer) return [config.issuer as string];

    if (profile.authType === 'azure_ad') {
      const azureTenantId = config.tenantId as string;
      if (azureTenantId) {
        // Azure AD issues tokens with different issuer formats depending on version:
        // v1.0 access_tokens: https://sts.windows.net/{tid}/
        // v2.0 id_tokens:     https://login.microsoftonline.com/{tid}/v2.0
        return [
          `https://sts.windows.net/${azureTenantId}/`,
          `https://login.microsoftonline.com/${azureTenantId}/v2.0`,
        ];
      }
    }

    return [];
  }

  /**
   * @deprecated Use deriveIssuersFromProfile for multi-format matching.
   * Kept for extractValidationConfig which needs the MATCHED issuer.
   */
  private deriveIssuerFromProfile(profile: IAuthProfile): string | undefined {
    const config = profile.config as Record<string, unknown>;
    if (config.issuer) return config.issuer as string;

    if (profile.authType === 'azure_ad') {
      const azureTenantId = config.tenantId as string;
      const endpoint = (config.endpoint as string) || 'https://login.microsoftonline.com';
      if (azureTenantId) {
        return `${endpoint.replace(/\/$/, '')}/${azureTenantId}/v2.0`;
      }
    }

    return undefined;
  }

  /**
   * Derive audience from auth profile config.
   * Falls back to secrets.clientId when explicit audience is not set.
   */
  private deriveAudienceFromProfile(profile: IAuthProfile): string | undefined {
    const config = profile.config as Record<string, unknown>;
    const rawSecrets = (profile as any).encryptedSecrets;
    const secrets: Record<string, unknown> | undefined =
      typeof rawSecrets === 'string' ? JSON.parse(rawSecrets) : (rawSecrets ?? undefined);
    return (
      (config.audience as string) ??
      (secrets?.clientId as string) ??
      (config.clientId as string) ??
      undefined
    );
  }

  /**
   * Extract IdPValidationConfig from a matched auth profile.
   * When matchedIssuer is provided (from pre-match), use it directly so the
   * validator enforces the exact issuer that was matched (v1 or v2 format).
   */
  private extractValidationConfig(
    profile: IAuthProfile,
    allowedDomains: string[],
    matchedIssuer?: string,
  ): IdPValidationConfig {
    return {
      expectedIssuer: matchedIssuer ?? this.deriveIssuerFromProfile(profile),
      expectedAudience: this.deriveAudienceFromProfile(profile),
      allowedDomains,
    };
  }

  /**
   * Build config from a single profile by ID (used for single-profile shortcut).
   * When tokenIssuer is provided, validates it against the profile's known issuers
   * and passes it through so the validator enforces the correct format.
   */
  private async buildConfigFromProfile(
    tenantId: string,
    profileId: string,
    allowedDomains: string[],
    tokenIssuer?: string,
  ): Promise<IdPValidationConfig> {
    const profile = await AuthProfile.findOne({
      _id: profileId,
      tenantId,
    }).lean();

    if (!profile) {
      throw new EndUserAuthError(
        'AUTH_PROFILE_NOT_FOUND',
        'Configured auth profile not found',
        500,
      );
    }

    // If tokenIssuer provided, verify it matches one of the profile's expected issuers
    let resolvedIssuer = tokenIssuer;
    if (tokenIssuer) {
      const profileIssuers = this.deriveIssuersFromProfile(profile);
      if (profileIssuers.length > 0 && !profileIssuers.includes(tokenIssuer)) {
        throw new EndUserAuthError(
          'ISSUER_NOT_CONFIGURED',
          'No configured identity provider matches token issuer',
          401,
        );
      }
    } else {
      resolvedIssuer = undefined;
    }

    return this.extractValidationConfig(profile, allowedDomains, resolvedIssuer);
  }

  /**
   * Batch-load auth profiles by IDs with Redis caching (60s TTL).
   */
  private async loadAuthProfiles(tenantId: string, profileIds: string[]): Promise<IAuthProfile[]> {
    const cacheKey = `searchai:auth-profiles:${tenantId}:${profileIds.sort().join(',')}`;
    const redisClient = getGlobalRedisClient();

    // Try cache first
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as IAuthProfile[];
      } catch {
        // Corrupted cache entry — fall through to DB
      }
    }

    const profiles = await AuthProfile.find({
      _id: { $in: profileIds },
      tenantId,
    }).lean();

    // Cache for 60s (fire-and-forget)
    if (profiles.length > 0) {
      redisClient.set(cacheKey, JSON.stringify(profiles), 60).catch((err) => {
        logger.warn('Failed to cache auth profiles', {
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return profiles as IAuthProfile[];
  }

  /**
   * Create or resolve a Contact card for the authenticated end-user.
   *
   * Platform invariant: identityTier ≥ 2 → create Contact.
   * IdP-validated users are Tier 2 (verified via trusted external provider).
   */
  private async resolveOrCreateContact(
    tenantId: string,
    userIdentity: UserIdentity,
  ): Promise<string | undefined> {
    try {
      // Look for existing contact with this email in this tenant
      // Contact identities are encrypted, but sourceIdentities store blindIndex
      // For now, use sourceIdentities lookup by source + sourceUserId
      const existingContact = await Contact.findOne({
        tenantId,
        'sourceIdentities.source': userIdentity.idpProvider,
        'sourceIdentities.sourceUserId': userIdentity.idpUserId,
      }).lean();

      if (existingContact) {
        // Update lastSeenAt
        await Contact.updateOne(
          { _id: existingContact._id, tenantId },
          { $set: { lastSeenAt: new Date() } },
        );
        return existingContact._id;
      }

      // Create new Contact
      const now = new Date();
      const newContact = await Contact.create({
        tenantId,
        type: 'customer',
        displayName: userIdentity.name ?? userIdentity.email,
        sourceIdentities: [
          {
            source: userIdentity.idpProvider,
            sourceUserId: userIdentity.idpUserId,
            encryptedEmail: null, // TODO: encrypt when encryption service available
            blindIndex: null,
            displayName: userIdentity.name ?? null,
            resolved: true,
            lastSyncAt: now,
          },
        ],
        acl: {
          effectiveGroups: userIdentity.groups ?? [],
          directGroups: (userIdentity.groups ?? []).map((g) => ({
            group: g,
            source: userIdentity.idpProvider,
            addedAt: now,
          })),
          domain: userIdentity.domain,
          effectiveGroupsComputedAt: now,
          syncVersion: 1,
        },
        identities: [],
        channelHistory: [],
        sessionCount: 0,
        mergedInto: null,
        tags: ['search_public_api'],
        firstSeenAt: now,
        lastSeenAt: now,
      });

      logger.info('Created Contact for end-user', {
        tenantId,
        contactId: newContact._id,
        email: userIdentity.email,
        provider: userIdentity.idpProvider,
      });

      return newContact._id as string;
    } catch (error) {
      // Contact creation is best-effort — don't fail the auth flow
      logger.error('Failed to resolve/create Contact', {
        tenantId,
        email: userIdentity.email,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}

// ─── Shared Helper for Middleware (Path D) ─────────────────────────────

/**
 * Resolve IdP validation config for a token, used by permission-filter middleware (Path D).
 *
 * Returns undefined if no auth profiles are configured (backward compat: JWKS-only).
 * Throws EndUserAuthError if profiles are configured but issuer doesn't match.
 */
export async function resolveValidationConfigForToken(
  idpToken: string,
  tenantId: string,
  projectId: string,
): Promise<IdPValidationConfig | undefined> {
  const settings = await ProjectSettings.findOne({ tenantId, projectId }).lean();
  const scopeConfig = settings?.publicApiAccess?.scopes?.['search.query'];

  if (!scopeConfig?.enabled) return undefined;

  const profileIds = scopeConfig.authProfileIds ?? [];
  if (profileIds.length === 0) return undefined;

  // Single profile shortcut — still decode token to get actual issuer for v1/v2 disambiguation
  if (profileIds.length === 1) {
    const profile = await AuthProfile.findOne({
      _id: profileIds[0],
      tenantId,
    }).lean();
    if (!profile) return undefined;

    // Decode token issuer for v1/v2 format resolution
    const decoded = jwt.decode(idpToken, { complete: true });
    let tokenIssuer: string | undefined;
    if (
      decoded &&
      typeof decoded !== 'string' &&
      decoded.payload &&
      typeof decoded.payload !== 'string'
    ) {
      tokenIssuer = (decoded.payload as Record<string, unknown>).iss as string | undefined;
    }

    // Verify token issuer matches the profile
    if (tokenIssuer) {
      const profileIssuers = deriveIssuersFromProfileStatic(profile as IAuthProfile);
      if (profileIssuers.length > 0 && !profileIssuers.includes(tokenIssuer)) {
        throw new EndUserAuthError(
          'ISSUER_NOT_CONFIGURED',
          'No configured identity provider matches token issuer',
          401,
        );
      }
    }

    return extractProfileValidationConfig(
      profile as IAuthProfile,
      scopeConfig.allowedDomains,
      tokenIssuer,
    );
  }

  // Multi-IdP: decode token issuer, batch-load profiles, pre-match
  const decoded = jwt.decode(idpToken, { complete: true });
  if (
    !decoded ||
    typeof decoded === 'string' ||
    !decoded.payload ||
    typeof decoded.payload === 'string'
  ) {
    throw new EndUserAuthError('INVALID_TOKEN_FORMAT', 'Cannot decode token to read issuer', 400);
  }
  const payload = decoded.payload as Record<string, unknown>;
  const tokenIssuer = payload.iss as string | undefined;
  if (!tokenIssuer) {
    throw new EndUserAuthError('INVALID_TOKEN_FORMAT', 'Token missing iss claim', 400);
  }
  const tokenAudience = payload.aud as string | undefined;

  const profiles = await AuthProfile.find({
    _id: { $in: profileIds },
    tenantId,
  }).lean();

  const matched = (profiles as IAuthProfile[]).find((profile) => {
    const profileIssuers = deriveIssuersFromProfileStatic(profile);
    if (profileIssuers.length === 0 || !profileIssuers.includes(tokenIssuer)) return false;

    const profileAudience = deriveAudienceFromProfileStatic(profile);
    return !profileAudience || profileAudience === tokenAudience;
  });

  if (!matched) {
    logger.warn('enduser_auth.issuer_match_failed (Path D)', {
      tokenIssuer,
      configuredCount: profiles.length,
      tenantId,
    });
    throw new EndUserAuthError(
      'ISSUER_NOT_CONFIGURED',
      'No configured identity provider matches token issuer',
      401,
    );
  }

  // Pass the token's actual issuer so the validator enforces the correct format (v1 or v2)
  return extractProfileValidationConfig(matched, scopeConfig.allowedDomains, tokenIssuer);
}

/** Static helpers for use outside the class (shared with resolveValidationConfigForToken). */

/**
 * Derive ALL possible issuers for Azure AD (v1 + v2 format).
 * Azure AD v1.0 tokens: https://sts.windows.net/{tid}/
 * Azure AD v2.0 tokens: https://login.microsoftonline.com/{tid}/v2.0
 */
function deriveIssuersFromProfileStatic(profile: IAuthProfile): string[] {
  const config = profile.config as Record<string, unknown>;
  if (config.issuer) return [config.issuer as string];
  if (profile.authType === 'azure_ad') {
    const azureTenantId = config.tenantId as string;
    if (azureTenantId) {
      return [
        `https://sts.windows.net/${azureTenantId}/`,
        `https://login.microsoftonline.com/${azureTenantId}/v2.0`,
      ];
    }
  }
  return [];
}

function deriveAudienceFromProfileStatic(profile: IAuthProfile): string | undefined {
  const config = profile.config as Record<string, unknown>;
  const rawSecrets = (profile as any).encryptedSecrets;
  const secrets: Record<string, unknown> | undefined =
    typeof rawSecrets === 'string' ? JSON.parse(rawSecrets) : (rawSecrets ?? undefined);
  return (
    (config.audience as string) ??
    (secrets?.clientId as string) ??
    (config.clientId as string) ??
    undefined
  );
}

function extractProfileValidationConfig(
  profile: IAuthProfile,
  allowedDomains: string[],
  matchedIssuer?: string,
): IdPValidationConfig {
  return {
    expectedIssuer: matchedIssuer ?? deriveIssuersFromProfileStatic(profile)[0],
    expectedAudience: deriveAudienceFromProfileStatic(profile),
    allowedDomains,
  };
}

// ─── Custom Error ────────────────────────────────────────────────────────

export class EndUserAuthError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = 'EndUserAuthError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────

let instance: EndUserAuthService | null = null;

export function getEndUserAuthService(): EndUserAuthService {
  if (!instance) {
    instance = new EndUserAuthService();
  }
  return instance;
}
