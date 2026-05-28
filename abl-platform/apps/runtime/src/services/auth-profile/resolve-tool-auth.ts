/**
 * Auth Profile Tool Auth Resolution
 *
 * Resolves authentication credentials for tools that reference auth profiles
 * by name (via `auth_profile_ref` in the IR).
 *
 * auth_profile_ref takes precedence over inline auth when both are present.
 */

import type { ToolDefinition } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import {
  applyAuth,
  resolveClientCredentialsToken,
  detectInsufficientScope,
  emitAuthProfileAuditEvent,
  type ProviderResponse,
  type ScopeInsufficientResult,
} from '@agent-platform/shared/services/auth-profile';
import { validateUrlForSSRF } from '@agent-platform/shared/security';
import { getDevSSRFOptions } from '@agent-platform/shared-kernel/security';
import { resolveByName } from '../auth-profile-resolver.js';
import {
  resolveOAuthGrantAccessToken,
  diagnoseGrantStoreState,
  type GrantStoreDiagnosis,
} from '../oauth-grant-service.js';
import { getRedisClient } from '../redis/redis-client.js';
import { shouldUseTenantScopedAuth } from './auth-scope-policy.js';
import { resolveAuthOwners } from '../session/execution-owners.js';

const log = createLogger('resolve-tool-auth');

/**
 * Typed error for auth profile not found — used for structured error matching
 * instead of fragile string matching on error messages.
 */
export class AuthProfileNotFoundError extends Error {
  readonly code = 'AUTH_PROFILE_NOT_FOUND' as const;
  readonly profileName: string;
  readonly toolName: string;
  readonly jitAuth: boolean;

  constructor(profileName: string, toolName: string, jitAuth: boolean) {
    const suffix = jitAuth
      ? ' JIT auth will trigger user consent.'
      : ' Profile not found or inactive.';
    super(
      `AUTH_PROFILE_NOT_FOUND: Profile "${profileName}" not found for tool "${toolName}".${suffix}`,
    );
    this.name = 'AuthProfileNotFoundError';
    this.profileName = profileName;
    this.toolName = toolName;
    this.jitAuth = jitAuth;
  }
}

/**
 * Thrown when a workflow `tool_call` references an auth profile that has
 * `connectionMode: 'per_user'`. Workflows execute under a service token and
 * therefore have no end-user identity to which a per-user grant could be
 * scoped. The Studio create-time validator (FR-9 1.1.6) is the primary
 * defense; this error is the runtime fallback.
 */
export class AuthProfilePerUserInWorkflowError extends Error {
  readonly code = 'AUTH_PROFILE_PER_USER_IN_WORKFLOW' as const;
  readonly profileName: string;
  readonly toolName: string;

  constructor(profileName: string, toolName: string) {
    super(
      `AUTH_PROFILE_PER_USER_IN_WORKFLOW: Profile "${profileName}" has connectionMode='per_user' and cannot be used from a workflow tool_call (tool "${toolName}"). Use a shared-mode profile or invoke the tool from an interactive context.`,
    );
    this.name = 'AuthProfilePerUserInWorkflowError';
    this.profileName = profileName;
    this.toolName = toolName;
  }
}

/**
 * Thrown when a workflow `tool_call` references an auth profile with
 * `usageMode: 'jit'`. JIT requires an interactive `sendAuthChallenge`
 * channel that workflows do not provide.
 */
export class AuthProfileJitInWorkflowError extends Error {
  readonly code = 'JIT_AUTH_NOT_SUPPORTED' as const;
  readonly profileName: string;
  readonly toolName: string;

  constructor(profileName: string, toolName: string) {
    super(
      `JIT_AUTH_NOT_SUPPORTED: Profile "${profileName}" has usageMode='jit' and cannot be resolved from a workflow tool_call (tool "${toolName}"). Workflows have no interactive channel to deliver an auth challenge.`,
    );
    this.name = 'AuthProfileJitInWorkflowError';
    this.profileName = profileName;
    this.toolName = toolName;
  }
}

/**
 * Reason discriminator for AuthProfileTokenRequiredError. Drives both the
 * specific `code` (for sanitized user-facing messages) and the message body
 * itself, so a stale-token failure no longer reads as "never authorized".
 */
