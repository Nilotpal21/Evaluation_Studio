/**
 * Tool OAuth Service
 *
 * Manages the OAuth 2.0 authorization code flow for end-user tool access
 * (Google Calendar, Slack, Microsoft Graph, etc.).
 *
 * Handles: flow initiation, callback code exchange, token storage/retrieval,
 * automatic refresh on expiry, and revocation.
 *
 * Tokens are encrypted at rest with tenant-scoped AES-256-GCM keys.
 */

import crypto from 'crypto';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';
import {
  isDEKEnvelopeFormat,
  type TenantEncryptionAADContext,
} from '@agent-platform/shared-encryption';
import { createLogger } from '@abl/compiler/platform';
import type { ResolvedAuthProfileOAuthProvider } from './auth-profile/auth-profile-oauth-resolver.js';
import { AUTH_PROFILE_OAUTH_PROVIDER_ID } from './auth-profile/auth-profile-oauth-resolver.js';

/**
 * AAD contexts for tenant-encryption symmetry with the Mongoose
 * encryption plugin on EndUserOAuthToken / SessionOAuthArtifact.
 *
 * The Mongoose plugin's pre-save hook encrypts these fields with AAD
 * `(tenantId, <collection>, <field>)`. Manual encrypt/decrypt outside the
 * plugin must use the same context, otherwise GCM auth-tag verification
 * fails on read across processes.
 */
const END_USER_AAD_ACCESS: TenantEncryptionAADContext = {
  resourceType: 'end_user_oauth_tokens',
  fieldName: 'encryptedAccessToken',
};
const END_USER_AAD_REFRESH: TenantEncryptionAADContext = {
  resourceType: 'end_user_oauth_tokens',
  fieldName: 'encryptedRefreshToken',
};
const SESSION_AAD_ACCESS: TenantEncryptionAADContext = {
  resourceType: 'session_oauth_artifacts',
  fieldName: 'encryptedAccessToken',
};
const SESSION_AAD_REFRESH: TenantEncryptionAADContext = {
  resourceType: 'session_oauth_artifacts',
  fieldName: 'encryptedRefreshToken',
};

const log = createLogger('tool-oauth-service');

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  scopes: string[];
}

export interface OAuthTokenRecord {
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  scope: string;
  expiresAt: Date | null;
  version?: number;
}

export type OAuthTokenMutation = { kind: 'upsert'; token: OAuthTokenRecord } | { kind: 'revoke' };

export type OAuthPrincipalScope = 'user' | 'tenant' | 'session';

export interface OAuthTokenCompareAndSwapParams {
  tenantId: string;
  userId: string;
  provider: string;
  expectedVersion: number | null;
  next: OAuthTokenMutation;
}

/**
 * Pluggable store interface for OAuth tokens (decoupled from DB for testability).
 */
export interface OAuthTokenStore {
  findToken(tenantId: string, userId: string, provider: string): Promise<OAuthTokenRecord | null>;
  upsertToken(params: {
    tenantId: string;
    userId: string;
    provider: string;
    encryptedAccessToken: string;
    encryptedRefreshToken?: string | null;
    scope: string;
    expiresAt?: Date | null;
  }): Promise<void>;
  compareAndSwapToken(params: OAuthTokenCompareAndSwapParams): Promise<boolean>;
  markRevoked(tenantId: string, userId: string, provider: string): Promise<void>;
  updateLastUsed(tenantId: string, userId: string, provider: string): Promise<void>;
}

export interface SessionOAuthArtifactRecord extends OAuthTokenRecord {
  sessionId: string;
  channelId?: string | null;
  authProfileId?: string | null;
  authProfileRef?: string | null;
  sessionExpiresAt: Date;
}

export interface SessionOAuthArtifactCompareAndSwapParams {
  tenantId: string;
  projectId: string;
  sessionPrincipal: string;
  sessionId: string;
  provider: string;
  expectedVersion: number | null;
  next: OAuthTokenMutation;
  channelId?: string;
  authProfileId?: string;
  authProfileRef?: string;
  sessionExpiresAt: Date;
}

export interface SessionOAuthArtifactStore {
  findToken(params: {
    tenantId: string;
    projectId: string;
    sessionPrincipal: string;
    provider: string;
  }): Promise<SessionOAuthArtifactRecord | null>;
  upsertToken(params: {
    tenantId: string;
    projectId: string;
    sessionPrincipal: string;
    sessionId: string;
    provider: string;
    channelId?: string;
    authProfileId?: string;
    authProfileRef?: string;
    encryptedAccessToken: string;
    encryptedRefreshToken?: string | null;
    scope: string;
    expiresAt?: Date | null;
    sessionExpiresAt: Date;
  }): Promise<void>;
  compareAndSwapToken(params: SessionOAuthArtifactCompareAndSwapParams): Promise<boolean>;
  deleteBySessionId(sessionId: string): Promise<number>;
  updateLastUsed(params: {
    tenantId: string;
    projectId: string;
    sessionPrincipal: string;
    provider: string;
  }): Promise<void>;
}

/**
 * Pluggable encryption interface (tenant-scoped).
 *
 * Both methods accept an optional AAD context. When this service writes
 * to EndUserOAuthToken or SessionOAuthArtifact via Mongoose, the encryption
 * plugin's pre-save hook encrypts with AAD `(tenantId, <collection>, <field>)`.
 * Reads through `findOne(...).lean()` skip the plugin's post-find hook, so
 * manual decrypts must pass the same AAD context to GCM-verify successfully.
 */
export interface OAuthEncryptor {
  encryptForTenant(
    plaintext: string,
    tenantId: string,
    context?: TenantEncryptionAADContext,
  ): Promise<string>;
  decryptForTenant(
    encrypted: string,
    tenantId: string,
    context?: TenantEncryptionAADContext,
  ): Promise<string>;
}

/**
 * Pluggable interface for Auth Profile OAuth token resolution.
 * ToolOAuthService checks auth profiles before falling through to the
 * legacy EndUserOAuthToken store.
 */
export interface AuthProfileOAuthResolver {
  resolveProvider(params: {
    tenantId: string;
    userId?: string;
    provider: string;
    projectId?: string;
    environment?: string;
    scopes?: string[];
    lookupScope?: 'user' | 'tenant';
  }): Promise<ResolvedAuthProfileOAuthProvider | null>;
  resolveProviderById?(params: {
    tenantId: string;
    authProfileId: string;
    authProfileRef: string;
    scopes?: string[];
  }): Promise<ResolvedAuthProfileOAuthProvider | null>;
}

/** Pending OAuth state data */
export interface PendingOAuthState {
  provider: string;
  tenantId: string;
  /**
   * Deprecated legacy principal identifier. New callers must use
   * principalScope/principalId so callback handling does not infer session
   * scope from a pseudo-user id.
   */
  userId?: string;
  principalScope?: OAuthPrincipalScope;
  principalId?: string;
  sessionPrincipal?: string;
  /**
   * Canonical public session identifier for session-scoped OAuth state.
   */
  sessionId?: string;
  sessionExpiresAt?: number;
  redirectUri: string;
  expiresAt: number;
  tokenProviderKey?: string;
  authProfileId?: string;
  authProfileRef?: string;
  projectId?: string;
  channelId?: string;
  environment?: string;
  requestedScopes?: string[];
  jitMetadata?: JitOAuthMetadata;
}

interface ResolvedProviderContext {
  providerKey: string;
  config?: OAuthProviderConfig;
  authProfileId?: string;
  authProfileRef?: string;
}

type PendingOAuthStateWithLegacyAlias = PendingOAuthState & {
  runtimeSessionId?: string;
};

interface AccessTokenLookupOptions {
  projectId?: string;
  environment?: string;
  scopes?: string[];
  lookupScope?: 'user' | 'tenant';
  preferAuthProfile?: boolean;
  authScope?: OAuthPrincipalScope;
}

/**
 * Pluggable store interface for OAuth pending states.
 * Decoupled from storage backend for testability and multi-pod support.
 */
export interface OAuthStateStore {
  /** Store a pending state with its associated data. */
  set(state: string, data: PendingOAuthState): Promise<void>;
  /** Retrieve and atomically delete a pending state. Returns null if not found. */
  getAndDelete(state: string): Promise<PendingOAuthState | null>;
}

