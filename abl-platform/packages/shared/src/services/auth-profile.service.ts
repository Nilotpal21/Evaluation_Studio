/**
 * AuthProfile Service
 *
 * Core business logic for credential management. All methods are
 * tenant-scoped. Secrets are encrypted at rest via the Mongoose encryptionPlugin.
 */

import { createLogger } from '@agent-platform/shared-observability';
import {
  validateAddonCombination,
  validateAddonSecrets,
} from '../validation/auth-profile-addons.schema.js';
import {
  type AuthProfileUsageMode,
  type ProfileType,
  getAuthProfileUsageModeValidationError,
  getMaterializedAuthProfileValidationErrors,
  mergeOAuth2AppConfig,
  normalizeOAuth2AppConfig,
  resolveAuthProfileUsageMode,
} from '../validation/auth-profile.schema.js';
import {
  validateResolvedOAuth2TokenLinkedApp,
  AuthProfileError,
} from './auth-profile/linked-app-validator.js';
import { buildAuthProfileOAuthProviderKey } from './auth-profile/index.js';
import { validateAuthProfileUpdate } from './auth-profile/update-validator.js';
import {
  emitAuthProfileTraceEvent,
  AUTH_PROFILE_TRACE_EVENTS,
} from '@agent-platform/shared-auth-profile';

const logger = createLogger('auth-profile-service');

// ─── Types ────────────────────────────────────────────────────────────

export interface AuthProfileServiceDeps {
  model: any; // Mongoose Model<IAuthProfile>
  redis?: {
    set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
    get(key: string): Promise<string | null>;
    del(key: string): Promise<number>;
  };
}

export interface CreateAuthProfileInput {
  name: string;
  tenantId: string;
  projectId: string | null;
  scope: 'tenant' | 'project';
  visibility: 'shared' | 'personal';
  createdBy: string;
  authType: string;
  usageMode?: AuthProfileUsageMode;
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
  description?: string;
  environment?: string | null;
  linkedAppProfileId?: string;
  connector?: string;
  category?: string;
  tags?: string[];
  // Phase 1 rejections
  signing?: unknown;
  webhookVerification?: unknown;
  proxy?: unknown;
  rotationPolicy?: unknown;
}

export interface UpdateAuthProfileInput {
  id: string;
  tenantId: string;
  projectId: string;
  updates: {
    name?: string;
    description?: string | null;
    config?: Record<string, unknown>;
    secrets?: Record<string, unknown>;
    environment?: string | null;
    visibility?: 'shared' | 'personal';
    usageMode?: AuthProfileUsageMode;
    connector?: string;
    category?: string;
    tags?: string[];
    linkedAppProfileId?: string | null;
    status?: string;
  };
}

export interface DeleteAuthProfileInput {
  id: string;
  tenantId: string;
  projectId: string;
}

export interface ResolveAuthProfileInput {
  tenantId: string;
  projectId: string;
  connector: string;
  connectionMode: 'per_user' | 'shared';
  environment?: string;
  userId?: string;
  requestingUserId?: string;
  authProfileId?: string;
}

export interface ResolvedCredentials {
  profileId: string;
  authType: string;
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
}

// ─── Errors ──────────────────────────────────────────────────────────

class AuthProfileNotFoundError extends Error {
  constructor(message = 'Auth profile not found') {
    super(message);
    this.name = 'AuthProfileNotFoundError';
  }
}

class AuthProfileConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthProfileConflictError';
  }
}

// ─── Token Refresh Lock ─────────────────────────────────────────────

const LOCK_TTL_MS = 30_000;
const LOCK_PREFIX = 'auth-profile:op-lock:';
const TENANT_SHARED_OAUTH_GRANT_USER_ID = '__tenant__';
const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60_000;
const LEGACY_OAUTH2_TOKEN_READ_ONLY_MESSAGE =
  'oauth2_token profiles are legacy migration records and cannot be created, updated, refreshed, or resolved. Re-authorize the linked oauth2_app instead.';

function normalizeGrantScopes(scopeValue: unknown): string[] {
  if (typeof scopeValue !== 'string' || scopeValue.trim().length === 0) {
    return [];
  }

  return Array.from(
    new Set(
      scopeValue
        .split(/\s+/u)
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0),
    ),
  );
}

