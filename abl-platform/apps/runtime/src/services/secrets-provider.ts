/**
 * Runtime Secrets Provider
 *
 * Implements SecretsProvider for the runtime environment.
 * Resolves secrets from session/organization context with a multi-layer lookup chain:
 * 1. Special keys (auth_token, bearer_token) → session authToken
 * 2. Auth Profile resolution (when configured)
 * 3. Encrypted DB-backed ToolSecret (org + project + tool + env scoped)
 * 4. Agent IR tool credentials config map
 * 5. undefined (with warning)
 *
 * No process.env fallback — all variable resolution must go through DB.
 */

import type { SecretsProvider } from '@abl/compiler';
import type { AgentIR } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import type { TenantEncryptionAADContext } from '@agent-platform/shared-encryption';

const log = createLogger('secrets-provider');

/**
 * Pluggable interface for encrypted secret store lookups.
 * Decoupled from direct DB calls so the provider is testable without DB.
 */
export interface ToolSecretStore {
  findSecret(params: {
    tenantId: string;
    projectId: string;
    toolName: string;
    secretKey: string;
    environment: string;
  }): Promise<{ encryptedValue: string; expiresAt: Date | null; version: number } | null>;
}

/**
 * Pluggable interface for decryption (tenant-scoped AES-256-GCM).
 */
export interface SecretDecryptor {
  decryptForTenant(
    encryptedData: string,
    tenantId: string,
    context?: TenantEncryptionAADContext,
  ): Promise<string>;
}

/**
 * Pluggable interface for end-user OAuth token retrieval.
 */
export interface OAuthTokenResolver {
  getAccessToken(tenantId: string, userId: string, provider: string): Promise<string | undefined>;
}

/**
 * Pluggable interface for encrypted environment variable store lookups.
 * Decoupled from direct DB calls so the provider is testable without DB.
 */
export interface EnvVarStore {
  findEnvVar(params: {
    tenantId: string;
    projectId: string;
    environment: string;
    key: string;
    variableNamespaceIds?: string[];
  }): Promise<{ encryptedValue: string } | null>;
}

/**
 * Pluggable interface for plaintext config variable store lookups.
 * Config variables are project-scoped, not environment-scoped.
 */
export interface ConfigVarStore {
  findConfigVar(params: {
    tenantId: string;
    projectId: string;
    key: string;
    variableNamespaceIds?: string[];
  }): Promise<{ value: string } | null>;
}

/**
 * Pluggable interface for Auth Profile credential resolution.
 * When auth profile resolution is configured, secrets provider checks auth profiles
 * before falling through to legacy ToolSecret path.
 */
export interface AuthProfileResolver {
  resolveBySecretKey(params: {
    tenantId: string;
    projectId: string;
    secretKey: string;
    environment: string;
  }): Promise<{ secrets: Record<string, string> } | null>;
}

export interface RuntimeSecretsProviderConfig {
  tenantId?: string;
  authToken?: string;
  userId?: string;
  agentIR?: AgentIR | null;
  projectId?: string;
  environment?: string;
  secretStore?: ToolSecretStore;
  decryptor?: SecretDecryptor;
  oauthResolver?: OAuthTokenResolver;
  envVarStore?: EnvVarStore;
  configVarStore?: ConfigVarStore;
  authProfileResolver?: AuthProfileResolver;
  /** Variable namespace IDs for namespace-scoped env/config var resolution */
  variableNamespaceIds?: string[];
}

/** Max entries in the session-level auth profile credential cache */
const AUTH_PROFILE_CACHE_MAX_SIZE = 50;
/** TTL for cached auth profile credential entries (5 minutes) */
const AUTH_PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedCredential {
  value: string;
  cachedAt: number;
}