function normalizePendingOAuthState(raw: unknown): PendingOAuthState | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const parsed = raw as Record<string, unknown>;
  if (
    typeof parsed.provider !== 'string' ||
    typeof parsed.tenantId !== 'string' ||
    typeof parsed.redirectUri !== 'string' ||
    typeof parsed.expiresAt !== 'number'
  ) {
    return null;
  }

  const hasExplicitPrincipal =
    typeof parsed.principalScope === 'string' && typeof parsed.principalId === 'string';
  const hasLegacyPrincipal = typeof parsed.userId === 'string';
  if (!hasExplicitPrincipal && !hasLegacyPrincipal) {
    return null;
  }

  const legacyCompatible = parsed as PendingOAuthStateWithLegacyAlias & Record<string, unknown>;
  const sessionId =
    typeof legacyCompatible.sessionId === 'string'
      ? legacyCompatible.sessionId
      : typeof legacyCompatible.runtimeSessionId === 'string'
        ? legacyCompatible.runtimeSessionId
        : undefined;

  const { runtimeSessionId: _legacyRuntimeSessionId, ...rest } = legacyCompatible;

  return {
    ...(rest as PendingOAuthState),
    ...(sessionId ? { sessionId } : {}),
  };
}

/** Maximum pending states to prevent memory exhaustion (in-memory store only) */
const MAX_PENDING_STATES = 10000;

/** Cleanup interval for expired pending states (in-memory store only) */
const CLEANUP_INTERVAL_MS = 60_000; // 1 minute

/** Redis key prefix for OAuth pending states */
const REDIS_STATE_PREFIX = 'oauth_state:';

/**
 * Minimal Redis client interface for OAuth state storage.
 * Uses positional args for ioredis compatibility (the runtime uses ioredis).
 */
export interface OAuthRedisClient {
  get(key: string): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  del(key: string | string[]): Promise<number>;
}

/**
 * In-memory implementation of OAuthStateStore.
 * Suitable for single-pod deployments and testing.
 */
export class InMemoryOAuthStateStore implements OAuthStateStore {
  private pendingStates = new Map<string, PendingOAuthState>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanupExpiredStates(), CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer && typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  async set(state: string, data: PendingOAuthState): Promise<void> {
    if (this.pendingStates.size >= MAX_PENDING_STATES) {
      log.warn('Pending OAuth states at capacity, evicting oldest entries', {
        count: this.pendingStates.size,
      });
      this.evictOldestStates(Math.floor(MAX_PENDING_STATES / 10));
    }
    this.pendingStates.set(state, data);
  }

  async getAndDelete(state: string): Promise<PendingOAuthState | null> {
    const data = this.pendingStates.get(state) ?? null;
    if (data) {
      this.pendingStates.delete(state);
    }
    return data;
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private cleanupExpiredStates(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [state, entry] of this.pendingStates) {
      if (entry.expiresAt < now) {
        this.pendingStates.delete(state);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      log.debug('Cleaned up expired OAuth states', {
        count: cleaned,
        remaining: this.pendingStates.size,
      });
    }
  }

  private evictOldestStates(count: number): void {
    const entries = Array.from(this.pendingStates.entries()).sort(
      (a, b) => a[1].expiresAt - b[1].expiresAt,
    );
    for (let i = 0; i < Math.min(count, entries.length); i++) {
      this.pendingStates.delete(entries[i][0]);
    }
  }
}

/**
 * Redis-backed implementation of OAuthStateStore.
 * Stores states as JSON with TTL for automatic cleanup.
 * Safe for multi-pod deployments — any pod can consume any state.
 */
export class RedisOAuthStateStore implements OAuthStateStore {
  constructor(private redis: OAuthRedisClient) {}