export type TokenRequiredReason =
  | 'no_grant' // never authorized — no row in end_user_oauth_tokens
  | 'expired_no_refresh_token' // authorized previously, expired, no refresh token to renew with
  | 'expired_refresh_failed' // authorized previously, expired, refresh attempted and failed
  | 'unknown'; // fallback when diagnosis not run / not applicable

const TOKEN_REQUIRED_CODE_BY_REASON = {
  no_grant: 'AUTH_PROFILE_NOT_AUTHORIZED',
  expired_no_refresh_token: 'AUTH_PROFILE_REFRESH_REQUIRED',
  expired_refresh_failed: 'AUTH_PROFILE_REFRESH_FAILED',
  unknown: 'AUTH_PROFILE_TOKEN_REQUIRED',
} as const;

export type TokenRequiredCode =
  (typeof TOKEN_REQUIRED_CODE_BY_REASON)[keyof typeof TOKEN_REQUIRED_CODE_BY_REASON];

function resolveProfileDefaultConnectionMode(profile: {
  connectionMode?: 'shared' | 'per_user';
  visibility?: string;
}): 'shared' | 'per_user' {
  if (profile.connectionMode === 'shared' || profile.connectionMode === 'per_user') {
    return profile.connectionMode;
  }

  if (profile.visibility === 'personal') {
    return 'per_user';
  }

  return 'shared';
}

function resolveSharedCompatibilityPrincipal(
  profile: { createdBy?: string },
  optionsUserId?: string,
): string | undefined {
  const candidates = [optionsUserId, profile.createdBy];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const normalized = candidate.trim();
    if (!normalized || normalized === '__tenant__') {
      continue;
    }
    return normalized;
  }
  return undefined;
}

function normalizeScopeList(scopes: unknown): string[] {
  if (Array.isArray(scopes)) {
    return scopes.filter((scope): scope is string => typeof scope === 'string' && scope.length > 0);
  }

  if (typeof scopes === 'string') {
    return scopes
      .split(/[\s,]+/u)
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);
  }

  return [];
}

function buildTokenRequiredMessage(params: {
  profileName: string;
  toolName: string;
  reason: TokenRequiredReason;
  jitAuth: boolean;
  connectionMode: 'per_user' | 'shared';
  requiredScopes: string[];
}): string {
  const code = TOKEN_REQUIRED_CODE_BY_REASON[params.reason];
  const scopeSuffix =
    params.requiredScopes.length > 0
      ? ` Required scopes: ${params.requiredScopes.join(', ')}.`
      : '';
  const jitGuidance = params.jitAuth ? ' JIT auth will request authorization.' : '';

  switch (params.reason) {
    case 'no_grant':
      return `${code}: Profile "${params.profileName}" has not been authorized yet for tool "${params.toolName}". Authorize this profile in Auth Profiles, then retry.${scopeSuffix}${jitGuidance}`;
    case 'expired_no_refresh_token':
      return `${code}: Profile "${params.profileName}" was authorized previously, but the access token has expired and no refresh token is stored. Re-authorize the profile (set access_type=offline for Google or include offline_access in scopes for Microsoft) so it can auto-renew.${scopeSuffix}${jitGuidance}`;
    case 'expired_refresh_failed':
      return `${code}: Profile "${params.profileName}" had a stored refresh token, but the provider rejected it. The provider may have revoked or rotated the grant. Re-authorize the profile and retry tool "${params.toolName}".${scopeSuffix}${jitGuidance}`;
    case 'unknown':
    default: {
      const guidance = params.jitAuth
        ? ' JIT auth will request authorization.'
        : ' Authorize this profile before retrying.';
      return `${code}: Profile "${params.profileName}" does not have an authorized ${params.connectionMode} token for tool "${params.toolName}".${scopeSuffix}${guidance}`;
    }
  }
}

export class AuthProfileTokenRequiredError extends Error {
  readonly code: TokenRequiredCode;
  readonly reason: TokenRequiredReason;
  readonly profileName: string;
  readonly toolName: string;
  readonly jitAuth: boolean;
  readonly connectionMode: 'per_user' | 'shared';
  readonly requiredScopes: string[];