export class RuntimeSecretsProvider implements SecretsProvider {
  private credentialsMap: Record<string, string>;
  private secretCache: Map<string, string> = new Map();
  private envVarCache: Map<string, string | undefined> = new Map();
  /** Session-scoped LRU cache for auth profile resolutions with TTL + max size */
  private authProfileCache: Map<string, CachedCredential> = new Map();
  private tenantId?: string;
  private authToken?: string;
  private userId?: string;
  private projectId?: string;
  private environment: string;
  private secretStore?: ToolSecretStore;
  private decryptor?: SecretDecryptor;
  private oauthResolver?: OAuthTokenResolver;
  private envVarStore?: EnvVarStore;
  private configVarStore?: ConfigVarStore;
  private authProfileResolver?: AuthProfileResolver;
  private variableNamespaceIds?: string[];

  constructor(config: RuntimeSecretsProviderConfig);
  /** @deprecated Use config object constructor */
  constructor(tenantId?: string, authToken?: string, userId?: string, agentIR?: AgentIR | null);
  constructor(
    configOrTenantId?: RuntimeSecretsProviderConfig | string,
    authToken?: string,
    userId?: string,
    agentIR?: AgentIR | null,
  ) {
    this.credentialsMap = {};

    if (
      typeof configOrTenantId === 'object' &&
      configOrTenantId !== null &&
      !Array.isArray(configOrTenantId)
    ) {
      // New config object constructor
      const config = configOrTenantId as RuntimeSecretsProviderConfig;
      this.tenantId = config.tenantId;
      this.authToken = config.authToken;
      this.userId = config.userId;
      this.projectId = config.projectId;
      this.environment = config.environment ?? 'dev';
      this.secretStore = config.secretStore;
      this.decryptor = config.decryptor;
      this.oauthResolver = config.oauthResolver;
      this.envVarStore = config.envVarStore;
      this.configVarStore = config.configVarStore;
      this.authProfileResolver = config.authProfileResolver;
      this.variableNamespaceIds = config.variableNamespaceIds;
      agentIR = config.agentIR;
    } else {
      // Legacy positional constructor
      this.tenantId = configOrTenantId as string | undefined;
      this.authToken = authToken;
      this.userId = userId;
      this.environment = 'dev';
    }

    // Build credentials map from agent IR tool auth configs
    if (agentIR?.tools) {
      for (const tool of agentIR.tools) {
        const config = tool.http_binding?.auth?.config as Record<string, unknown> | undefined;
        if (config && 'credentials' in config && config.credentials) {
          Object.assign(this.credentialsMap, config.credentials as Record<string, string>);
        }
      }
    }
  }

  async getSecret(key: string, options?: { toolName?: string }): Promise<string | undefined> {
    // 1. Special case: bearer/auth tokens return session authToken
    if (key === 'auth_token' || key === 'bearer_token') {
      return this.authToken;
    }

    // 2. Check per-session cache (avoids repeated DB + decrypt)
    const cacheKey = this.buildSecretCacheKey(key, options?.toolName);
    const cached = this.secretCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // 2.5. Auth Profile resolution (when enabled)
    const fromProfile = await this.resolveFromAuthProfile(key);
    if (fromProfile !== undefined) {
      this.secretCache.set(cacheKey, fromProfile);
      log.debug('Secret resolved from auth profile', { key, layer: 'auth-profile' });
      return fromProfile;
    }

    // 3. Look up from encrypted DB-backed ToolSecret store
    const fromStore = await this.resolveFromStore(key, options?.toolName);
    if (fromStore !== undefined) {
      this.secretCache.set(cacheKey, fromStore);
      // TR4: Trace event for secret resolution
      log.debug('Secret resolved from store', { key, layer: 'store' });
      return fromStore;
    }

    // 4. Look up from agent IR credentials config map
    const fromConfig = this.resolveFromConfig(key);
    if (fromConfig !== undefined) {
      log.debug('Secret resolved from config', { key, layer: 'config' });
      return fromConfig;
    }

    // No process.env fallback — all variable resolution must go through DB.

    // TR4: Trace event for failed secret resolution
    log.warn('Secret not found in any resolution layer', {
      key,
      tenantId: this.tenantId,
      layers: 'envVar,configVar,store,config',
    });
    return undefined;
  }

