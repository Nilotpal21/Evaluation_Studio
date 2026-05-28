/**
 * Path B: OAuth Redirect / PKCE Flow Routes
 *
 * GET /api/search/auth/oauth/authorize — Initiate OAuth redirect to IdP
 * GET /api/search/auth/oauth/callback  — Handle OAuth callback from IdP
 *
 * Security:
 * - PKCE (S256) prevents authorization code interception
 * - GETDEL state in Redis prevents replay attacks
 * - Nonce binding prevents token substitution
 * - Redirect URI exact-match validation prevents open redirects
 * - URL fragment delivery prevents token leakage in logs/Referer
 * - Rate limiting: 30 req/min per IP
 */

import { Router, type Router as RouterType } from 'express';
import { createLogger } from '@abl/compiler/platform';
// eslint-disable-next-line custom-auth-lint -- decode() used for nonce verification after IdPTokenValidator validates signature
import jwt from 'jsonwebtoken';
import { getLazyModel } from '../db/index.js';
import { EndUserAuthError } from '../services/end-user/end-user-auth.service.js';
import {
  storeOAuthState,
  consumeOAuthState,
  generatePKCE,
  generateNonce,
} from '../services/end-user/oauth-state.service.js';
import { buildOAuthUrls, exchangeCodeForTokens } from '../services/end-user/oauth-url-builder.js';
import { getGlobalRedisClient } from '../services/cache/redis-client.js';
import type { ISearchIndex, IProjectSettings, IAuthProfile } from '@agent-platform/database/models';
import { getConfig } from '../config/index.js';
import { IdPTokenValidator, issueSearchSessionToken } from '@agent-platform/shared-auth/idp';
import type { IdPValidationConfig, RedisLike } from '@agent-platform/shared-auth/idp';

const logger = createLogger('auth-oauth-route');

const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
const ProjectSettings = getLazyModel<IProjectSettings>('ProjectSettings');
const AuthProfile = getLazyModel<IAuthProfile>('AuthProfile');

// Client state validation: max 512 bytes, printable ASCII only
const CLIENT_STATE_MAX_BYTES = 512;
const PRINTABLE_ASCII_RE = /^[\x20-\x7E]*$/;