  constructor(params: {
    profileName: string;
    toolName: string;
    jitAuth: boolean;
    connectionMode: 'per_user' | 'shared';
    requiredScopes: string[];
    reason?: TokenRequiredReason;
  }) {
    const reason = params.reason ?? 'unknown';
    super(buildTokenRequiredMessage({ ...params, reason }));

    this.name = 'AuthProfileTokenRequiredError';
    this.code = TOKEN_REQUIRED_CODE_BY_REASON[reason];
    this.reason = reason;
    this.profileName = params.profileName;
    this.toolName = params.toolName;
    this.jitAuth = params.jitAuth;
    this.connectionMode = params.connectionMode;
    this.requiredScopes = params.requiredScopes;
  }
}

export interface AwsSigV4Context {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service?: string;
}

export interface ToolAuthResult {
  /** Resolved auth headers to apply to the HTTP request */
  headers: Record<string, string>;
  /** Resolved query params to apply to the HTTP request */
  queryParams?: Record<string, string>;
  /** Source of the auth credentials */
  source: 'auth_profile' | 'inline' | 'none';
  /** Resolved auth type from the profile (if source is auth_profile) */
  authType?: string;
  /** Full resolved secrets (for consumers that need more than headers) */
  secrets?: Record<string, unknown>;
  /** TLS options for mTLS auth — caller creates https.Agent with these */
  tlsOptions?: { cert: string; key: string; ca?: string; rejectUnauthorized: true };
  /** WS-Security credentials propagated from applyAuth's ws_security branch. Consumed by HttpToolExecutor via patchToolWithResolvedAuth. */
  wsSecurityCredentials?: {
    username: string;
    password: string;
    certificate?: string;
    mustUnderstand: boolean;
  };
  /** Per-request signing closure propagated to HttpToolExecutor. */
  signRequest?: (assembled: {
    method: string;
    url: string;
    headers: Headers;
    body?: string;
  }) => Promise<Headers>;
  /** Digest challenge credentials propagated to HttpToolExecutor retry path. */
  digestCredentials?: {
    username: string;
    password: string;
    realm: string;
  };
  /** Runtime-only AWS SigV4 context for downstream signing on supported HTTP paths */
  awsSigV4?: AwsSigV4Context;
}

/**
 * Resolve auth credentials for a tool.
 *
 * Resolution priority:
 * 1. auth_profile_ref (resolved by name via AuthProfile collection)
 * 2. Inline auth from http_binding.auth
 * 3. No auth
 *
 * When auth_profile_ref is set, inline auth is ignored.
 *
 * @param tool - The tool IR definition
 * @param tenantId - Tenant ID for isolation
 * @param environment - Optional environment for environment-specific profiles
 * @returns Resolved auth headers and metadata
 */