  async set(state: string, data: PendingOAuthState): Promise<void> {
    const ttlSeconds = Math.ceil((data.expiresAt - Date.now()) / 1000);
    if (ttlSeconds <= 0) return; // already expired
    try {
      await this.redis.set(`${REDIS_STATE_PREFIX}${state}`, JSON.stringify(data), 'EX', ttlSeconds);
    } catch (error) {
      log.error('Failed to store OAuth state in Redis', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  async getAndDelete(state: string): Promise<PendingOAuthState | null> {
    // Validate state format before hitting Redis (valid states are 64 hex chars)
    if (!/^[a-f0-9]{64}$/.test(state)) return null;
    const key = `${REDIS_STATE_PREFIX}${state}`;
    try {
      // Atomic get-and-delete (Redis >= 6.2) — consistent with sso-state-store.ts
      const raw = await this.redis.getdel(key);
      if (!raw) return null;
      const normalizedState = normalizePendingOAuthState(JSON.parse(raw));
      if (!normalizedState) {
        log.warn('Invalid OAuth state data in Redis', { key });
        return null;
      }
      return normalizedState;
    } catch (error) {
      log.error('Failed to retrieve OAuth state from Redis', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error; // let caller distinguish "not found" from "storage error"
    }
  }
}

/** JIT metadata stored alongside OAuth state for callback routing */
export interface JitOAuthMetadata {
  sessionId: string;
  toolCallId: string;
  /** Timestamp when this metadata was stored (for TTL eviction) */
  createdAt: number;
}

export interface OAuthCallbackResult {
  jitMetadata?: JitOAuthMetadata;
}

/** Maximum JIT metadata entries to prevent memory exhaustion */
const MAX_JIT_METADATA_ENTRIES = 1000;

/** TTL for JIT metadata entries (matches OAuth state expiry: 10 minutes) */
const JIT_METADATA_TTL_MS = 10 * 60 * 1000;

/** Cleanup interval for expired JIT metadata */
const JIT_METADATA_CLEANUP_INTERVAL_MS = 60_000;

/** Backstop TTL for session-scoped OAuth artifacts (matches current SDK session TTL). */
const SESSION_SCOPED_OAUTH_ARTIFACT_TTL_MS = 4 * 60 * 60 * 1000;
const END_USER_OAUTH_TOKEN_RESOURCE_TYPE = 'end_user_oauth_tokens';
const SESSION_OAUTH_ARTIFACT_RESOURCE_TYPE = 'session_oauth_artifacts';
type OAuthTokenCipherField = 'encryptedAccessToken' | 'encryptedRefreshToken';

function normalizeScopes(scopes?: string[] | null): string[] {
  if (!scopes || scopes.length === 0) {
    return [];
  }

  return Array.from(
    new Set(scopes.map((scope) => scope.trim()).filter((scope) => scope.length > 0)),
  );
}

interface ResolvedPendingPrincipal {
  scope: OAuthPrincipalScope;
  principalId: string;
  sessionPrincipal?: string;
  sessionId?: string;
  sessionExpiresAt?: number;
}

function resolvePendingStateSessionId(pending: PendingOAuthState): string | undefined {
  return pending.sessionId;
}

function resolvePendingPrincipal(pending: PendingOAuthState): ResolvedPendingPrincipal {
  if (pending.principalScope && pending.principalId) {
    const sessionId = resolvePendingStateSessionId(pending);

    return {
      scope: pending.principalScope,
      principalId: pending.principalId,
      ...(pending.sessionPrincipal ? { sessionPrincipal: pending.sessionPrincipal } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(typeof pending.sessionExpiresAt === 'number'
        ? { sessionExpiresAt: pending.sessionExpiresAt }
        : {}),
    };
  }

  if (typeof pending.userId === 'string') {
    log.warn('Rejecting legacy OAuth state without explicit principal metadata', {
      tenantId: pending.tenantId,
      provider: pending.provider,
    });
  }

  throw new AppError('Invalid or expired OAuth state', { ...ErrorCodes.BAD_REQUEST });
}

function shouldPersistLegacyUserId(scope: OAuthPrincipalScope): boolean {
  return scope === 'user';
}

function isSessionOAuthArtifactRecord(
  record: OAuthTokenRecord | SessionOAuthArtifactRecord | null,
): record is SessionOAuthArtifactRecord {
  return !!record && 'sessionId' in record && 'sessionExpiresAt' in record;
}

function resolveSessionArtifactExpiry(expiresAtEpochMs?: number, now = Date.now()): Date {
  if (
    typeof expiresAtEpochMs === 'number' &&
    Number.isFinite(expiresAtEpochMs) &&
    expiresAtEpochMs > now
  ) {
    return new Date(expiresAtEpochMs);
  }

  return new Date(now + SESSION_SCOPED_OAUTH_ARTIFACT_TTL_MS);
}

function parseGrantedScopes(scopeValue?: string | null): Set<string> {
  if (!scopeValue) {
    return new Set();
  }

  return new Set(
    scopeValue
      .split(/[\s,]+/)
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0),
  );
}

function hasRequiredScopes(
  grantedScope: string | null | undefined,
  requiredScopes?: string[],
): boolean {
  const normalizedRequiredScopes = normalizeScopes(requiredScopes);
  if (normalizedRequiredScopes.length === 0) {
    return true;
  }

  const grantedScopes = parseGrantedScopes(grantedScope);
  if (grantedScopes.size === 0) {
    return false;
  }

  return normalizedRequiredScopes.every((scope) => grantedScopes.has(scope));
}

function resolveOAuthTokenDecryptContext(
  authScope: OAuthPrincipalScope | undefined,
  fieldName: OAuthTokenCipherField,
): TenantEncryptionAADContext {
  return {
    resourceType:
      authScope === 'session'
        ? SESSION_OAUTH_ARTIFACT_RESOURCE_TYPE
        : END_USER_OAUTH_TOKEN_RESOURCE_TYPE,
    fieldName,
  };
}

export class ToolOAuthService {
  private stateStore: OAuthStateStore;
  private inMemoryStore: InMemoryOAuthStateStore | null = null;
  private authProfileResolver?: AuthProfileOAuthResolver;
  private sessionArtifactStore: SessionOAuthArtifactStore | null = null;
  private sessionArtifactStorePromise: Promise<SessionOAuthArtifactStore | null> | null = null;
  /** Maps OAuth state → JIT metadata for callback routing (Task 5.10) */
  private jitMetadataMap = new Map<string, JitOAuthMetadata>();
  /** Periodic cleanup timer for expired JIT metadata entries */
  private jitMetadataCleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private tokenStore: OAuthTokenStore,
    private encryptor: OAuthEncryptor,
    private providerConfigs: Map<string, OAuthProviderConfig>,
    stateStore?: OAuthStateStore,
    authProfileResolver?: AuthProfileOAuthResolver,
    sessionArtifactStore?: SessionOAuthArtifactStore,
  ) {
    if (stateStore) {
      this.stateStore = stateStore;
    } else {
      const memStore = new InMemoryOAuthStateStore();
      this.stateStore = memStore;
      this.inMemoryStore = memStore;
    }
    this.authProfileResolver = authProfileResolver;
    this.sessionArtifactStore = sessionArtifactStore ?? null;

    // Periodic sweep of expired JIT metadata entries
    this.jitMetadataCleanupTimer = setInterval(
      () => this.cleanupExpiredJitMetadata(),
      JIT_METADATA_CLEANUP_INTERVAL_MS,
    );
    if (this.jitMetadataCleanupTimer && typeof this.jitMetadataCleanupTimer.unref === 'function') {
      this.jitMetadataCleanupTimer.unref();
    }
  }

  /**
   * Register a provider config at runtime.
   * Used to add providers loaded from DB or environment.
   */
  registerProvider(name: string, config: OAuthProviderConfig): void {
    this.providerConfigs.set(name, config);
    log.info('OAuth provider registered', { provider: name });
  }

  /** Get the list of registered provider names */
  getRegisteredProviders(): string[] {
    return Array.from(this.providerConfigs.keys());
  }

  private async getSessionArtifactStore(): Promise<SessionOAuthArtifactStore | null> {
    if (this.sessionArtifactStore) {
      return this.sessionArtifactStore;
    }
    if (this.sessionArtifactStorePromise) {
      return this.sessionArtifactStorePromise;
    }

    this.sessionArtifactStorePromise = (async () => {
      try {
        const { buildMongoSessionOAuthArtifactStore } = await import('./oauth-token-store.js');
        const store = await buildMongoSessionOAuthArtifactStore();
        this.sessionArtifactStore = store;
        return store;
      } catch (err) {
        log.debug('Session OAuth artifact store unavailable', {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      } finally {
        this.sessionArtifactStorePromise = null;
      }
    })();

    return this.sessionArtifactStorePromise;
  }

  private async resolveProviderContext(params: {
    provider: string;
    tenantId: string;
    userId?: string;
    projectId?: string;
    environment?: string;
    scopes?: string[];
    lookupScope?: 'user' | 'tenant';
    preferAuthProfile?: boolean;
  }): Promise<ResolvedProviderContext | null> {
    if (params.preferAuthProfile && this.authProfileResolver) {
      const authProfileProvider = await this.authProfileResolver.resolveProvider({
        tenantId: params.tenantId,
        userId: params.userId,
        provider: params.provider,
        projectId: params.projectId,
        environment: params.environment,
        scopes: params.scopes,
        lookupScope: params.lookupScope,
      });

      if (authProfileProvider) {
        return {
          providerKey: authProfileProvider.providerKey,
          config: authProfileProvider.config,
          authProfileId: authProfileProvider.authProfileId,
          authProfileRef: authProfileProvider.authProfileRef,
        };
      }
    }

    if (params.preferAuthProfile) {
      return null;
    }

    return this.resolveLegacyProviderContext(params.provider);
  }

  private async resolveProviderContextById(params: {
    tenantId: string;
    authProfileId: string;
    authProfileRef: string;
    scopes?: string[];
  }): Promise<ResolvedProviderContext | null> {
    if (!this.authProfileResolver?.resolveProviderById) {
      return null;
    }

    const authProfileProvider = await this.authProfileResolver.resolveProviderById({
      tenantId: params.tenantId,
      authProfileId: params.authProfileId,
      authProfileRef: params.authProfileRef,
      scopes: params.scopes,
    });

    if (!authProfileProvider) {
      return null;
    }

    return {
      providerKey: authProfileProvider.providerKey,
      config: authProfileProvider.config,
      authProfileId: authProfileProvider.authProfileId,
      authProfileRef: authProfileProvider.authProfileRef,
    };
  }

  private async decryptStoredOAuthValue(params: {
    encryptedValue: string;
    tenantId: string;
    context: TenantEncryptionAADContext;
    providerKey: string;
    field: 'encryptedAccessToken' | 'encryptedRefreshToken';
    authScope?: OAuthPrincipalScope;
    userId: string;
  }): Promise<string | undefined> {
    try {
      return await this.encryptor.decryptForTenant(
        params.encryptedValue,
        params.tenantId,
        params.context,
      );
    } catch (err) {
      if (!isDEKEnvelopeFormat(params.encryptedValue)) {
        log.warn('OAuth token field does not look like ciphertext; using plaintext compatibility', {
          tenantId: params.tenantId,
          providerKey: params.providerKey,
          field: params.field,
          authScope: params.authScope,
          userId: params.userId,
        });
        return params.encryptedValue;
      }

      log.warn('OAuth token decryption failed', {
        tenantId: params.tenantId,
        providerKey: params.providerKey,
        field: params.field,
        authScope: params.authScope,
        userId: params.userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  private resolveLegacyProviderContext(provider: string): ResolvedProviderContext {
    return {
      providerKey: provider,
      config: this.providerConfigs.get(provider),
    };
  }

  private buildAuthorizationUrl(params: {
    config: OAuthProviderConfig;
    redirectUri: string;
    state: string;
    scopes?: string[];
  }): string {
    const requestedScopes =
      params.scopes && params.scopes.length > 0 ? params.scopes : params.config.scopes;
    const searchParams = new URLSearchParams({
      client_id: params.config.clientId,
      redirect_uri: params.redirectUri,
      response_type: 'code',
      state: params.state,
      access_type: 'offline',
      prompt: 'consent',
    });

    if (requestedScopes.length > 0) {
      searchParams.set('scope', requestedScopes.join(' '));
    }

    return `${params.config.authorizeUrl}?${searchParams.toString()}`;
  }

  private async rollbackPersistedJitAuthorization(params: {
    tenantId: string;
    principalScope: OAuthPrincipalScope;
    principalId: string;
    provider: string;
    persistedToken: OAuthTokenRecord | SessionOAuthArtifactRecord;
    previousToken: OAuthTokenRecord | SessionOAuthArtifactRecord | null;
    projectId?: string;
    sessionId?: string;
    channelId?: string;
    authProfileId?: string;
    authProfileRef?: string;
    sessionExpiresAt?: Date;
  }): Promise<void> {
    if (params.persistedToken.version == null) {
      log.warn('Skipping JIT OAuth rollback because token changed concurrently', {
        tenantId: params.tenantId,
        principalScope: params.principalScope,
        principalId: params.principalId,
        provider: params.provider,
      });
      return;
    }

    let rolledBack = false;
    if (params.principalScope === 'session') {
      if (!params.projectId || !params.sessionId || !params.sessionExpiresAt) {
        log.warn('Skipping session-scoped JIT OAuth rollback because session metadata is missing', {
          tenantId: params.tenantId,
          principalId: params.principalId,
          provider: params.provider,
        });
        return;
      }

      const store = await this.getSessionArtifactStore();
      if (!store) {
        log.warn(
          'Skipping session-scoped JIT OAuth rollback because artifact store is unavailable',
          {
            tenantId: params.tenantId,
            principalId: params.principalId,
            provider: params.provider,
          },
        );
        return;
      }

      rolledBack = await store.compareAndSwapToken({
        tenantId: params.tenantId,
        projectId: params.projectId,
        sessionPrincipal: params.principalId,
        sessionId: params.sessionId,
        provider: params.provider,
        expectedVersion: params.persistedToken.version,
        next: params.previousToken
          ? {
              kind: 'upsert',
              token: params.previousToken,
            }
          : { kind: 'revoke' },
        ...(params.channelId ? { channelId: params.channelId } : {}),
        ...(params.authProfileId ? { authProfileId: params.authProfileId } : {}),
        ...(params.authProfileRef ? { authProfileRef: params.authProfileRef } : {}),
        sessionExpiresAt: isSessionOAuthArtifactRecord(params.previousToken)
          ? params.previousToken.sessionExpiresAt
          : params.sessionExpiresAt,
      });
    } else {
      rolledBack = await this.tokenStore.compareAndSwapToken({
        tenantId: params.tenantId,
        userId: params.principalId,
        provider: params.provider,
        expectedVersion: params.persistedToken.version,
        next: params.previousToken
          ? {
              kind: 'upsert',
              token: params.previousToken,
            }
          : { kind: 'revoke' },
      });
    }

    if (!rolledBack) {
      log.warn('Skipping JIT OAuth rollback because token changed concurrently', {
        tenantId: params.tenantId,
        principalScope: params.principalScope,
        principalId: params.principalId,
        provider: params.provider,
      });
      return;
    }

    if (params.previousToken) {
      log.info('Restored previous OAuth token after failed JIT resume', {
        tenantId: params.tenantId,
        principalScope: params.principalScope,
        principalId: params.principalId,
        provider: params.provider,
      });
      return;
    }

    log.info('Revoked newly stored OAuth token after failed JIT resume', {
      tenantId: params.tenantId,
      principalScope: params.principalScope,
      principalId: params.principalId,
      provider: params.provider,
    });
  }

  /**
   * Initiate OAuth authorization flow.
   * Returns the authorization URL for the user to visit and a state parameter for CSRF protection.
   */
  async initiateOAuthFlow(
    provider: string,
    tenantId: string,
    userId: string,
    scopes: string[],
    redirectUri: string,
  ): Promise<{ authUrl: string; state: string }> {
    const legacyContext = this.resolveLegacyProviderContext(provider);
    const config = legacyContext.config;
    if (!config) {
      throw new AppError(
        `Unknown OAuth provider: ${provider}. Registered providers: ${this.getRegisteredProviders().join(', ') || 'none'}`,
        { ...ErrorCodes.BAD_REQUEST },
      );
    }

    const requestedScopes = normalizeScopes(scopes);
    const state = crypto.randomBytes(32).toString('hex');
    await this.stateStore.set(state, {
      provider,
      tenantId,
      userId,
      principalScope: 'user',
      principalId: userId,
      redirectUri,
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 minute expiry
      requestedScopes,
    });

    const authUrl = this.buildAuthorizationUrl({
      config,
      redirectUri,
      state,
      scopes: requestedScopes,
    });
    return { authUrl, state };
  }

  /**
   * Initiate a JIT OAuth flow for an auth-profile-backed oauth2_app provider.
   * Tokens are stored under a stable provider key based on authProfileId so
   * renames or config-var indirection do not orphan cross-session reuse.
   */
  async initiateAuthProfileJitOAuth(params: {
    authProfileRef: string;
    tenantId: string;
    userId: string;
    sessionId: string;
    toolCallId: string;
    redirectUri: string;
    projectId?: string;
    channelId?: string;
    environment?: string;
    scopes?: string[];
    lookupScope?: 'user' | 'tenant';
    authScope?: OAuthPrincipalScope;
    sessionExpiresAt?: number;
  }): Promise<string | undefined> {
    const requestedScopes = normalizeScopes(params.scopes);
    const context = await this.resolveProviderContext({
      provider: params.authProfileRef,
      tenantId: params.tenantId,
      userId: params.lookupScope === 'tenant' ? undefined : params.userId,
      projectId: params.projectId,
      environment: params.environment,
      scopes: requestedScopes,
      lookupScope: params.lookupScope,
      preferAuthProfile: true,
    });

    if (!context?.config || !context.authProfileId || !context.authProfileRef) {
      log.warn('Cannot initiate auth-profile JIT OAuth — auth profile not resolvable', {
        authProfileRef: params.authProfileRef,
        tenantId: params.tenantId,
        projectId: params.projectId,
        environment: params.environment,
      });
      return undefined;
    }

    const state = crypto.randomBytes(32).toString('hex');
    const jitMetadata: JitOAuthMetadata = {
      sessionId: params.sessionId,
      toolCallId: params.toolCallId,
      createdAt: Date.now(),
    };

    // JIT tokens are always per-user — the end user gives consent themselves.
    // 'tenant' scope with __tenant__ userId is exclusively for preconfigured mode.
    // Only 'user' and 'session' are valid for JIT flows.
    const jitScope: OAuthPrincipalScope = params.authScope === 'session' ? 'session' : 'user';

    await this.stateStore.set(state, {
      provider: AUTH_PROFILE_OAUTH_PROVIDER_ID,
      tenantId: params.tenantId,
      principalScope: jitScope,
      principalId: params.userId,
      ...(shouldPersistLegacyUserId(jitScope) ? { userId: params.userId } : {}),
      ...(params.authScope === 'session'
        ? {
            sessionPrincipal: params.userId,
            sessionId: params.sessionId,
            ...(typeof params.sessionExpiresAt === 'number'
              ? { sessionExpiresAt: params.sessionExpiresAt }
              : {}),
          }
        : {}),
      redirectUri: params.redirectUri,
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 minute expiry
      tokenProviderKey: context.providerKey,
      authProfileId: context.authProfileId,
      authProfileRef: context.authProfileRef,
      projectId: params.projectId,
      channelId: params.channelId,
      environment: params.environment,
      requestedScopes,
      jitMetadata,
    });

    if (this.jitMetadataMap.size >= MAX_JIT_METADATA_ENTRIES) {
      log.warn('JIT metadata map at capacity, evicting oldest entries', {
        count: this.jitMetadataMap.size,
      });
      this.evictOldestJitMetadata(Math.floor(MAX_JIT_METADATA_ENTRIES / 10));
    }
    this.jitMetadataMap.set(state, jitMetadata);

    const authUrl = this.buildAuthorizationUrl({
      config: context.config,
      redirectUri: params.redirectUri,
      state,
      scopes: requestedScopes,
    });

    log.info('Auth-profile JIT OAuth flow initiated', {
      authProfileRef: context.authProfileRef,
      authProfileId: context.authProfileId,
      providerKey: context.providerKey,
      tenantId: params.tenantId,
      sessionId: params.sessionId,
      toolCallId: params.toolCallId,
    });

    return authUrl;
  }

  private async resolvePendingProviderContext(
    provider: string,
    pending: PendingOAuthState,
  ): Promise<ResolvedProviderContext | null> {
    const pendingPrincipal = resolvePendingPrincipal(pending);
    if (pending.provider === AUTH_PROFILE_OAUTH_PROVIDER_ID) {
      if (provider !== AUTH_PROFILE_OAUTH_PROVIDER_ID) {
        return null;
      }

      if (pending.authProfileId && pending.authProfileRef) {
        return this.resolveProviderContextById({
          tenantId: pending.tenantId,
          authProfileId: pending.authProfileId,
          authProfileRef: pending.authProfileRef,
          scopes: pending.requestedScopes,
        });
      }

      if (!pending.authProfileRef) {
        return null;
      }

      return this.resolveProviderContext({
        provider: pending.authProfileRef,
        tenantId: pending.tenantId,
        userId: pendingPrincipal.scope === 'tenant' ? undefined : pendingPrincipal.principalId,
        projectId: pending.projectId,
        environment: pending.environment,
        scopes: pending.requestedScopes,
        lookupScope: pendingPrincipal.scope === 'tenant' ? 'tenant' : 'user',
        preferAuthProfile: true,
      });
    }

    if (pending.provider !== provider) {
      return null;
    }

    return this.resolveLegacyProviderContext(provider);
  }

  /**
   * Handle OAuth callback: exchange code for tokens, encrypt and store.
   */
  async handleOAuthCallback(
    provider: string,
    code: string,
    state: string,
  ): Promise<OAuthCallbackResult> {
    const pending = await this.stateStore.getAndDelete(state);
    if (!pending) {
      throw new AppError('Invalid or expired OAuth state', { ...ErrorCodes.BAD_REQUEST });
    }
    if (pending.expiresAt < Date.now()) {
      throw new AppError('OAuth state expired', { ...ErrorCodes.BAD_REQUEST });
    }

    const jitMeta = pending.jitMetadata ?? this.getJitMetadata(state);
    const pendingPrincipal = resolvePendingPrincipal(pending);
    const tokenProviderKeyBase = pending.tokenProviderKey;
    let resolvedTokenProviderKey = tokenProviderKeyBase ?? provider;
    let previousTokenRecord: OAuthTokenRecord | SessionOAuthArtifactRecord | null = null;
    let persistedTokenRecord: OAuthTokenRecord | SessionOAuthArtifactRecord | null = null;
    let persistedToken = false;
    let rolledBackPersistedToken = false;

    try {
      const providerContext = await this.resolvePendingProviderContext(provider, pending);
      if (!providerContext) {
        throw new AppError('Invalid or expired OAuth state', { ...ErrorCodes.BAD_REQUEST });
      }

      const config = providerContext.config;
      if (!config) {
        throw new AppError(`Unknown OAuth provider: ${provider}`, { ...ErrorCodes.BAD_REQUEST });
      }

      // Exchange code for tokens
      const tokenResponse = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: pending.redirectUri,
        }),
      });

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        throw new AppError(
          `OAuth token exchange failed: ${tokenResponse.status} — ${errorText.substring(0, 200)}`,
          { ...ErrorCodes.SERVICE_UNAVAILABLE },
        );
      }

      const tokenData = (await tokenResponse.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
      };

      const expiresAt = tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000)
        : null;

      const sessionArtifactStore =
        pendingPrincipal.scope === 'session' ? await this.getSessionArtifactStore() : null;
      const sessionExpiresAt =
        pendingPrincipal.scope === 'session'
          ? resolveSessionArtifactExpiry(pendingPrincipal.sessionExpiresAt)
          : undefined;

      if (pendingPrincipal.scope === 'session') {
        if (!pending.projectId || !pendingPrincipal.sessionId) {
          throw new AppError(
            'Session-scoped authorization is missing required session metadata. Please retry the tool call.',
            { ...ErrorCodes.SERVICE_UNAVAILABLE },
          );
        }
        if (!sessionArtifactStore || !sessionExpiresAt) {
          throw new AppError(
            'Session-scoped authorization storage is temporarily unavailable. Please retry the tool call.',
            { ...ErrorCodes.SERVICE_UNAVAILABLE },
          );
        }
      }

      resolvedTokenProviderKey = tokenProviderKeyBase ?? providerContext.providerKey;
      if (jitMeta) {
        previousTokenRecord =
          pendingPrincipal.scope === 'session'
            ? await sessionArtifactStore!.findToken({
                tenantId: pending.tenantId,
                projectId: pending.projectId!,
                sessionPrincipal: pendingPrincipal.principalId,
                provider: resolvedTokenProviderKey,
              })
            : await this.tokenStore.findToken(
                pending.tenantId,
                pendingPrincipal.principalId,
                resolvedTokenProviderKey,
              );
      }

      // Encrypt tokens with tenant-scoped key + AAD context that matches the
      // Mongoose encryption plugin on the destination collection. Reads via
      // `findOne(...).lean()` skip the plugin's auto-decrypt, so the AAD must
      // round-trip through the manual decrypt path.
      const isSessionScope = pendingPrincipal.scope === 'session';
      const encryptedAccessToken = await this.encryptor.encryptForTenant(
        tokenData.access_token,
        pending.tenantId,
        isSessionScope ? SESSION_AAD_ACCESS : END_USER_AAD_ACCESS,
      );
      const encryptedRefreshToken = tokenData.refresh_token
        ? await this.encryptor.encryptForTenant(
            tokenData.refresh_token,
            pending.tenantId,
            isSessionScope ? SESSION_AAD_REFRESH : END_USER_AAD_REFRESH,
          )
        : null;
      const resolvedScope =
        tokenData.scope ||
        (pending.requestedScopes && pending.requestedScopes.length > 0
          ? normalizeScopes(pending.requestedScopes).join(' ')
          : config.scopes.join(' '));
      persistedTokenRecord =
        pendingPrincipal.scope === 'session' && pendingPrincipal.sessionId && sessionExpiresAt
          ? {
              encryptedAccessToken,
              encryptedRefreshToken,
              scope: resolvedScope,
              expiresAt,
              sessionId: pendingPrincipal.sessionId,
              ...(pending.channelId ? { channelId: pending.channelId } : {}),
              ...(pending.authProfileId ? { authProfileId: pending.authProfileId } : {}),
              ...(pending.authProfileRef ? { authProfileRef: pending.authProfileRef } : {}),
              sessionExpiresAt,
            }
          : {
              encryptedAccessToken,
              encryptedRefreshToken,
              scope: resolvedScope,
              expiresAt,
            };
      if (jitMeta) {
        const persisted =
          pendingPrincipal.scope === 'session'
            ? await sessionArtifactStore!.compareAndSwapToken({
                tenantId: pending.tenantId,
                projectId: pending.projectId!,
                sessionPrincipal: pendingPrincipal.principalId,
                sessionId: pendingPrincipal.sessionId!,
                provider: resolvedTokenProviderKey,
                expectedVersion: previousTokenRecord?.version ?? null,
                next: {
                  kind: 'upsert',
                  token: persistedTokenRecord,
                },
                ...(pending.channelId ? { channelId: pending.channelId } : {}),
                ...(pending.authProfileId ? { authProfileId: pending.authProfileId } : {}),
                ...(pending.authProfileRef ? { authProfileRef: pending.authProfileRef } : {}),
                sessionExpiresAt: sessionExpiresAt!,
              })
            : await this.tokenStore.compareAndSwapToken({
                tenantId: pending.tenantId,
                userId: pendingPrincipal.principalId,
                provider: resolvedTokenProviderKey,
                expectedVersion: previousTokenRecord?.version ?? null,
                next: {
                  kind: 'upsert',
                  token: persistedTokenRecord,
                },
              });
        if (!persisted) {
          throw new AppError(
            'Authorization could not be stored because credentials changed concurrently. Please retry the tool call.',
            { ...ErrorCodes.SERVICE_UNAVAILABLE },
          );
        }
        persistedTokenRecord.version =
          previousTokenRecord?.version == null ? 0 : previousTokenRecord.version + 1;
      } else {
        if (pendingPrincipal.scope === 'session') {
          await sessionArtifactStore!.upsertToken({
            tenantId: pending.tenantId,
            projectId: pending.projectId!,
            sessionPrincipal: pendingPrincipal.principalId,
            sessionId: pendingPrincipal.sessionId!,
            provider: resolvedTokenProviderKey,
            ...(pending.channelId ? { channelId: pending.channelId } : {}),
            ...(pending.authProfileId ? { authProfileId: pending.authProfileId } : {}),
            ...(pending.authProfileRef ? { authProfileRef: pending.authProfileRef } : {}),
            encryptedAccessToken,
            encryptedRefreshToken,
            scope: resolvedScope,
            expiresAt,
            sessionExpiresAt: sessionExpiresAt!,
          });
        } else {
          await this.tokenStore.upsertToken({
            tenantId: pending.tenantId,
            userId: pendingPrincipal.principalId,
            provider: resolvedTokenProviderKey,
            encryptedAccessToken,
            encryptedRefreshToken,
            scope: resolvedScope,
            expiresAt,
          });
        }
      }
      persistedToken = true;

      log.info('OAuth tokens stored successfully', {
        provider,
        providerKey: resolvedTokenProviderKey,
        authProfileRef: pending.authProfileRef,
        tenantId: pending.tenantId,
      });

      // Resolve JIT paused execution if this was a JIT OAuth flow
      if (jitMeta) {
        const { getPausedExecutionStore } =
          await import('./auth-profile/paused-execution-store.js');
        const store = getPausedExecutionStore();
        const resumeResult = await store.resolveDistributed(jitMeta.sessionId, jitMeta.toolCallId);

        if (resumeResult === 'handled') {
          log.info('JIT OAuth flow completed — paused execution resolved', {
            provider,
            tenantId: pending.tenantId,
            sessionId: jitMeta.sessionId,
            toolCallId: jitMeta.toolCallId,
          });
        } else {
          await this.rollbackPersistedJitAuthorization({
            tenantId: pending.tenantId,
            principalScope: pendingPrincipal.scope,
            principalId: pendingPrincipal.principalId,
            provider: resolvedTokenProviderKey,
            persistedToken: persistedTokenRecord,
            previousToken: previousTokenRecord,
            projectId: pending.projectId,
            sessionId: pendingPrincipal.sessionId,
            channelId: pending.channelId,
            authProfileId: pending.authProfileId,
            authProfileRef: pending.authProfileRef,
            sessionExpiresAt,
          });
          rolledBackPersistedToken = true;
          throw new AppError(
            'Authorization completed, but the paused tool execution could not be resumed. The new authorization was rolled back. Please retry the tool call.',
            { ...ErrorCodes.SERVICE_UNAVAILABLE },
          );
        }
      }

      return jitMeta ? { jitMetadata: jitMeta } : {};
    } catch (error) {
      if (jitMeta && persistedToken && !rolledBackPersistedToken && persistedTokenRecord) {
        try {
          await this.rollbackPersistedJitAuthorization({
            tenantId: pending.tenantId,
            principalScope: pendingPrincipal.scope,
            principalId: pendingPrincipal.principalId,
            provider: resolvedTokenProviderKey,
            persistedToken: persistedTokenRecord,
            previousToken: previousTokenRecord,
            projectId: pending.projectId,
            sessionId: pendingPrincipal.sessionId,
            channelId: pending.channelId,
            authProfileId: pending.authProfileId,
            authProfileRef: pending.authProfileRef,
            sessionExpiresAt:
              pendingPrincipal.scope === 'session'
                ? resolveSessionArtifactExpiry(pendingPrincipal.sessionExpiresAt)
                : undefined,
          });
          rolledBackPersistedToken = true;
        } catch (rollbackErr) {
          log.error('Failed to roll back OAuth token after JIT callback failure', {
            provider,
            tenantId: pending.tenantId,
            principalScope: pendingPrincipal.scope,
            principalId: pendingPrincipal.principalId,
            providerKey: resolvedTokenProviderKey,
            error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          });
        }
      }

      if (jitMeta) {
        try {
          const { getPausedExecutionStore } =
            await import('./auth-profile/paused-execution-store.js');
          const store = getPausedExecutionStore();
          const rejectResult = await store.rejectDistributedError(
            jitMeta.sessionId,
            jitMeta.toolCallId,
            'Authorization failed during callback. Please retry the tool call.',
          );

          if (rejectResult !== 'handled') {
            log.warn('Failed to propagate JIT OAuth callback failure to paused execution', {
              provider,
              sessionId: jitMeta.sessionId,
              toolCallId: jitMeta.toolCallId,
              result: rejectResult,
            });
          }
        } catch (rejectErr) {
          log.warn('Failed to reject paused execution after OAuth callback error', {
            provider,
            error: rejectErr instanceof Error ? rejectErr.message : String(rejectErr),
            sessionId: jitMeta.sessionId,
            toolCallId: jitMeta.toolCallId,
          });
        }
      }

      throw error;
    } finally {
      if (jitMeta) {
        this.clearJitMetadata(state);
      }
    }
  }

  /**
   * Get a valid access token for a user+provider combination.
   * Decrypts the stored token, checks expiry, refreshes if needed.
   */
  async getAccessToken(
    tenantId: string,
    userId: string,
    provider: string,
    options?: AccessTokenLookupOptions,
  ): Promise<string | undefined> {
    const providerContext = options?.preferAuthProfile
      ? await this.resolveProviderContext({
          tenantId,
          userId: options.lookupScope === 'tenant' ? undefined : userId,
          provider,
          projectId: options.projectId,
          environment: options.environment,
          scopes: options.scopes,
          lookupScope: options.lookupScope,
          preferAuthProfile: true,
        })
      : this.resolveLegacyProviderContext(provider);

    if (options?.preferAuthProfile && !providerContext) {
      log.debug('Auth-profile OAuth provider could not be resolved', {
        provider,
        tenantId,
        projectId: options.projectId,
        environment: options.environment,
      });
      return undefined;
    }

    const providerKey = providerContext?.providerKey ?? provider;
    const isSessionScope = options?.authScope === 'session';
    const sessionArtifactStore = isSessionScope ? await this.getSessionArtifactStore() : null;
    if (isSessionScope && (!options?.projectId || !sessionArtifactStore)) {
      return undefined;
    }

    const record = isSessionScope
      ? await sessionArtifactStore!.findToken({
          tenantId,
          projectId: options.projectId!,
          sessionPrincipal: userId,
          provider: providerKey,
        })
      : await this.tokenStore.findToken(tenantId, userId, providerKey);
    if (!record) return undefined;

    const sessionRecord = isSessionScope && isSessionOAuthArtifactRecord(record) ? record : null;

    if (isSessionScope && sessionRecord && sessionRecord.sessionExpiresAt.getTime() <= Date.now()) {
      await sessionArtifactStore!.deleteBySessionId(sessionRecord.sessionId).catch((err: unknown) =>
        log.warn('Session OAuth artifact cleanup failed after expiry', {
          tenantId,
          projectId: options?.projectId,
          sessionPrincipal: userId,
          provider: providerKey,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return undefined;
    }

    if (!hasRequiredScopes(record.scope, options?.scopes)) {
      log.info('Stored OAuth token is missing required scopes', {
        provider,
        providerKey,
        tenantId,
        requiredScopes: normalizeScopes(options?.scopes),
        grantedScope: record.scope,
      });
      return undefined;
    }

    // Check if token is expired (with 60s buffer)
    const isExpired = record.expiresAt && record.expiresAt.getTime() < Date.now() + 60_000;

    if (isExpired && record.encryptedRefreshToken) {
      // Attempt refresh
      try {
        const authProfileRefreshId = await this.resolveRefreshAuthProfileId({
          providerKey,
          providerContextAuthProfileId: providerContext?.authProfileId,
          sessionAuthProfileId: sessionRecord?.authProfileId ?? undefined,
        });
        const refreshed = authProfileRefreshId
          ? await this.refreshAuthProfileToken({
              tenantId,
              userId,
              authProfileId: authProfileRefreshId,
              existingScope: record.scope,
              authScope:
                options?.authScope ?? (options?.lookupScope === 'tenant' ? 'tenant' : 'user'),
              projectId: options?.projectId,
              sessionPrincipal: isSessionScope ? userId : undefined,
            })
          : await this.refreshLegacyToken({
              tenantId,
              userId,
              provider,
              providerKey,
              providerConfig: providerContext?.config,
              encryptedRefreshToken: record.encryptedRefreshToken,
              existingScope: record.scope,
              authScope: isSessionScope ? 'session' : 'user',
              projectId: options?.projectId,
              sessionExpiresAt: sessionRecord?.sessionExpiresAt,
              sessionId: sessionRecord?.sessionId,
              channelId: sessionRecord?.channelId ?? undefined,
              authProfileId: sessionRecord?.authProfileId ?? undefined,
              authProfileRef: sessionRecord?.authProfileRef ?? undefined,
            });

        if (!hasRequiredScopes(refreshed.scope, options?.scopes)) {
          log.info('Refreshed OAuth token is missing required scopes', {
            provider,
            providerKey,
            tenantId,
            requiredScopes: normalizeScopes(options?.scopes),
            grantedScope: refreshed.scope,
          });
          return undefined;
        }

        return refreshed.accessToken;
      } catch (error) {
        log.error('OAuth token refresh failed', {
          provider,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        return undefined;
      }
    }

    if (isExpired) {
      // Expired with no refresh token
      return undefined;
    }

    const accessToken = await this.decryptStoredOAuthValue({
      encryptedValue: record.encryptedAccessToken,
      tenantId,
      context: resolveOAuthTokenDecryptContext(options?.authScope, 'encryptedAccessToken'),
      providerKey,
      field: 'encryptedAccessToken',
      authScope: options?.authScope,
      userId,
    });
    if (!accessToken) {
      return undefined;
    }

    // Update last used (fire-and-forget)
    if (isSessionScope) {
      sessionArtifactStore!
        .updateLastUsed({
          tenantId,
          projectId: options!.projectId!,
          sessionPrincipal: userId,
          provider: providerKey,
        })
        .catch((err: unknown) =>
          log.warn('Session token last-used update failed', {
            error: err instanceof Error ? err.stack : String(err),
          }),
        );
    } else {
      this.tokenStore.updateLastUsed(tenantId, userId, providerKey).catch((err: unknown) =>
        log.warn('Token last-used update failed', {
          error: err instanceof Error ? err.stack : String(err),
        }),
      );
    }

    return accessToken;
  }

  /**
   * Resolve the auth profile id used by a stable provider key refresh path.
   */
  private async resolveRefreshAuthProfileId(params: {
    providerKey: string;
    providerContextAuthProfileId?: string;
    sessionAuthProfileId?: string;
  }): Promise<string | undefined> {
    if (params.providerContextAuthProfileId) {
      return params.providerContextAuthProfileId;
    }

    if (params.sessionAuthProfileId) {
      return params.sessionAuthProfileId;
    }

    const { parseAuthProfileOAuthProviderKey } =
      await import('@agent-platform/shared/services/auth-profile');
    return parseAuthProfileOAuthProviderKey(params.providerKey);
  }

  /**
   * Refresh an auth-profile-backed access token via the shared grant/session helper.
   */
  private async refreshAuthProfileToken(params: {
    tenantId: string;
    userId: string;
    authProfileId: string;
    existingScope: string;
    authScope: OAuthPrincipalScope;
    projectId?: string;
    sessionPrincipal?: string;
  }): Promise<{ accessToken: string; scope: string }> {
    const { refreshOAuth2Token } = await import('@agent-platform/shared/services/auth-profile');
    const { getRedisClient } = await import('./redis/redis-client.js');
    const redis = getRedisClient() ?? undefined;

    const refreshed = await refreshOAuth2Token({
      profileId: params.authProfileId,
      tenantId: params.tenantId,
      authScope: params.authScope,
      ...(params.authScope === 'session'
        ? {
            projectId: params.projectId,
            sessionPrincipal: params.sessionPrincipal ?? params.userId,
          }
        : { userId: params.userId }),
      ...(redis ? { redis } : {}),
    });

    return {
      accessToken: refreshed.accessToken,
      scope: refreshed.scope || params.existingScope,
    };
  }

  /**
   * Refresh an expired access token using the stored refresh token for legacy providers.
   */
  private async refreshLegacyToken(params: {
    tenantId: string;
    userId: string;
    provider: string;
    providerKey: string;
    providerConfig?: OAuthProviderConfig;
    encryptedRefreshToken: string;
    existingScope: string;
    authScope?: OAuthPrincipalScope;
    projectId?: string;
    sessionExpiresAt?: Date;
    sessionId?: string;
    channelId?: string;
    authProfileId?: string;
    authProfileRef?: string;
  }): Promise<{ accessToken: string; scope: string }> {
    const config = params.providerConfig;
    if (!config) {
      throw new AppError(`Unknown OAuth provider: ${params.provider}`, {
        ...ErrorCodes.BAD_REQUEST,
      });
    }

    const refreshToken = await this.decryptStoredOAuthValue({
      encryptedValue: params.encryptedRefreshToken,
      tenantId: params.tenantId,
      context: resolveOAuthTokenDecryptContext(params.authScope, 'encryptedRefreshToken'),
      providerKey: params.providerKey,
      field: 'encryptedRefreshToken',
      authScope: params.authScope,
      userId: params.userId,
    });
    if (!refreshToken) {
      throw new AppError('Stored OAuth refresh token is not decryptable', {
        ...ErrorCodes.SERVICE_UNAVAILABLE,
      });
    }

    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });

    if (!response.ok) {
      throw new AppError(`OAuth refresh failed: ${response.status}`, {
        ...ErrorCodes.SERVICE_UNAVAILABLE,
      });
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };

    const expiresAt = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;

    const isSessionScope = params.authScope === 'session';
    const newEncryptedAccess = await this.encryptor.encryptForTenant(
      data.access_token,
      params.tenantId,
      isSessionScope ? SESSION_AAD_ACCESS : END_USER_AAD_ACCESS,
    );
    const newEncryptedRefresh = data.refresh_token
      ? await this.encryptor.encryptForTenant(
          data.refresh_token,
          params.tenantId,
          isSessionScope ? SESSION_AAD_REFRESH : END_USER_AAD_REFRESH,
        )
      : params.encryptedRefreshToken; // keep old refresh token if not rotated

    // Preserve existing scope: use new scope from refresh response if provided,
    // otherwise keep the caller's existing scope
    const scope = data.scope || params.existingScope;

    if (params.authScope === 'session') {
      const store = await this.getSessionArtifactStore();
      if (!store || !params.projectId || !params.sessionExpiresAt || !params.sessionId) {
        throw new AppError('Session-scoped OAuth refresh could not be persisted', {
          ...ErrorCodes.SERVICE_UNAVAILABLE,
        });
      }

      await store.upsertToken({
        tenantId: params.tenantId,
        projectId: params.projectId,
        sessionPrincipal: params.userId,
        sessionId: params.sessionId,
        provider: params.providerKey,
        ...(params.channelId ? { channelId: params.channelId } : {}),
        ...(params.authProfileId ? { authProfileId: params.authProfileId } : {}),
        ...(params.authProfileRef ? { authProfileRef: params.authProfileRef } : {}),
        encryptedAccessToken: newEncryptedAccess,
        encryptedRefreshToken: newEncryptedRefresh,
        scope,
        expiresAt,
        sessionExpiresAt: params.sessionExpiresAt,
      });
    } else {
      await this.tokenStore.upsertToken({
        tenantId: params.tenantId,
        userId: params.userId,
        provider: params.providerKey,
        encryptedAccessToken: newEncryptedAccess,
        encryptedRefreshToken: newEncryptedRefresh,
        scope,
        expiresAt,
      });
    }

    log.info('OAuth token refreshed', { provider: params.provider, tenantId: params.tenantId });
    return {
      accessToken: data.access_token,
      scope,
    };
  }

  /**
   * Revoke an OAuth token for a user+provider.
   */
  async revokeToken(tenantId: string, userId: string, provider: string): Promise<void> {
    const authProfileId = await this.resolveRefreshAuthProfileId({ providerKey: provider });
    const providerKey = authProfileId
      ? provider
      : this.resolveLegacyProviderContext(provider).providerKey;
    const record = await this.tokenStore.findToken(tenantId, userId, providerKey);
    if (!record) return;

    let revokeUrl: string | undefined;

    if (authProfileId) {
      try {
        const { resolveOAuth2AppCredentials } =
          await import('@agent-platform/shared/services/auth-profile');
        const authProfileConfig = await resolveOAuth2AppCredentials({
          linkedAppProfileId: authProfileId,
          tenantId,
        });
        revokeUrl = authProfileConfig.revocationUrl;
      } catch (error) {
        log.warn('Auth-profile OAuth revocation metadata could not be resolved', {
          provider,
          authProfileId,
          tenantId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    } else {
      revokeUrl = this.resolveLegacyProviderContext(provider).config?.revokeUrl;
    }

    // Call provider revocation endpoint if available
    if (revokeUrl) {
      try {
        const accessToken = await this.decryptStoredOAuthValue({
          encryptedValue: record.encryptedAccessToken,
          tenantId,
          context: resolveOAuthTokenDecryptContext('user', 'encryptedAccessToken'),
          providerKey,
          field: 'encryptedAccessToken',
          authScope: 'user',
          userId,
        });
        if (!accessToken) {
          throw new Error('OAuth access token is not decryptable');
        }
        await fetch(revokeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: accessToken }),
        });
      } catch (error) {
        log.warn('Provider token revocation failed (token still marked revoked locally)', {
          provider,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    await this.tokenStore.markRevoked(tenantId, userId, providerKey);
    log.info('OAuth token revoked', { provider, tenantId });
  }

  async cleanupSessionScopedArtifactsBySessionId(sessionId: string): Promise<number> {
    const store = await this.getSessionArtifactStore();
    if (!store) {
      return 0;
    }

    return store.deleteBySessionId(sessionId);
  }

  /**
   * Initiate a JIT OAuth flow during tool execution (Task 5.9).
   * Returns the authorization URL for the auth_challenge message,
   * or undefined if the provider is not registered.
   *
   * Stores JIT metadata (sessionId, toolCallId) keyed by the OAuth state
   * parameter so the callback handler can route the resume signal.
   */
  async initiateJitOAuth(
    provider: string,
    tenantId: string,
    userId: string,
    sessionId: string,
    toolCallId: string,
    redirectUri: string,
    options?: {
      authScope?: OAuthPrincipalScope;
      projectId?: string;
      channelId?: string;
      sessionExpiresAt?: number;
    },
  ): Promise<string | undefined> {
    const legacyContext = this.resolveLegacyProviderContext(provider);
    const config = legacyContext.config;
    if (!config) {
      log.warn('Cannot initiate JIT OAuth — provider not registered', { provider });
      return undefined;
    }

    const state = crypto.randomBytes(32).toString('hex');
    const jitMetadata: JitOAuthMetadata = {
      sessionId,
      toolCallId,
      createdAt: Date.now(),
    };

    await this.stateStore.set(state, {
      provider,
      tenantId,
      principalScope: options?.authScope ?? 'user',
      principalId: userId,
      ...(shouldPersistLegacyUserId(options?.authScope ?? 'user') ? { userId } : {}),
      ...(options?.authScope === 'session'
        ? {
            sessionPrincipal: userId,
            sessionId,
            ...(typeof options.sessionExpiresAt === 'number'
              ? { sessionExpiresAt: options.sessionExpiresAt }
              : {}),
          }
        : {}),
      redirectUri,
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 minute expiry
      projectId: options?.projectId,
      channelId: options?.channelId,
      requestedScopes: config.scopes,
      jitMetadata,
    });

    // Store JIT metadata for callback routing (with TTL and capacity enforcement)
    if (this.jitMetadataMap.size >= MAX_JIT_METADATA_ENTRIES) {
      log.warn('JIT metadata map at capacity, evicting oldest entries', {
        count: this.jitMetadataMap.size,
      });
      this.evictOldestJitMetadata(Math.floor(MAX_JIT_METADATA_ENTRIES / 10));
    }
    this.jitMetadataMap.set(state, jitMetadata);

    const authUrl = this.buildAuthorizationUrl({
      config,
      redirectUri,
      state,
      scopes: config.scopes,
    });

    log.info('JIT OAuth flow initiated', {
      provider,
      tenantId,
      sessionId,
      toolCallId,
    });

    return authUrl;
  }

  /**
   * Get JIT metadata for a given OAuth state (Task 5.10).
   * Used by the OAuth callback handler to find which paused execution to resume.
   */
  getJitMetadata(state: string): JitOAuthMetadata | null {
    const entry = this.jitMetadataMap.get(state);
    if (!entry) return null;
    // Check TTL — expired entries are treated as absent
    if (Date.now() - entry.createdAt > JIT_METADATA_TTL_MS) {
      this.jitMetadataMap.delete(state);
      return null;
    }
    return entry;
  }

  /**
   * Clear JIT metadata for a given OAuth state (Task 5.10).
   * Called after the callback has been processed.
   */
  clearJitMetadata(state: string): void {
    this.jitMetadataMap.delete(state);
  }

  /** Stop cleanup timers (for graceful shutdown / testing) */
  destroy(): void {
    if (this.inMemoryStore) {
      this.inMemoryStore.destroy();
    }
    if (this.jitMetadataCleanupTimer) {
      clearInterval(this.jitMetadataCleanupTimer);
      this.jitMetadataCleanupTimer = null;
    }
    this.jitMetadataMap.clear();
    this.sessionArtifactStore = null;
    this.sessionArtifactStorePromise = null;
  }

  /** Remove expired JIT metadata entries (periodic sweep) */
  private cleanupExpiredJitMetadata(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [state, entry] of this.jitMetadataMap) {
      if (now - entry.createdAt > JIT_METADATA_TTL_MS) {
        this.jitMetadataMap.delete(state);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      log.debug('Cleaned up expired JIT metadata entries', {
        count: cleaned,
        remaining: this.jitMetadataMap.size,
      });
    }
  }

  /** Evict oldest JIT metadata entries when at capacity */
  private evictOldestJitMetadata(count: number): void {
    const entries = Array.from(this.jitMetadataMap.entries()).sort(
      (a, b) => a[1].createdAt - b[1].createdAt,
    );
    for (let i = 0; i < Math.min(count, entries.length); i++) {
      this.jitMetadataMap.delete(entries[i][0]);
    }
  }
}

/**
 * D4: Load OAuth provider configs from environment variables.
 * Reads OAUTH_PROVIDER_<NAME>_CLIENT_ID, _CLIENT_SECRET, _AUTHORIZE_URL, _TOKEN_URL, _SCOPES.
 * Returns a Map of provider configs.
 */
export function loadProviderConfigsFromEnv(): Map<string, OAuthProviderConfig> {
  const configs = new Map<string, OAuthProviderConfig>();

  // Scan env vars for OAUTH_PROVIDER_* pattern
  const providerNames = new Set<string>();
  for (const key of Object.keys(process.env)) {
    const match = key.match(/^OAUTH_PROVIDER_([A-Z0-9_]+)_CLIENT_ID$/);
    if (match) {
      providerNames.add(match[1].toLowerCase());
    }
  }

  for (const name of providerNames) {
    const prefix = `OAUTH_PROVIDER_${name.toUpperCase()}`;
    const clientId = process.env[`${prefix}_CLIENT_ID`];
    const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
    const authorizeUrl = process.env[`${prefix}_AUTHORIZE_URL`];
    const tokenUrl = process.env[`${prefix}_TOKEN_URL`];
    const scopes = process.env[`${prefix}_SCOPES`]?.split(',').map((s) => s.trim()) ?? [];
    const revokeUrl = process.env[`${prefix}_REVOKE_URL`];

    if (clientId && clientSecret && authorizeUrl && tokenUrl) {
      configs.set(name, { clientId, clientSecret, authorizeUrl, tokenUrl, scopes, revokeUrl });
      log.info('Loaded OAuth provider config from env', { provider: name });
    } else {
      log.warn('Incomplete OAuth provider config in env, skipping', {
        provider: name,
        hasClientId: !!clientId,
        hasClientSecret: !!clientSecret,
        hasAuthorizeUrl: !!authorizeUrl,
        hasTokenUrl: !!tokenUrl,
      });
    }
  }

  return configs;
}