export function createAuthOAuthRouter(): RouterType {
  const router: RouterType = Router();

  // ─── GET /authorize ─────────────────────────────────────────────────

  router.get('/authorize', async (req, res) => {
    const startTime = Date.now();
    try {
      // 1. Validate required params
      const indexId = req.query.indexId as string;
      const provider = req.query.provider as string; // profile ID
      const redirectUri = req.query.redirect_uri as string;
      const clientState = req.query.state as string | undefined;

      if (!indexId) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_INDEX_ID', message: 'indexId query parameter is required' },
        });
        return;
      }

      if (!provider) {
        res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_PROVIDER',
            message: 'provider query parameter is required (auth profile ID)',
          },
        });
        return;
      }

      if (!redirectUri) {
        res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_REDIRECT_URI',
            message: 'redirect_uri query parameter is required',
          },
        });
        return;
      }

      // Validate client state
      if (clientState) {
        if (Buffer.byteLength(clientState, 'utf-8') > CLIENT_STATE_MAX_BYTES) {
          res.status(400).json({
            success: false,
            error: { code: 'STATE_TOO_LARGE', message: 'state must be at most 512 bytes' },
          });
          return;
        }
        if (!PRINTABLE_ASCII_RE.test(clientState)) {
          res.status(400).json({
            success: false,
            error: {
              code: 'STATE_INVALID_CHARS',
              message: 'state must contain only printable ASCII characters',
            },
          });
          return;
        }
      }

      // 2. Resolve index → tenantId, projectId
      const index = await SearchIndex.findOne({ _id: indexId }).lean();
      if (!index) {
        res.status(404).json({
          success: false,
          error: { code: 'INDEX_NOT_FOUND', message: `Index "${indexId}" not found` },
        });
        return;
      }
      const { tenantId, projectId } = index;

      // 3. Load scope config
      const settings = await ProjectSettings.findOne({ tenantId, projectId }).lean();
      const scopeConfig = settings?.publicApiAccess?.scopes?.['search.query'];
      if (!scopeConfig?.enabled) {
        res.status(403).json({
          success: false,
          error: {
            code: 'END_USER_ACCESS_DISABLED',
            message: 'End-user search access is not enabled for this project',
          },
        });
        return;
      }

      // 4. Verify provider (profile ID) is in authProfileIds
      const profileIds = scopeConfig.authProfileIds ?? [];
      if (!profileIds.includes(provider)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'PROFILE_NOT_CONFIGURED',
            message: 'Specified auth profile is not configured for this project',
          },
        });
        return;
      }

      // 5. Load auth profile
      const profile = await AuthProfile.findOne({
        _id: provider,
        tenantId,
      }).lean();
      if (!profile) {
        res.status(404).json({
          success: false,
          error: { code: 'PROFILE_NOT_FOUND', message: 'Auth profile not found' },
        });
        return;
      }
      if ((profile as any).status !== 'active') {
        res.status(400).json({
          success: false,
          error: { code: 'PROFILE_NOT_ACTIVE', message: 'Auth profile is not active' },
        });
        return;
      }

      // 6. Validate redirect_uri against allowedRedirectUris (exact match)
      const allowedRedirectUris = scopeConfig.allowedRedirectUris ?? [];
      if (allowedRedirectUris.length > 0 && !allowedRedirectUris.includes(redirectUri)) {
        res.status(400).json({
          success: false,
          error: { code: 'REDIRECT_URI_NOT_ALLOWED', message: 'Redirect URI not in allowlist' },
        });
        return;
      }

      // 7. Generate PKCE + nonce
      const { codeVerifier, codeChallenge } = generatePKCE();
      const nonce = generateNonce();

      // 8. Store state in Redis
      const stateId = await storeOAuthState({
        codeVerifier,
        nonce,
        indexId,
        profileId: provider,
        redirectUri,
        clientState,
        createdAt: Date.now(),
      });

      // 9. Build our callback URL
      const publicUrl =
        process.env.SEARCH_AI_RUNTIME_PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
      const callbackUrl = `${publicUrl}/api/search/auth/oauth/callback`;

      // 10. Build authorization URL
      const oauthUrls = buildOAuthUrls(profile as IAuthProfile);
      const rawSecrets = (profile as any).encryptedSecrets;
      const secrets: Record<string, unknown> | undefined =
        typeof rawSecrets === 'string' ? JSON.parse(rawSecrets) : (rawSecrets ?? undefined);
      const clientId = (secrets?.clientId as string) || '';

      const authUrl = new URL(oauthUrls.authorizationUrl);
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', callbackUrl);
      authUrl.searchParams.set('scope', 'openid email profile');
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('state', stateId);
      authUrl.searchParams.set('nonce', nonce);

      logger.info('enduser_auth.path_b.authorize', {
        profileId: provider,
        provider: profile.authType,
        tenantId,
        latencyMs: Date.now() - startTime,
      });

      // 11. Redirect to IdP
      res.redirect(302, authUrl.toString());
    } catch (error) {
      if (error instanceof Error && error.message.includes('Redis unavailable')) {
        logger.error('Redis unavailable for OAuth state storage', {
          error: error.message,
        });
        res.status(503).json({
          success: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Service temporarily unavailable',
          },
        });
        return;
      }

      logger.error('OAuth authorize failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to initiate OAuth flow' },
      });
    }
  });

  // ─── GET /callback ──────────────────────────────────────────────────

  router.get('/callback', async (req, res) => {
    const startTime = Date.now();
    try {
      const code = req.query.code as string | undefined;
      const stateId = req.query.state as string;
      const errorParam = req.query.error as string | undefined;
      const errorDescription = req.query.error_description as string | undefined;

      if (!stateId) {
        res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_STATE',
            message: 'state query parameter is required',
          },
        });
        return;
      }

      // 1. Consume state from Redis (atomic GETDEL — one-time use)
      const state = await consumeOAuthState(stateId);
      if (!state) {
        logger.warn('enduser_auth.path_b.callback_error', {
          outcome: 'expired_state',
          stateId,
        });
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_STATE',
            message: 'Invalid or expired authorization state',
          },
        });
        return;
      }

      // 2. If IdP returned an error
      if (errorParam) {
        logger.warn('enduser_auth.path_b.callback_error', {
          outcome: 'idp_error',
          error: errorParam,
          errorDescription,
        });
        // Redirect to client with error
        const clientRedirectUrl = new URL(state.redirectUri);
        clientRedirectUrl.searchParams.set('error', errorParam);
        if (errorDescription) {
          clientRedirectUrl.searchParams.set('error_description', errorDescription);
        }
        if (state.clientState) {
          clientRedirectUrl.searchParams.set('state', state.clientState);
        }
        res.redirect(302, clientRedirectUrl.toString());
        return;
      }

      if (!code) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_CODE', message: 'Authorization code is required' },
        });
        return;
      }

      // 3. Resolve index context for tenant/project (needed for tenant-scoped queries)
      const index = await SearchIndex.findOne({ _id: state.indexId }).lean();
      if (!index) {
        res.status(400).json({
          success: false,
          error: { code: 'INDEX_NOT_FOUND', message: 'Index no longer exists' },
        });
        return;
      }
      const { tenantId, projectId } = index;

      // 4. Load auth profile (tenant-scoped for defense-in-depth)
      const profile = await AuthProfile.findOne({ _id: state.profileId, tenantId }).lean();
      if (!profile || (profile as any).status !== 'active') {
        res.status(400).json({
          success: false,
          error: { code: 'PROFILE_INVALID', message: 'Auth profile is no longer active' },
        });
        return;
      }

      // 5. Exchange code for tokens
      const oauthUrls = buildOAuthUrls(profile as IAuthProfile);
      const rawSecrets = (profile as any).encryptedSecrets;
      const secrets: Record<string, unknown> | undefined =
        typeof rawSecrets === 'string' ? JSON.parse(rawSecrets) : (rawSecrets ?? undefined);
      const clientId = (secrets?.clientId as string) || '';
      const clientSecret = (secrets?.clientSecret as string) || '';

      const publicUrl =
        process.env.SEARCH_AI_RUNTIME_PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
      const callbackUrl = `${publicUrl}/api/search/auth/oauth/callback`;

      const tokens = await exchangeCodeForTokens({
        tokenUrl: oauthUrls.tokenUrl,
        code,
        clientId,
        clientSecret,
        codeVerifier: state.codeVerifier,
        redirectUri: callbackUrl,
      });

      // 6. Validate id_token via IdPTokenValidator
      // For Path B, the id_token issuer depends on the Azure AD endpoint version.
      // Read the actual issuer from the token and use it for validation if it matches
      // one of the expected Azure AD formats.
      const config = (profile as IAuthProfile).config as Record<string, unknown>;
      let profileIssuer: string | undefined = config.issuer as string | undefined;

      if (!profileIssuer && profile.authType === 'azure_ad' && config.tenantId) {
        // Peek at the id_token's issuer to determine v1 vs v2 format
        const peeked = jwt.decode(tokens.id_token, { complete: true });
        const peekedIss =
          peeked && typeof peeked !== 'string' && peeked.payload
            ? ((peeked.payload as Record<string, unknown>).iss as string | undefined)
            : undefined;
        const tid = config.tenantId as string;
        const v1Iss = `https://sts.windows.net/${tid}/`;
        const v2Iss = `https://login.microsoftonline.com/${tid}/v2.0`;
        // Use the token's actual issuer if it matches either known Azure format
        if (peekedIss === v1Iss || peekedIss === v2Iss) {
          profileIssuer = peekedIss;
        } else {
          // Default to v2 (Path B uses v2.0 authorize endpoint)
          profileIssuer = v2Iss;
        }
      }

      const validationConfig: IdPValidationConfig = {
        expectedIssuer: profileIssuer,
        expectedAudience: (config.audience as string) || clientId || undefined,
      };

      // Create validator instance for this request
      const redisClient = getGlobalRedisClient();
      const redisAdapter: RedisLike = {
        get: (key: string) => redisClient.get(key),
        set: (key: string, value: string, ttl: number) => redisClient.set(key, value, ttl),
        del: (...keys: string[]) => redisClient.del(...keys).then(() => {}),
        scanByPattern: (pattern: string) => redisClient.scanByPattern(pattern),
      };
      const idpValidator = new IdPTokenValidator(redisAdapter, {
        debug: (msg, meta) => logger.debug(msg, meta ?? {}),
        info: (msg, meta) => logger.info(msg, meta ?? {}),
        warn: (msg, meta) => logger.warn(msg, meta ?? {}),
        error: (msg, meta) => logger.error(msg, meta ?? {}),
      });

      const userIdentity = await idpValidator.validateToken(
        tokens.id_token,
        tenantId,
        validationConfig,
      );

      // 6b. Nonce verification
      const decodedIdToken = jwt.decode(tokens.id_token, { complete: true });
      if (decodedIdToken && typeof decodedIdToken !== 'string' && decodedIdToken.payload) {
        const payload = decodedIdToken.payload as Record<string, unknown>;
        if (payload.nonce !== state.nonce) {
          logger.warn('enduser_auth.path_b.nonce_mismatch', {
            tenantId,
            profileId: state.profileId,
          });
          res.status(401).json({
            success: false,
            error: { code: 'NONCE_MISMATCH', message: 'Token nonce does not match' },
          });
          return;
        }
      }

      // 6c. Domain allowlist check
      const settings = await ProjectSettings.findOne({ tenantId, projectId }).lean();
      const scopeConfig = settings?.publicApiAccess?.scopes?.['search.query'];
      const allowedDomains = scopeConfig?.allowedDomains ?? [];
      if (allowedDomains.length > 0) {
        const normalizedDomain = userIdentity.domain.toLowerCase();
        if (!allowedDomains.some((d) => d.toLowerCase() === normalizedDomain)) {
          res.status(403).json({
            success: false,
            error: {
              code: 'DOMAIN_NOT_ALLOWED',
              message: 'Email domain is not allowed for this project',
            },
          });
          return;
        }
      }

      // 7. Issue session token
      // Contact resolution is deferred — not blocking Path B redirect flow.
      const ttlSeconds = scopeConfig?.sessionTokenTtlSeconds || 900;
      const jwtSecret = getConfig().jwt.secret;

      const sessionToken = issueSearchSessionToken(
        {
          email: userIdentity.email,
          tenantId,
          projectId,
          domain: userIdentity.domain,
          contactId: undefined, // Contact resolution is async, not blocking Path B
          idpProvider: userIdentity.idpProvider,
          ttlSeconds,
        },
        jwtSecret,
      );

      logger.info('enduser_auth.path_b.callback_success', {
        provider: profile.authType,
        tenantId,
        email: userIdentity.email,
        latencyMs: Date.now() - startTime,
      });

      // 9. Redirect to client redirect URI with token in URL fragment
      const fragment = new URLSearchParams({
        token: sessionToken,
        expires_in: String(ttlSeconds),
        ...(state.clientState ? { state: state.clientState } : {}),
      });

      // Check if profile opts into query param delivery mode
      const tokenDeliveryMode = config.tokenDeliveryMode as string | undefined;
      if (tokenDeliveryMode === 'query_param') {
        const clientUrl = new URL(state.redirectUri);
        clientUrl.searchParams.set('token', sessionToken);
        clientUrl.searchParams.set('expires_in', String(ttlSeconds));
        if (state.clientState) {
          clientUrl.searchParams.set('state', state.clientState);
        }
        res.redirect(302, clientUrl.toString());
      } else {
        // Default: URL fragment (not visible to server, not in logs)
        res.redirect(302, `${state.redirectUri}#${fragment.toString()}`);
      }
    } catch (error) {
      if (error instanceof EndUserAuthError) {
        logger.warn('enduser_auth.path_b.callback_error', {
          outcome: 'auth_error',
          code: error.code,
          message: error.message,
        });
        res.status(error.statusCode).json({
          success: false,
          error: { code: error.code, message: error.message },
        });
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      logger.error('OAuth callback failed', { error: message });

      // Map common errors
      if (
        message.includes('expired') ||
        message.includes('invalid signature') ||
        message.includes('jwt malformed') ||
        message.includes('issuer mismatch')
      ) {
        res.status(401).json({
          success: false,
          error: { code: 'INVALID_TOKEN', message: 'IdP token is invalid or expired' },
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'OAuth callback failed' },
      });
    }
  });

  return router;
}