function toIsoDateString(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function isGrantExpired(expiresAt: unknown): boolean {
  const expiresAtIso = toIsoDateString(expiresAt);
  if (!expiresAtIso) {
    return false;
  }

  return new Date(expiresAtIso).getTime() <= Date.now() + ACCESS_TOKEN_EXPIRY_BUFFER_MS;
}

// ─── Service ────────────────────────────────────────────────────────

export class AuthProfileService {
  private readonly model: any;
  private readonly redis?: AuthProfileServiceDeps['redis'];

  constructor(deps: AuthProfileServiceDeps) {
    this.model = deps.model;
    this.redis = deps.redis;
  }

  // ── Create ──────────────────────────────────────────────────────────

  async create(input: CreateAuthProfileInput) {
    // Access addon fields via unknown cast (addons are not in the base discriminated union type)
    const inputAny = input as unknown as Record<string, unknown>;

    // Inline-Add deprecated per 2026-05-09 meeting retraction (FR-20)
    if (inputAny.inlineHostedTool) {
      throw new AuthProfileConflictError('AUTH_PROFILE_INLINE_DEPRECATED');
    }

    // Rotation is deferred to Phase 3
    if (inputAny.rotationPolicy) {
      throw new AuthProfileConflictError(
        'Key rotation is not yet supported. Coming in a future release.',
      );
    }

    // Validate addon combinations (e.g. aws_iam + signing is invalid)
    const addons = {
      signing: inputAny.signing,
      webhookVerification: inputAny.webhookVerification,
      proxy: inputAny.proxy,
    };
    if (addons.signing || addons.webhookVerification || addons.proxy) {
      const comboResult = validateAddonCombination(input.authType, addons);
      if (!comboResult.valid) {
        throw new AuthProfileConflictError(comboResult.reason!);
      }
      const secretsResult = validateAddonSecrets(addons, input.secrets);
      if (!secretsResult.valid) {
        throw new AuthProfileConflictError(secretsResult.reason!);
      }
    }

    if (input.authType === 'oauth2_token') {
      throw new AuthProfileConflictError(LEGACY_OAUTH2_TOKEN_READ_ONLY_MESSAGE);
    }

    if (input.linkedAppProfileId && input.authType !== 'oauth2_token') {
      throw new AuthProfileConflictError(
        'linkedAppProfileId is only valid for oauth2_token profiles.',
      );
    }

    const usageModeError = getAuthProfileUsageModeValidationError(input.authType, input.usageMode);
    if (usageModeError) {
      throw new AuthProfileConflictError(usageModeError);
    }

    const usageMode = resolveAuthProfileUsageMode(input.authType, input.usageMode);

    const normalizedConfig =
      input.authType === 'oauth2_app' ? normalizeOAuth2AppConfig(input.config) : input.config;

    const doc = await this.model.create({
      name: input.name,
      description: input.description,
      tenantId: input.tenantId,
      projectId: input.projectId,
      scope: input.scope,
      environment: input.environment ?? null,
      visibility: input.visibility,
      createdBy: input.createdBy,
      authType: input.authType,
      usageMode,
      config: normalizedConfig,
      encryptedSecrets: JSON.stringify(input.secrets),
      encryptionKeyVersion: 1,
      linkedAppProfileId: input.linkedAppProfileId,
      connector: input.connector,
      category: input.category,
      tags: input.tags,
      status: 'active',
      // Addon mechanisms (Phase 2)
      signing: inputAny.signing ?? undefined,
      webhookVerification: inputAny.webhookVerification ?? undefined,
      proxy: inputAny.proxy ?? undefined,
    });

    return doc;
  }

  // ── Update ──────────────────────────────────────────────────────────

  async update(input: UpdateAuthProfileInput) {
    const existing = await this.model.findOne({
      _id: input.id,
      tenantId: input.tenantId,
      $or: [{ projectId: null }, { projectId: input.projectId }],
    });
    if (!existing) {
      throw new AuthProfileNotFoundError(`Auth profile ${input.id} not found`);
    }

    if (existing.authType === 'oauth2_token') {
      throw new AuthProfileConflictError(LEGACY_OAUTH2_TOKEN_READ_ONLY_MESSAGE);
    }

    if (input.updates.linkedAppProfileId !== undefined || input.updates.visibility !== undefined) {
      try {
        await validateAuthProfileUpdate({
          existingProfile: {
            authType: existing.authType,
            tenantId: existing.tenantId,
            linkedAppProfileId: existing.linkedAppProfileId,
            scope: existing.scope,
            visibility: existing.visibility,
            projectId: existing.projectId ?? null,
            createdBy: existing.createdBy,
          },
          updatePayload: input.updates as Record<string, unknown>,
        });
      } catch (err) {
        if (err instanceof AuthProfileError) {
          throw new AuthProfileConflictError(err.message);
        }
        throw err;
      }
    }

    if (input.updates.usageMode !== undefined) {
      const usageModeError = getAuthProfileUsageModeValidationError(
        existing.authType,
        input.updates.usageMode,
      );
      if (usageModeError) {
        throw new AuthProfileConflictError(usageModeError);
      }
    }

    let mergedConfig: Record<string, unknown> | undefined;
    let mergedSecrets: Record<string, unknown> | undefined;
    if (input.updates.config !== undefined || input.updates.secrets !== undefined) {
      let existingSecrets: Record<string, unknown>;
      try {
        existingSecrets =
          typeof existing.encryptedSecrets === 'string'
            ? JSON.parse(existing.encryptedSecrets)
            : (existing.encryptedSecrets ?? {});
      } catch {
        throw new Error('Failed to parse existing auth profile secrets');
      }

      mergedConfig =
        input.updates.config !== undefined
          ? existing.authType === 'oauth2_app'
            ? mergeOAuth2AppConfig(
                (existing.config ?? {}) as Record<string, unknown>,
                input.updates.config,
              )
            : {
                ...((existing.config ?? {}) as Record<string, unknown>),
                ...input.updates.config,
              }
          : ((existing.config ?? {}) as Record<string, unknown>);
      mergedSecrets =
        input.updates.secrets !== undefined
          ? {
              ...existingSecrets,
              ...input.updates.secrets,
            }
          : existingSecrets;

      const validationErrors = getMaterializedAuthProfileValidationErrors(
        existing.authType,
        mergedConfig,
        mergedSecrets,
      );
      if (validationErrors.length > 0) {
        throw new AuthProfileConflictError(validationErrors.join('; '));
      }

      if (input.updates.config !== undefined && existing.authType === 'oauth2_app') {
        mergedConfig = normalizeOAuth2AppConfig(mergedConfig);
      }
    }

    const $set: Record<string, unknown> = {};

    if (input.updates.name !== undefined) $set.name = input.updates.name;
    if ('description' in input.updates) $set.description = input.updates.description;
    if (input.updates.config !== undefined) {
      $set.config = mergedConfig ?? ((existing.config ?? {}) as Record<string, unknown>);
    }
    if (input.updates.environment !== undefined) $set.environment = input.updates.environment;
    if (input.updates.visibility !== undefined) $set.visibility = input.updates.visibility;
    if (input.updates.usageMode !== undefined) $set.usageMode = input.updates.usageMode;
    if (input.updates.connector !== undefined) $set.connector = input.updates.connector;
    if (input.updates.category !== undefined) $set.category = input.updates.category;
    if (input.updates.tags !== undefined) $set.tags = input.updates.tags;
    if (input.updates.linkedAppProfileId !== undefined)
      $set.linkedAppProfileId = input.updates.linkedAppProfileId;
    if (input.updates.status !== undefined) $set.status = input.updates.status;

    // Apply updates to the document
    for (const [key, value] of Object.entries($set)) {
      (existing as any)[key] = value;
    }
    if (input.updates.secrets !== undefined) {
      existing.encryptedSecrets = JSON.stringify(mergedSecrets ?? input.updates.secrets);
    }

    await existing.save();
    return existing;
  }

  // ── Delete ──────────────────────────────────────────────────────────

  async delete(input: DeleteAuthProfileInput) {
    const existing = await this.model.findOne({
      _id: input.id,
      tenantId: input.tenantId,
      $or: [{ projectId: null }, { projectId: input.projectId }],
    });

    if (!existing) {
      throw new AuthProfileNotFoundError();
    }

    // For oauth2_app, check for linked tokens
    if (existing.authType === 'oauth2_app') {
      const consumerCount = await this.getConsumerCount(input.id, input.tenantId);
      if (consumerCount > 0) {
        throw new AuthProfileConflictError(
          `Cannot delete — ${consumerCount} active connections use this OAuth app. Revoke them first.`,
        );
      }
    }

    return this.model.findOneAndDelete({
      _id: input.id,
      tenantId: input.tenantId,
      $or: [{ projectId: null }, { projectId: input.projectId }],
    });
  }

  // ── Resolve (Grant + Profile Priority) ──────────────────────────────

  async resolve(input: ResolveAuthProfileInput): Promise<ResolvedCredentials> {
    const traceTimestamp = new Date().toISOString();
    const now = new Date();
    const perUserContextUserId = input.userId ?? input.requestingUserId;

    emitAuthProfileTraceEvent({
      eventType: AUTH_PROFILE_TRACE_EVENTS.RESOLVE_START,
      profileId: input.authProfileId ?? '',
      tenantId: input.tenantId,
      timestamp: traceTimestamp,
      metadata: {
        connector: input.connector,
        connectionMode: input.connectionMode,
        environment: input.environment,
        hasExplicitId: !!input.authProfileId,
      },
    });

    try {
      if (input.connectionMode === 'per_user' && !perUserContextUserId) {
        emitAuthProfileTraceEvent({
          eventType: AUTH_PROFILE_TRACE_EVENTS.RESOLVE_ERROR,
          profileId: input.authProfileId ?? '',
          tenantId: input.tenantId,
          timestamp: new Date().toISOString(),
          metadata: { reason: 'missing_user_context' },
        });
        throw new AuthProfileNotFoundError('Per-user auth resolution requires user context.');
      }

      // If explicit authProfileId, resolve directly
      if (input.authProfileId) {
        const explicitVisibilityFilter = perUserContextUserId
          ? {
              $or: [
                { visibility: 'shared' },
                { visibility: 'personal', createdBy: perUserContextUserId },
              ],
            }
          : { visibility: 'shared' };

        const profile = await this.model.findOne({
          _id: input.authProfileId,
          tenantId: input.tenantId,
          status: 'active',
          $and: [
            { $or: [{ projectId: null }, { projectId: input.projectId }] },
            { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
            explicitVisibilityFilter,
          ],
        });

        if (!profile) {
          emitAuthProfileTraceEvent({
            eventType: AUTH_PROFILE_TRACE_EVENTS.RESOLVE_ERROR,
            profileId: input.authProfileId,
            tenantId: input.tenantId,
            timestamp: new Date().toISOString(),
            metadata: { reason: 'not_accessible' },
          });
          throw new AuthProfileNotFoundError('Auth profile not accessible from this project.');
        }

        const credentials = await this.extractConnectorCredentials(profile, {
          connectionMode: input.connectionMode,
          userId: perUserContextUserId,
        });
        if (!credentials) {
          emitAuthProfileTraceEvent({
            eventType: AUTH_PROFILE_TRACE_EVENTS.RESOLVE_ERROR,
            profileId: input.authProfileId,
            tenantId: input.tenantId,
            timestamp: new Date().toISOString(),
            metadata: {
              reason:
                profile.authType === 'oauth2_app'
                  ? 'oauth_grant_unavailable'
                  : profile.authType === 'oauth2_token'
                    ? 'legacy_oauth2_token_unsupported'
                    : 'linked_app_invalid',
            },
          });
          throw new AuthProfileNotFoundError('Auth profile not accessible from this project.');
        }
        emitAuthProfileTraceEvent({
          eventType: AUTH_PROFILE_TRACE_EVENTS.RESOLVE_SUCCESS,
          profileId: credentials.profileId,
          tenantId: input.tenantId,
          authType: credentials.authType,
          timestamp: new Date().toISOString(),
          metadata: { resolveMethod: 'explicit_id' },
        });
        return credentials;
      }

      const visibilityFilter =
        input.connectionMode === 'shared'
          ? ({ visibility: 'shared' } as const)
          : perUserContextUserId
            ? ({
                $or: [
                  { visibility: 'shared' },
                  { visibility: 'personal', createdBy: perUserContextUserId },
                ],
              } as const)
            : ({ visibility: 'shared' } as const);

      const baseFilter = {
        tenantId: input.tenantId,
        status: 'active',
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      };

      const candidateQueries: Array<{
        filter: Record<string, unknown>;
        resolveMethod: 'priority_match' | 'fallback';
        kind: 'oauth_grant_profile' | 'auth_profile';
      }> = [];

      const pushOAuthGrantCandidates = (
        scopeFilter: Record<string, unknown>,
        environmentFilter: Record<string, unknown>,
        resolveMethod: 'priority_match' | 'fallback',
      ) => {
        const sharedFilter = {
          ...scopeFilter,
          connector: input.connector,
          authType: 'oauth2_app',
          visibility: 'shared',
          ...environmentFilter,
        };

        if (input.connectionMode === 'per_user' && perUserContextUserId) {
          candidateQueries.push({
            filter: {
              ...scopeFilter,
              connector: input.connector,
              authType: 'oauth2_app',
              visibility: 'personal',
              createdBy: perUserContextUserId,
              ...environmentFilter,
            },
            resolveMethod,
            kind: 'oauth_grant_profile',
          });
        }

        candidateQueries.push({
          filter: sharedFilter,
          resolveMethod,
          kind: 'oauth_grant_profile',
        });
      };

      const pushNonOAuthAppProfileCandidate = (
        scopeFilter: Record<string, unknown>,
        environmentFilter: Record<string, unknown>,
        resolveMethod: 'priority_match' | 'fallback',
      ) => {
        candidateQueries.push({
          filter: {
            ...scopeFilter,
            connector: input.connector,
            authType: { $nin: ['oauth2_app', 'oauth2_token'] },
            ...environmentFilter,
            ...visibilityFilter,
          },
          resolveMethod,
          kind: 'auth_profile',
        });
      };

      // Level 1: project-scoped OAuth grants backed by oauth2_app profiles
      pushOAuthGrantCandidates(
        { projectId: input.projectId },
        input.environment ? { environment: input.environment } : {},
        'priority_match',
      );

      // Level 2: project-level env-specific non-oauth app profile
      if (input.environment) {
        pushNonOAuthAppProfileCandidate(
          { projectId: input.projectId },
          { environment: input.environment },
          'priority_match',
        );

        // Level 3: project-level default OAuth grant backed by oauth2_app
        pushOAuthGrantCandidates(
          { projectId: input.projectId },
          { environment: null },
          'priority_match',
        );
      }

      // Level 4: project-level default non-oauth app profile
      pushNonOAuthAppProfileCandidate(
        { projectId: input.projectId },
        { environment: null },
        'priority_match',
      );

      // Level 5: tenant-level env-specific OAuth grant fallback
      if (input.environment) {
        pushOAuthGrantCandidates(
          { projectId: null },
          { environment: input.environment },
          'fallback',
        );
        pushNonOAuthAppProfileCandidate(
          { projectId: null },
          { environment: input.environment },
          'fallback',
        );
      }

      // Level 6: tenant-level default fallback
      pushOAuthGrantCandidates({ projectId: null }, { environment: null }, 'fallback');
      pushNonOAuthAppProfileCandidate({ projectId: null }, { environment: null }, 'fallback');

      let resolved: any | null = null;
      let credentials: ResolvedCredentials | null = null;
      let resolveMethod: 'priority_match' | 'fallback' = 'priority_match';

      for (const candidate of candidateQueries) {
        const matchedProfile = await this.model.findOne({
          ...baseFilter,
          ...candidate.filter,
        });
        if (!matchedProfile) {
          continue;
        }

        const matchedCredentials =
          candidate.kind === 'oauth_grant_profile'
            ? await this.extractDurableOAuthGrantCredentials(matchedProfile, {
                connectionMode: input.connectionMode,
                userId: perUserContextUserId,
              })
            : await this.extractConnectorCredentials(matchedProfile, {
                connectionMode: input.connectionMode,
                userId: perUserContextUserId,
              });
        if (!matchedCredentials) {
          continue;
        }

        resolved = matchedProfile;
        credentials = matchedCredentials;
        resolveMethod = candidate.resolveMethod;
        break;
      }

      if (!resolved || !credentials) {
        emitAuthProfileTraceEvent({
          eventType: AUTH_PROFILE_TRACE_EVENTS.RESOLVE_ERROR,
          profileId: '',
          tenantId: input.tenantId,
          timestamp: new Date().toISOString(),
          metadata: { reason: 'no_profile_found', connector: input.connector },
        });
        throw new AuthProfileNotFoundError(
          `No auth profile found for connector '${input.connector}'.`,
        );
      }

      // Detect fallback: if resolved profile is tenant-level but request was project-scoped
      const isFallback = resolved.projectId === null && input.projectId !== null;
      if (isFallback) {
        emitAuthProfileTraceEvent({
          eventType: AUTH_PROFILE_TRACE_EVENTS.RESOLVE_FALLBACK,
          profileId: credentials.profileId,
          tenantId: input.tenantId,
          authType: credentials.authType,
          timestamp: new Date().toISOString(),
          metadata: {
            connector: input.connector,
            requestedProjectId: input.projectId,
            resolvedScope: 'tenant',
          },
        });
      }

      emitAuthProfileTraceEvent({
        eventType: AUTH_PROFILE_TRACE_EVENTS.RESOLVE_SUCCESS,
        profileId: credentials.profileId,
        tenantId: input.tenantId,
        authType: credentials.authType,
        timestamp: new Date().toISOString(),
        metadata: { resolveMethod: isFallback ? 'fallback' : resolveMethod },
      });

      return credentials;
    } catch (err) {
      // Only emit RESOLVE_ERROR for unexpected errors (not NotFoundError which is already traced above)
      if (!(err instanceof AuthProfileNotFoundError)) {
        emitAuthProfileTraceEvent({
          eventType: AUTH_PROFILE_TRACE_EVENTS.RESOLVE_ERROR,
          profileId: input.authProfileId ?? '',
          tenantId: input.tenantId,
          timestamp: new Date().toISOString(),
          metadata: {
            reason: 'unexpected_error',
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
      throw err;
    }
  }

  // ── Validate Access ─────────────────────────────────────────────────

  async validateAccess(authProfileId: string, tenantId: string, projectId: string) {
    const profile = await this.model.findOne({
      _id: authProfileId,
      tenantId,
      $or: [
        { projectId: null }, // tenant-level: accessible by all projects
        { projectId }, // project-level: must match
      ],
    });

    if (!profile) {
      throw new AuthProfileNotFoundError();
    }

    return profile;
  }

  // ── Get Consumer Count ──────────────────────────────────────────────

  async getConsumerCount(profileId: string, tenantId: string): Promise<number> {
    const legacyProfileConsumers = await this.model.countDocuments({
      linkedAppProfileId: profileId,
      tenantId,
    });

    const { EndUserOAuthToken } = await import('@agent-platform/database/models');
    const durableGrantConsumers = await (
      EndUserOAuthToken as {
        countDocuments(filter: Record<string, unknown>): Promise<number>;
      }
    ).countDocuments({
      tenantId,
      provider: buildAuthProfileOAuthProviderKey(profileId),
      revokedAt: null,
    });

    return legacyProfileConsumers + durableGrantConsumers;
  }

  // ── Token Refresh with Distributed Lock ─────────────────────────────

  async refreshToken(profileId: string, tenantId: string): Promise<ResolvedCredentials> {
    const lockKey = `${LOCK_PREFIX}${tenantId}:${profileId}`;
    let lockAcquired = false;

    if (this.redis) {
      try {
        const result = await this.redis.set(lockKey, '1', 'NX', 'PX', String(LOCK_TTL_MS));
        lockAcquired = result === 'OK';
      } catch (err) {
        logger.warn('auth_profile_lock_unavailable', {
          profileId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    try {
      const profile = await this.model.findOne({
        _id: profileId,
        tenantId,
      });

      if (!profile) {
        throw new AuthProfileNotFoundError();
      }

      if (profile.authType === 'oauth2_token') {
        throw new AuthProfileConflictError(LEGACY_OAUTH2_TOKEN_READ_ONLY_MESSAGE);
      }

      const credentials = await this.extractCredentials(profile);
      if (!credentials) {
        throw new AuthProfileConflictError(
          'OAuth token profile is no longer valid because its linked OAuth app is unavailable.',
        );
      }

      return credentials;
    } finally {
      if (lockAcquired && this.redis) {
        await this.redis.del(lockKey).catch((err) => {
          logger.warn('auth_profile_lock_release_failed', {
            lockKey,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
  }

  // ── Internal ────────────────────────────────────────────────────────

  private async extractCredentials(profile: any): Promise<ResolvedCredentials | null> {
    if (profile.authType === 'oauth2_token') {
      try {
        await validateResolvedOAuth2TokenLinkedApp({
          profileId: String(profile._id),
          tenantId: profile.tenantId,
          linkedAppProfileId: profile.linkedAppProfileId,
          scope: profile.scope,
          visibility: profile.visibility,
          projectId: profile.projectId ?? null,
          createdBy: profile.createdBy,
        });
      } catch (err) {
        if (err instanceof AuthProfileError) {
          logger.warn('auth_profile_linked_app_invalid', {
            profileId: profile._id,
            linkedAppProfileId: profile.linkedAppProfileId,
            error: err.message,
          });
          return null;
        }
        throw err;
      }
    }

    let secrets: Record<string, unknown>;
    if (typeof profile.encryptedSecrets === 'string') {
      try {
        secrets = JSON.parse(profile.encryptedSecrets);
      } catch {
        secrets = { _raw: profile.encryptedSecrets };
      }
    } else if (typeof profile.encryptedSecrets === 'object' && profile.encryptedSecrets !== null) {
      secrets = profile.encryptedSecrets;
    } else {
      secrets = {};
    }

    return {
      profileId: profile._id,
      authType: profile.authType,
      config: profile.config ?? {},
      secrets,
    };
  }

  private async extractConnectorCredentials(
    profile: any,
    context: {
      connectionMode: ResolveAuthProfileInput['connectionMode'];
      userId?: string;
    },
  ): Promise<ResolvedCredentials | null> {
    if (profile.authType === 'oauth2_token') {
      logger.info('legacy_oauth2_token_resolution_skipped', {
        profileId: profile._id,
        linkedAppProfileId: profile.linkedAppProfileId,
      });
      return null;
    }

    if (profile.authType === 'oauth2_app') {
      return this.extractDurableOAuthGrantCredentials(profile, context);
    }

    return this.extractCredentials(profile);
  }

  private async extractDurableOAuthGrantCredentials(
    profile: any,
    context: {
      connectionMode: ResolveAuthProfileInput['connectionMode'];
      userId?: string;
    },
  ): Promise<ResolvedCredentials | null> {
    if (profile.authType !== 'oauth2_app') {
      return null;
    }

    // Use the profile's own connectionMode for grant lookup. Fall back to
    // the caller-provided connectionMode for backward compatibility with
    // profiles that predate the connectionMode field.
    const effectiveMode: 'shared' | 'per_user' = profile.connectionMode ?? context.connectionMode;
    const grantUserId =
      effectiveMode === 'shared' ? TENANT_SHARED_OAUTH_GRANT_USER_ID : context.userId;
    if (!grantUserId) {
      return null;
    }

    const provider = buildAuthProfileOAuthProviderKey(String(profile._id));
    const { EndUserOAuthToken } = await import('@agent-platform/database/models');
    const grant = await (
      EndUserOAuthToken as {
        findOne(
          filter: Record<string, unknown>,
          projection: Record<string, number>,
        ): Promise<{
          encryptedAccessToken?: string | null;
          encryptedRefreshToken?: string | null;
          scope?: string | null;
          expiresAt?: Date | string | null;
        } | null>;
      }
    ).findOne(
      {
        tenantId: profile.tenantId,
        userId: grantUserId,
        provider,
        revokedAt: null,
      },
      {
        encryptedAccessToken: 1,
        encryptedRefreshToken: 1,
        scope: 1,
        expiresAt: 1,
      },
    );

    if (!grant) {
      return null;
    }

    if (
      typeof grant.encryptedAccessToken !== 'string' ||
      grant.encryptedAccessToken.trim().length === 0
    ) {
      logger.warn('oauth_grant_missing_access_token', {
        authProfileId: profile._id,
        provider,
        grantUserId,
      });
      return null;
    }

    if (isGrantExpired(grant.expiresAt)) {
      logger.warn('oauth_grant_expired_during_resolution', {
        authProfileId: profile._id,
        provider,
        grantUserId,
        expiresAt: toIsoDateString(grant.expiresAt),
      });
      return null;
    }

    const grantedScopes = normalizeGrantScopes(grant.scope);
    const expiresAt = toIsoDateString(grant.expiresAt);

    return {
      profileId: String(profile._id),
      authType: 'oauth2_token',
      config: {
        provider,
        tokenType: 'bearer',
        ...(grantedScopes.length > 0 ? { grantedScopes } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      },
      secrets: {
        accessToken: grant.encryptedAccessToken,
        ...(typeof grant.encryptedRefreshToken === 'string' &&
        grant.encryptedRefreshToken.trim().length > 0
          ? { refreshToken: grant.encryptedRefreshToken }
          : {}),
      },
    };
  }
}

// ─── Backward-Compatible Read Helpers ──────────────────────────────

/**
 * Derive `profileType` for legacy rows that were created before the field existed.
 * Defense-in-depth alongside the Phase 1 migration script.
 */
export function deriveProfileType(profile: {
  profileType?: ProfileType | null;
  connector?: string | null;
}): ProfileType {
  if (profile.profileType === 'integration' || profile.profileType === 'custom') {
    return profile.profileType;
  }
  return profile.connector ? 'integration' : 'custom';
}

/**
 * Injectable dependencies for computeIsAuthorized.
 * When omitted, the function uses the default dynamic import from
 * `@agent-platform/database/models`.
 */
export interface ComputeIsAuthorizedDeps {
  findOne(
    filter: Record<string, unknown>,
    projection: Record<string, number>,
  ): Promise<{ _id: string } | null>;
}

/**
 * Compute the `isAuthorized` flag for a given auth profile and user.
 *
 * - For `usageMode === 'preconfigured'`: authorized when `encryptedSecrets` is present
 * - For `usageMode` of `'jit'`, `'preflight'`, or `'user_token'`: authorized when
 *   an `EndUserOAuthToken` row exists for the (tenantId, projectId, userId, provider) tuple
 * - If no userId is available for user-scoped modes, returns false
 *
 * @param profile The auth profile document (or partial)
 * @param ctx     Tenant/project/user context
 * @param deps    Optional DI — pass `{ findOne }` to avoid the dynamic import
 */
export async function computeIsAuthorized(
  profile: {
    _id?: string;
    usageMode?: string;
    encryptedSecrets?: string | null;
    authType?: string;
    status?: string;
    visibility?: 'shared' | 'personal';
  },
  ctx: {
    tenantId: string;
    projectId: string | null;
    userId?: string;
  },
  deps?: ComputeIsAuthorizedDeps,
): Promise<boolean> {
  const usageMode = profile.usageMode ?? 'preconfigured';
  if (['pending_authorization', 'revoked', 'expired', 'invalid'].includes(profile.status ?? '')) {
    return false;
  }

  if (profile.authType === 'oauth2_app') {
    const grantUserId =
      profile.visibility === 'personal' ? ctx.userId : TENANT_SHARED_OAUTH_GRANT_USER_ID;
    if (!grantUserId) {
      return false;
    }

    try {
      const findOne = deps
        ? deps.findOne
        : async (filter: Record<string, unknown>, projection: Record<string, number>) => {
            const { EndUserOAuthToken } = await import('@agent-platform/database/models');
            return (
              EndUserOAuthToken as {
                findOne(
                  filter: Record<string, unknown>,
                  projection: Record<string, number>,
                ): Promise<{ _id: string } | null>;
              }
            ).findOne(filter, projection);
          };

      const provider = buildAuthProfileOAuthProviderKey(String(profile._id ?? ''));
      const token = await findOne(
        {
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          userId: grantUserId,
          provider,
          revokedAt: null,
        },
        { _id: 1 },
      );
      return token !== null;
    } catch (err) {
      logger.warn('compute_is_authorized_lookup_failed', {
        profileId: profile._id,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  if (usageMode === 'preconfigured') {
    // For preconfigured profiles, check that encrypted secrets exist
    return (
      typeof profile.encryptedSecrets === 'string' && profile.encryptedSecrets.trim().length > 0
    );
  }

  // For jit, preflight, user_token: check EndUserOAuthToken
  if (usageMode === 'jit' || usageMode === 'preflight' || usageMode === 'user_token') {
    if (!ctx.userId) {
      return false;
    }

    try {
      let findOne: ComputeIsAuthorizedDeps['findOne'];
      if (deps) {
        findOne = deps.findOne;
      } else {
        const { EndUserOAuthToken } = await import('@agent-platform/database/models');
        findOne = (filter, projection) =>
          (
            EndUserOAuthToken as {
              findOne(
                filter: Record<string, unknown>,
                projection: Record<string, number>,
              ): Promise<{ _id: string } | null>;
            }
          ).findOne(filter, projection);
      }

      const provider = buildAuthProfileOAuthProviderKey(String(profile._id ?? ''));
      const token = await findOne(
        {
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          userId: ctx.userId,
          provider,
          revokedAt: null,
        },
        { _id: 1 },
      );
      return token !== null;
    } catch (err) {
      logger.warn('compute_is_authorized_lookup_failed', {
        profileId: profile._id,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  return false;
}