export async function resolveToolAuth(
  tool: Pick<
    ToolDefinition,
    | 'auth_profile_ref'
    | 'jit_auth'
    | 'http_binding'
    | 'name'
    | 'connection_mode'
    | 'variable_namespace_ids'
  >,
  tenantId: string,
  environment?: string,
  options?: {
    projectId?: string;
    userId?: string;
    sessionPrincipalId?: string;
    configVarStore?: ConfigVarStoreLike;
    authScope?: 'session' | 'user';
    /**
     * Indicates the call came from a workflow `tool_call`. When true, profiles
     * with `connectionMode: 'per_user'` or `usageMode: 'jit'` are rejected
     * with a structured error before any token lookup runs (FR-9 1.1.4/1.1.5).
     */
    workflowContext?: boolean;
  },
): Promise<ToolAuthResult> {
  const headers: Record<string, string> = {};

  // auth_profile_ref takes precedence over inline auth
  if (tool.auth_profile_ref) {
    // Resolve config var templates (e.g., {{config.AUTH_PROFILE}}) before name lookup
    let profileName: string | null = tool.auth_profile_ref;
    if (tool.auth_profile_ref.includes('{{') && options?.projectId) {
      profileName = await resolveAuthProfileRef(
        tool.auth_profile_ref,
        tenantId,
        options.projectId,
        options.configVarStore,
        tool.variable_namespace_ids,
      );
      if (!profileName) {
        throw new Error(
          `AUTH_PROFILE_CONFIG_VAR_NOT_FOUND: Config variable in auth_profile_ref "${tool.auth_profile_ref}" could not be resolved for tool "${tool.name}".`,
        );
      }
    }

    log.debug('Resolving tool auth via auth profile', {
      toolName: tool.name,
      profileName,
      tenantId,
      environment,
      projectId: options?.projectId,
      userId: options?.userId,
      sessionPrincipalId: options?.sessionPrincipalId,
    });

    const resolvedAuthOwners = resolveAuthOwners({
      userId: options?.userId,
      sessionPrincipalId: options?.sessionPrincipalId,
      authScope: options?.authScope,
    });

    // Preconfigured (admin-managed) profiles use connectionMode to decide scope:
    // - connectionMode:'shared' → tenant-scoped token lookup (no userId filter)
    // - connectionMode:'per_user' → user-scoped token lookup (filtered by userId)
    // This is intentionally different from the JIT OAuth flow in websocket handlers,
    // which always uses lookupScope:'user' because the end user gives consent directly.
    const hintedTenantScopedAuth = shouldUseTenantScopedAuth({
      connectionMode: tool.connection_mode,
      authScope: options?.authScope,
    });
    const profileLookupUserId = hintedTenantScopedAuth
      ? undefined
      : resolvedAuthOwners.userScopedOwnerId;
    const profile = await resolveByName(
      profileName,
      tenantId,
      environment,
      options?.projectId,
      profileLookupUserId,
    );

    if (!profile) {
      throw new AuthProfileNotFoundError(profileName, tool.name, !!tool.jit_auth);
    }

    const profileDefaultConnectionMode = resolveProfileDefaultConnectionMode(profile);

    // FR-9 (1.1.4 / 1.1.5): workflow tool_calls cannot use per_user or JIT
    // profiles. Reject before any token resolution so the error surface is
    // immediate and unambiguous.
    if (options?.workflowContext) {
      if (profileDefaultConnectionMode === 'per_user') {
        throw new AuthProfilePerUserInWorkflowError(profileName, tool.name);
      }
      if (profile.usageMode === 'jit') {
        throw new AuthProfileJitInWorkflowError(profileName, tool.name);
      }
    }

    if (profile.authType === 'oauth2_app' || profile.authType === 'oauth2_token') {
      // Tool-level connection_mode is the strongest signal, but legacy tools can
      // omit it. In that case, inherit from the resolved profile mode so shared
      // preconfigured profiles work in non-interactive workflow execution.
      const effectiveConnectionMode = tool.connection_mode ?? profileDefaultConnectionMode;
      const useTenantScopedAuth = shouldUseTenantScopedAuth({
        connectionMode: effectiveConnectionMode,
        authScope: options?.authScope,
      });
      const lookupScope = useTenantScopedAuth ? 'tenant' : 'user';
      const tokenOwnerId = useTenantScopedAuth ? undefined : resolvedAuthOwners.tokenOwnerId;
      const requestedScopes = extractRequestedOAuthScopes(tool);

      if (profile.authType === 'oauth2_app' && lookupScope === 'user' && !tokenOwnerId) {
        throw new Error(
          `AUTH_PROFILE_USER_CONTEXT_REQUIRED: oauth2_app profile "${profileName}" requires a user context for tool "${tool.name}".`,
        );
      }

      let grantedToken = await resolveOAuthGrantAccessToken({
        tenantId,
        authProfileRef: profileName,
        projectId: options?.projectId,
        environment,
        lookupScope,
        authScope: options?.authScope ?? (lookupScope === 'tenant' ? 'tenant' : 'user'),
        scopes: requestedScopes,
        userId: tokenOwnerId,
        resolvedProfile: profile,
      });

      if (!grantedToken && lookupScope === 'tenant') {
        const compatibilityUserId = resolveSharedCompatibilityPrincipal(profile, options?.userId);
        if (compatibilityUserId) {
          log.warn('shared auth profile missing tenant grant; trying compatibility principal', {
            tenantId,
            profileName,
            profileId: profile.profileId,
            compatibilityUserId,
            toolName: tool.name,
          });
          grantedToken = await resolveOAuthGrantAccessToken({
            tenantId,
            authProfileRef: profileName,
            projectId: options?.projectId,
            environment,
            lookupScope: 'user',
            authScope: 'user',
            scopes: requestedScopes,
            userId: compatibilityUserId,
            resolvedProfile: profile,
          });
        }
      }

      if (!grantedToken) {
        // Diagnose the grant-store state so we can throw the most accurate
        // error code + message. Distinguishes "never authorized" (no_grant)
        // from "authorized but expired with no refresh token"
        // (expired_no_refresh_token) from "refresh attempted and failed"
        // (expired_with_refresh_token). The diagnosis is best-effort — on
        // unexpected DB error we fall back to the legacy generic code.
        let reason: TokenRequiredReason = 'unknown';
        const principalId = lookupScope === 'tenant' ? '__tenant__' : (options?.userId ?? '');
        if (principalId) {
          try {
            const diagnosis: GrantStoreDiagnosis = await diagnoseGrantStoreState({
              tenantId,
              profileId: profile.profileId,
              principalId,
            });
            if (diagnosis === 'no_grant') {
              reason = 'no_grant';
            } else if (diagnosis === 'expired_no_refresh_token') {
              reason = 'expired_no_refresh_token';
            } else if (diagnosis === 'expired_with_refresh_token') {
              reason = 'expired_refresh_failed';
            }
            // 'has_active_grant' falls through to 'unknown' — implies a race
            // condition (grant became active between resolveOAuthGrantAccessToken
            // and diagnoseGrantStoreState). Generic message is correct here.
          } catch (err) {
            log.warn('grant-store diagnosis failed; falling back to generic token-required code', {
              tenantId,
              profileId: profile.profileId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        throw new AuthProfileTokenRequiredError({
          profileName,
          toolName: tool.name,
          jitAuth: !!tool.jit_auth,
          connectionMode: effectiveConnectionMode,
          requiredScopes: requestedScopes,
          reason,
        });
      }

      return {
        headers: {
          Authorization: `Bearer ${grantedToken.accessToken}`,
        },
        source: 'auth_profile',
        authType: profile.authType,
        secrets: { accessToken: grantedToken.accessToken },
      };
    }

    const resolvedSecrets = await resolveProfileSecretsForRequest(profile, tenantId);
    const appliedAuth = await applyAuth({
      authType: profile.authType,
      config: profile.config,
      secrets: resolvedSecrets,
      headers,
      queryParams: new URLSearchParams(),
      context: {
        tenantId,
        profileId: profile.profileId,
        profileVersion: profile.profileVersion,
        redis: getRedisClient() ?? undefined,
      },
    });

    let tlsOptions: ToolAuthResult['tlsOptions'];
    if (appliedAuth.tlsOptions?.cert && appliedAuth.tlsOptions?.key) {
      tlsOptions = {
        cert: appliedAuth.tlsOptions.cert,
        key: appliedAuth.tlsOptions.key,
        rejectUnauthorized: true,
      };
      if (appliedAuth.tlsOptions.ca) {
        tlsOptions.ca = appliedAuth.tlsOptions.ca;
      }
    }

    let awsSigV4: ToolAuthResult['awsSigV4'];
    if (
      appliedAuth.awsCredentials?.accessKeyId &&
      appliedAuth.awsCredentials.secretAccessKey &&
      appliedAuth.awsCredentials.region
    ) {
      awsSigV4 = {
        accessKeyId: appliedAuth.awsCredentials.accessKeyId,
        secretAccessKey: appliedAuth.awsCredentials.secretAccessKey,
        region: appliedAuth.awsCredentials.region,
      };
      if (appliedAuth.awsCredentials.sessionToken) {
        awsSigV4.sessionToken = appliedAuth.awsCredentials.sessionToken;
      }
      if (appliedAuth.awsCredentials.service) {
        awsSigV4.service = appliedAuth.awsCredentials.service;
      }
    }

    const queryParams =
      appliedAuth.queryParams && Array.from(appliedAuth.queryParams.keys()).length > 0
        ? Object.fromEntries(appliedAuth.queryParams.entries())
        : undefined;

    return {
      headers: appliedAuth.headers,
      ...(queryParams ? { queryParams } : {}),
      source: 'auth_profile',
      authType: profile.authType,
      secrets: resolvedSecrets,
      ...(tlsOptions ? { tlsOptions } : {}),
      ...(appliedAuth.wsSecurityCredentials
        ? { wsSecurityCredentials: appliedAuth.wsSecurityCredentials }
        : {}),
      ...(appliedAuth.signRequest ? { signRequest: appliedAuth.signRequest } : {}),
      ...(appliedAuth.digestCredentials
        ? { digestCredentials: appliedAuth.digestCredentials }
        : {}),
      ...(awsSigV4 ? { awsSigV4 } : {}),
    };
  }

  // Fall back to inline auth (existing behavior handled by HttpToolExecutor)
  if (tool.http_binding?.auth?.type && tool.http_binding.auth.type !== 'none') {
    return { headers, source: 'inline' };
  }

  return { headers, source: 'none' };
}

async function resolveProfileSecretsForRequest(
  profile: {
    profileId: string;
    authType: string;
    profileVersion: number;
    config: Record<string, unknown>;
    secrets: Record<string, unknown>;
  },
  tenantId: string,
): Promise<Record<string, unknown>> {
  if (profile.authType === 'bearer') {
    const token =
      typeof profile.secrets.token === 'string'
        ? profile.secrets.token
        : typeof profile.secrets.apiKey === 'string'
          ? profile.secrets.apiKey
          : undefined;

    return token ? { ...profile.secrets, token } : profile.secrets;
  }

  if (
    profile.authType === 'custom_header' &&
    !profile.secrets.headerValues &&
    profile.config.headers &&
    typeof profile.config.headers === 'object'
  ) {
    return {
      ...profile.secrets,
      headerValues: profile.config.headers,
    };
  }

  if (profile.authType === 'oauth2_token') {
    const accessToken =
      typeof profile.secrets.accessToken === 'string'
        ? profile.secrets.accessToken
        : typeof profile.secrets.token === 'string'
          ? profile.secrets.token
          : undefined;

    return accessToken ? { ...profile.secrets, accessToken } : profile.secrets;
  }

  if (profile.authType !== 'oauth2_client_credentials') {
    return profile.secrets;
  }

  const tokenUrl = profile.config.tokenUrl;
  const clientId = profile.secrets.clientId;
  const clientSecret = profile.secrets.clientSecret;

  if (typeof tokenUrl !== 'string' || tokenUrl.length === 0) {
    throw new Error(
      `AUTH_PROFILE_TOKEN_URL_MISSING: oauth2_client_credentials profile "${profile.profileId}" is missing tokenUrl.`,
    );
  }
  if (typeof clientId !== 'string' || typeof clientSecret !== 'string') {
    throw new Error(
      `AUTH_PROFILE_CLIENT_CREDENTIALS_INVALID: oauth2_client_credentials profile "${profile.profileId}" is missing client credentials.`,
    );
  }

  const ssrfCheck = validateUrlForSSRF(tokenUrl, getDevSSRFOptions());
  if (!ssrfCheck.safe) {
    throw new Error(
      `AUTH_PROFILE_TOKEN_URL_BLOCKED: tokenUrl is blocked by SSRF protection for profile "${profile.profileId}".`,
    );
  }

  const scopes = normalizeScopeList(profile.config.scopes ?? profile.config.scope);
  const audience =
    typeof profile.config.audience === 'string' ? profile.config.audience.trim() : '';
  const redis = getRedisClient();
  const token = await resolveClientCredentialsToken(
    profile.profileId,
    tenantId,
    profile.profileVersion,
    tokenUrl,
    clientId,
    clientSecret,
    scopes,
    redis ? { redis, ...(audience ? { audience } : {}) } : audience ? { audience } : {},
  );

  // Strip credential fields — only the resolved accessToken belongs in ToolAuthResult.secrets.
  const {
    clientId: _cid,
    clientSecret: _cs,
    ...safeSecrets
  } = profile.secrets as Record<string, unknown>;
  return {
    ...safeSecrets,
    accessToken: token.accessToken,
    expiresAt: token.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Config Variable Resolution
// ---------------------------------------------------------------------------

const CONFIG_VAR_PATTERN = /^\{\{config\.(\w+)\}\}$/;

export interface ConfigVarStoreLike {
  findConfigVar(params: {
    tenantId: string;
    projectId: string;
    key: string;
    variableNamespaceIds?: string[];
  }): Promise<{ value: string } | null>;
}

export async function resolveAuthProfileRef(
  authProfileRef: string,
  tenantId: string,
  projectId: string,
  configVarStore?: ConfigVarStoreLike,
  variableNamespaceIds?: string[],
): Promise<string | null> {
  const match = authProfileRef.match(CONFIG_VAR_PATTERN);

  if (!match) {
    return authProfileRef;
  }

  const configKey = match[1];

  if (!configVarStore) {
    log.warn('Config variable in auth_profile_ref but no config var store available', {
      authProfileRef,
      configKey,
    });
    return null;
  }

  const result = await configVarStore.findConfigVar({
    tenantId,
    projectId,
    key: configKey,
    variableNamespaceIds,
  });

  if (!result) {
    log.warn('Config variable not found for auth_profile_ref', {
      authProfileRef,
      configKey,
      tenantId,
      projectId,
    });
    return null;
  }

  log.debug('Resolved config variable in auth_profile_ref', {
    configKey,
  });

  return result.value;
}

function extractRequestedOAuthScopes(tool: Pick<ToolDefinition, 'http_binding'>): string[] {
  const scopes = tool.http_binding?.auth?.config?.oauth?.scopes;
  if (!Array.isArray(scopes)) {
    return [];
  }

  return Array.from(
    new Set(
      scopes
        .filter((scope): scope is string => typeof scope === 'string')
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0),
    ),
  );
}

// ---------------------------------------------------------------------------
// Scope Insufficient Detection (FR-29 path B)
// ---------------------------------------------------------------------------

export interface ScopeDetectionContext {
  tenantId: string;
  projectId?: string;
  profileId?: string;
  toolName: string;
  sessionId?: string;
  userId?: string;
}

/**
 * Check an HTTP provider response for an `insufficient_scope` error.
 *
 * When detected:
 *   1. Emits a `scope_insufficient_detected` audit event (with full scope diff for admins)
 *   2. Returns a sanitized error (no tenantId, profileId, scope names, or provider details)
 *
 * Returns null if the response is not a scope error (caller should proceed normally).
 */
export async function checkProviderResponseForScopeError(
  response: ProviderResponse,
  ctx: ScopeDetectionContext,
): Promise<{
  success: false;
  error: { code: string; message: string };
} | null> {
  const scopeResult = detectInsufficientScope(response);
  if (!scopeResult) return null;

  log.warn('Insufficient scope detected from provider response', {
    toolName: ctx.toolName,
    status: response.status,
    grantedScopes: scopeResult.granted,
    missingScopes: scopeResult.missing,
  });

  // Emit detailed audit event for admin visibility
  emitAuthProfileAuditEvent({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId ?? null,
    profileId: ctx.profileId ?? '',
    eventType: 'scope_insufficient_detected',
    actorUserId: ctx.userId ?? null,
    actorContext: {
      source: 'tool_config',
      sessionId: ctx.sessionId,
    },
    eventPayload: {
      source: 'tool_call',
      requestedScopes: scopeResult.missing,
      grantedScopes: scopeResult.granted,
      missingScopes: scopeResult.missing,
      toolName: ctx.toolName,
      httpStatus: response.status,
    },
  }).catch((err: unknown) => {
    log.error('Failed to emit scope_insufficient_detected audit event', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Return sanitized error — MUST NOT include tenantId, profileId, scope names, or provider details
  return {
    success: false,
    error: {
      code: 'REAUTHORIZATION_REQUIRED',
      message: 'This action requires additional permissions. Please re-authorize.',
    },
  };
}

// ---------------------------------------------------------------------------
// AUTH_PROFILE_DELETED Error (INT-27 — clear delete-time errors at consumer call site)
// ---------------------------------------------------------------------------

export class AuthProfileDeletedError extends Error {
  readonly code = 'AUTH_PROFILE_DELETED' as const;
  readonly profileName: string;
  readonly toolName: string;

  constructor(profileName: string, toolName: string) {
    super(
      `AUTH_PROFILE_DELETED: Profile "${profileName}" has been deleted. Tool "${toolName}" cannot authenticate.`,
    );
    this.name = 'AuthProfileDeletedError';
    this.profileName = profileName;
    this.toolName = toolName;
  }
}