  async getEnvVar(key: string): Promise<string | undefined> {
    // Check cache first — use has() to distinguish "not cached" from "cached as undefined"
    if (this.envVarCache.has(key)) {
      return this.envVarCache.get(key);
    }

    if (!this.envVarStore || !this.tenantId || !this.projectId) {
      log.warn('getEnvVar: missing required context for env var resolution', { key });
      return undefined;
    }

    try {
      const record = await this.envVarStore.findEnvVar({
        tenantId: this.tenantId,
        projectId: this.projectId,
        environment: this.environment,
        key,
        variableNamespaceIds: this.variableNamespaceIds,
      });

      if (!record) {
        log.warn('Environment variable not found', { key, tenantId: this.tenantId });
        this.envVarCache.set(key, undefined);
        return undefined;
      }

      let value = record.encryptedValue;
      if (this.decryptor && this.tenantId && typeof value === 'string' && /^enc[:_-]/.test(value)) {
        try {
          value = await this.decryptor.decryptForTenant(value, this.tenantId);
        } catch (error) {
          log.warn('Environment variable decryption failed', {
            key,
            tenantId: this.tenantId,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
          this.envVarCache.set(key, undefined);
          return undefined;
        }
      }
      if (value == null) {
        log.warn('Environment variable decryption returned null', {
          key,
          tenantId: this.tenantId,
        });
        this.envVarCache.set(key, undefined);
        return undefined;
      }
      this.envVarCache.set(key, value);
      log.debug('Environment variable resolved', { key, layer: 'envVarStore' });
      return value;
    } catch (error) {
      log.error('Failed to resolve environment variable', {
        key,
        tenantId: this.tenantId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return undefined;
    }
  }

  async getUserOAuthToken(userId: string, provider: string): Promise<string | undefined> {
    if (!this.oauthResolver || !this.tenantId) {
      // TR3: Trace event for OAuth resolution skip
      log.debug('OAuth token resolution skipped — no resolver or tenantId', { provider });
      return undefined;
    }

    const effectiveUserId = userId === 'current' ? this.userId : userId;
    if (!effectiveUserId) return undefined;

    try {
      const token = await this.oauthResolver.getAccessToken(
        this.tenantId,
        effectiveUserId,
        provider,
      );
      // TR3: Trace event for OAuth resolution result
      log.debug('OAuth token resolution', { provider, found: !!token });
      return token;
    } catch (error) {
      log.error('Failed to get user OAuth token', {
        provider,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return undefined;
    }
  }

  async getConfigVar(key: string): Promise<string | undefined> {
    if (!this.configVarStore || !this.tenantId || !this.projectId) {
      log.warn('getConfigVar: missing required context for config var resolution', { key });
      return undefined;
    }

    try {
      const record = await this.configVarStore.findConfigVar({
        tenantId: this.tenantId,
        projectId: this.projectId,
        key,
        variableNamespaceIds: this.variableNamespaceIds,
      });

      if (!record) {
        log.warn('Config variable not found', { key, tenantId: this.tenantId });
        return undefined;
      }

      log.debug('Config variable resolved', { key, layer: 'configVarStore' });
      return record.value;
    } catch (error) {
      log.error('Failed to resolve config variable', {
        key,
        tenantId: this.tenantId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return undefined;
    }
  }

  /** Get the userId bound to this provider (for OAuth token binding) */
  getUserId(): string | undefined {
    return this.userId;
  }

  /**
   * Create a new RuntimeSecretsProvider scoped to specific variable namespace IDs.
   * Shares the same stores/decryptors but filters env/config vars by namespace membership.
   */
  withNamespaceScope(variableNamespaceIds: string[]): RuntimeSecretsProvider {
    return new RuntimeSecretsProvider({
      tenantId: this.tenantId,
      authToken: this.authToken,
      userId: this.userId,
      projectId: this.projectId,
      environment: this.environment,
      secretStore: this.secretStore,
      decryptor: this.decryptor,
      oauthResolver: this.oauthResolver,
      envVarStore: this.envVarStore,
      configVarStore: this.configVarStore,
      authProfileResolver: this.authProfileResolver,
      variableNamespaceIds,
    });
  }

  /**
   * Clear all session-level caches.
   * Call this when the execution session ends to free memory.
   */
  clearSessionCache(): void {
    this.secretCache.clear();
    this.envVarCache.clear();
    this.authProfileCache.clear();
  }

  private buildSecretCacheKey(key: string, toolName?: string): string {
    return toolName ? `${toolName}:${key}` : key;
  }

  /**
   * Resolve from Auth Profile when a resolver is configured.
   * Uses session-level LRU cache with TTL to avoid redundant resolve() calls.
   */
  private async resolveFromAuthProfile(key: string): Promise<string | undefined> {
    if (!this.authProfileResolver || !this.tenantId || !this.projectId) {
      return undefined;
    }

    // Check auth profile cache first
    const cached = this.getAuthProfileCached(key);
    if (cached !== undefined) {
      log.debug('Auth profile secret resolved from session cache', { key });
      return cached;
    }

    try {
      const profile = await this.authProfileResolver.resolveBySecretKey({
        tenantId: this.tenantId,
        projectId: this.projectId,
        secretKey: key,
        environment: this.environment,
      });

      if (!profile) return undefined;

      const value = profile.secrets[key] ?? profile.secrets.apiKey;
      if (value !== undefined) {
        this.setAuthProfileCache(key, value);
      }
      return value;
    } catch (error) {
      log.debug('Auth profile secret resolution failed, falling through', {
        key,
        tenantId: this.tenantId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return undefined;
    }
  }

  /**
   * Get a value from the auth profile session cache, respecting TTL.
   */
  private getAuthProfileCached(key: string): string | undefined {
    const entry = this.authProfileCache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.cachedAt > AUTH_PROFILE_CACHE_TTL_MS) {
      this.authProfileCache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Set a value in the auth profile session cache with LRU eviction.
   */
  private setAuthProfileCache(key: string, value: string): void {
    // LRU eviction: remove oldest entry when at capacity
    if (this.authProfileCache.size >= AUTH_PROFILE_CACHE_MAX_SIZE) {
      const firstKey = this.authProfileCache.keys().next().value;
      if (firstKey) this.authProfileCache.delete(firstKey);
    }
    this.authProfileCache.set(key, { value, cachedAt: Date.now() });
  }

  /**
   * Resolve from encrypted ToolSecret store (DB-backed).
   * Queries by org + project + key + environment, decrypts with tenant key.
   * Rejects expired secrets.
   */
  private async resolveFromStore(key: string, toolName?: string): Promise<string | undefined> {
    if (!this.secretStore || !this.decryptor || !this.tenantId || !this.projectId) {
      return undefined;
    }
    if (!toolName) {
      log.debug('Tool secret store lookup skipped without tool context', {
        key,
        tenantId: this.tenantId,
      });
      return undefined;
    }

    try {
      const environments =
        this.environment === 'global' ? [this.environment] : [this.environment, 'global'];

      for (const environment of environments) {
        const record = await this.secretStore.findSecret({
          tenantId: this.tenantId,
          projectId: this.projectId,
          toolName,
          secretKey: key,
          environment,
        });

        if (!record) continue;

        // Reject expired secrets
        if (record.expiresAt && record.expiresAt < new Date()) {
          log.warn('Tool secret expired, treating as not found', {
            key,
            tenantId: this.tenantId,
            environment,
            expiresAt: record.expiresAt.toISOString(),
          });
          continue;
        }

        return await this.decryptor.decryptForTenant(record.encryptedValue, this.tenantId);
      }

      return undefined;
    } catch (error) {
      log.error('Failed to resolve secret from store', {
        key,
        tenantId: this.tenantId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return undefined;
    }
  }

  /** Resolve from agent IR tool credentials config map */
  private resolveFromConfig(key: string): string | undefined {
    return this.credentialsMap[key];
  }
}
