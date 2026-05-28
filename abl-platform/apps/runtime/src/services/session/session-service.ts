/**
 * Session Service
 *
 * Orchestration layer over SessionStore. Handles:
 * - Session lifecycle (create, load hydrated, save diffs)
 * - IR resolution via L1 (pod-local) cache + L2 (store) cache
 * - Conversation window management
 * - Store factory (Memory vs Redis)
 */

import { createHash } from 'crypto';
import type { AgentIR, CompilationOutput } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import type { SessionLocator } from './execution-scope.js';
import type { SessionStore } from './session-store.js';
import type { ConversationMessage, SessionData, HydratedSession, SessionConfig } from './types.js';
import { DEFAULT_SESSION_CONFIG } from './types.js';
import { MemorySessionStore } from './memory-session-store.js';

const log = createLogger('session-service');
const DEFAULT_SESSION_SERVICE_CONFIG: SessionConfig = { ...DEFAULT_SESSION_CONFIG };

export const SESSION_SERVICE_SYNC_REDIS_INIT_ERROR =
  'Redis-backed session storage must be initialized with ensureSessionService() before synchronous access.';
export const SESSION_SERVICE_REDIS_FALLBACK_DISABLED_ERROR =
  'Redis-backed session storage could not be initialized and memory fallback is disabled.';

// =============================================================================
// L1 CACHE (Pod-local LRU for AgentIR)
// =============================================================================

class LRUCache<V> {
  private cache = new Map<string, V>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict least recently used (first entry)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}

// =============================================================================
// SESSION SERVICE
// =============================================================================

export class SessionService {
  readonly store: SessionStore;
  private readonly config: SessionConfig;
  private readonly distributedStore: boolean;
  private readonly irL1Cache: LRUCache<AgentIR>;
  private readonly compilationL1Cache: LRUCache<CompilationOutput>;

  constructor(
    store?: SessionStore,
    config?: Partial<SessionConfig>,
    options?: { distributedStore?: boolean },
  ) {
    this.config = { ...DEFAULT_SESSION_CONFIG, ...config };
    this.store = store || new MemorySessionStore();
    this.distributedStore = options?.distributedStore ?? false;
    this.irL1Cache = new LRUCache<AgentIR>(this.config.irCacheMaxEntries);
    this.compilationL1Cache = new LRUCache<CompilationOutput>(this.config.irCacheMaxEntries);
  }

  // =========================================================================
  // Hash Utilities
  // =========================================================================

  /**
   * Compute a stable hash for the full AgentIR object.
   *
   * This is intentionally broader than the model-resolution snapshot
   * fingerprint used by LLM caches: session IR caches want whole-agent
   * identity, not just the execution/model subset.
   */
  computeIRHash(ir: AgentIR): string {
    const content = JSON.stringify(ir);
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  /** Compute a stable hash for a CompilationOutput */
  computeCompilationHash(output: CompilationOutput): string {
    const content = JSON.stringify(output);
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  // =========================================================================
  // Session Lifecycle
  // =========================================================================

  /**
   * Create a new session and cache its IR/compilation.
   * Returns a HydratedSession ready for execution.
   */
  async createSession(params: {
    id: string;
    agentName: string;
    agentIR: AgentIR | null;
    compilationOutput: CompilationOutput | null;
    channel?: string;
    handoffStack?: string[];
    initialContext?: Record<string, unknown>;
    isFlowMode?: boolean;
    entryPoint?: string;
    tenantId?: string;
    projectId?: string;
    authToken?: string;
    userId?: string;
    permissions?: string[];
    deploymentId?: string;
    environment?: string;
    agentVersions?: Record<string, number>;
    agentRawVersions?: Record<string, string>;
    callerContext?: import('@agent-platform/shared/types').CallerContext;
    executionScopeKind?: import('./execution-scope.js').ExecutionScope['kind'];
    /** Per-tenant max session age in seconds for dynamic Redis TTL */
    maxAgeSeconds?: number;
    /** Per-tenant idle timeout in seconds for dynamic Redis TTL */
    idleSeconds?: number;
  }): Promise<HydratedSession> {
    // Cache IR and compute hash
    let irSourceHash = '';
    if (params.agentIR) {
      irSourceHash = this.computeIRHash(params.agentIR);
      this.irL1Cache.set(irSourceHash, params.agentIR);
      await this.store.setAgentIR(irSourceHash, params.agentIR);
    }

    // Cache compilation and compute hash
    let compilationHash: string | null = null;
    if (params.compilationOutput) {
      compilationHash = this.computeCompilationHash(params.compilationOutput);
      this.compilationL1Cache.set(compilationHash, params.compilationOutput);
      await this.store.setCompilationOutput(compilationHash, params.compilationOutput);
    }

    const now = Date.now();

    const sessionData: SessionData = {
      id: params.id,
      agentName: params.agentName,
      irSourceHash,
      compilationHash,
      conversationHistory: [],
      state: {
        gatherProgress: {},
        conversationPhase: 'start',
        context: {},
      },
      dataValues: params.initialContext || {
        session: { channel: params.channel || 'digital' },
      },
      dataGatheredKeys: [],
      version: 0,
      executionTreeValues: {},
      isComplete: false,
      isEscalated: false,
      transferInitiated: false,
      handoffStack: params.handoffStack || [params.agentName],
      delegateStack: [],
      currentFlowStep: params.isFlowMode ? params.entryPoint : undefined,
      waitingForInput: undefined,
      tenantId: params.tenantId,
      projectId: params.projectId,
      authToken: params.authToken,
      userId: params.userId,
      permissions: params.permissions,
      deploymentId: params.deploymentId,
      environment: params.environment,
      agentVersions: params.agentVersions,
      agentRawVersions: params.agentRawVersions,
      // Session identity
      callerContext: params.callerContext,
      executionScopeKind: params.executionScopeKind,
      // Lifecycle — not yet initialized (ON_START not executed)
      initialized: false,
      createdAt: now,
      lastActivityAt: now,
      // Dynamic TTL from tenant security config
      maxAgeSeconds: params.maxAgeSeconds,
      idleSeconds: params.idleSeconds,
      // Thread model — initialize with empty (runtime creates initial thread)
      threads: [],
      activeThreadIndex: 0,
      threadStack: [],
    };

    await this.store.create(sessionData);

    // Return hydrated session
    return {
      ...sessionData,
      agentIR: params.agentIR,
      compilationOutput: params.compilationOutput,
    };
  }

  /**
   * Load a session and resolve its AgentIR from cache.
   * Returns null if session not found.
   */
  async loadSession(sessionId: string): Promise<HydratedSession | null> {
    const sessionData = await this.store.load(sessionId);
    return this.hydrateSessionData(sessionData, sessionId);
  }

  async loadSessionScoped(locator: SessionLocator): Promise<HydratedSession | null> {
    const sessionData = this.store.loadScoped
      ? await this.store.loadScoped(locator)
      : await this.store.load(locator.sessionId);
    return this.hydrateSessionData(sessionData, locator.sessionId);
  }

  /**
   * Load raw session metadata from the hot (primary) store only.
   * No IR resolution, no cold storage fallback.
   * Used by session list endpoints where cold restore is wasteful
   * and only currently-active sessions need live enrichment.
   */
  async loadSessionMetadataScoped(locator: SessionLocator): Promise<SessionData | null> {
    // Use hot-only path if available (TieredSessionStore) to avoid cold restore spam
    const store = this.store as any;
    if (typeof store.loadHotOnlyScoped === 'function') {
      return store.loadHotOnlyScoped(locator);
    }
    return store.loadScoped ? await store.loadScoped(locator) : await store.load(locator.sessionId);
  }

  /**
   * Save session state. Increments version for optimistic concurrency.
   * Returns false on version conflict.
   */
  async saveSession(session: SessionData): Promise<boolean> {
    // lastActivityAt is intentionally preserved from session — it reflects true user interaction
    // time, not persist time. The executor sets session.lastActivityAt on each user interaction.
    const updated = { ...session, version: session.version + 1 };
    return this.store.save(updated);
  }

  /**
   * Lightweight version read for stale detection across pods.
   * Returns null if the session is not found.
   */
  async getVersion(sessionId: string, knownTenantId?: string): Promise<number | null> {
    return this.store.getVersion(sessionId, knownTenantId);
  }

  async getVersionScoped(locator: SessionLocator): Promise<number | null> {
    if (this.store.getVersionScoped) {
      return this.store.getVersionScoped(locator);
    }
    return this.store.getVersion(locator.sessionId, locator.tenantId);
  }

  /**
   * Delete a session and all associated data.
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.store.delete(sessionId);
  }

  async deleteSessionScoped(locator: SessionLocator): Promise<void> {
    if (this.store.deleteScoped) {
      await this.store.deleteScoped(locator);
      return;
    }
    await this.store.delete(locator.sessionId);
  }

  /**
   * Evict a session from the hot tier (Redis) only.
   * The cold-store (MongoDB session_states) doc is preserved so the session
   * can be resumed later from the sidebar.
   *
   * Use this when the user starts a new chat — the old session is displaced
   * from the active connection but should remain resumable.
   */
  async evictSessionHotOnly(sessionId: string, locator?: SessionLocator): Promise<void> {
    if (this.store.evictHotOnly) {
      await this.store.evictHotOnly(sessionId, locator ?? undefined);
      return;
    }
    // Fallback for stores that don't implement evictHotOnly: full delete
    if (locator && this.store.deleteScoped) {
      await this.store.deleteScoped(locator);
    } else {
      await this.store.delete(sessionId);
    }
  }

  /** Refresh TTL on all session keys without modifying version or data.
   *  When lastActivityAt is provided, the cold store persists it faithfully. */
  async touch(sessionId: string, lastActivityAt?: Date): Promise<void> {
    return this.store.touch(sessionId, lastActivityAt);
  }

  async touchScoped(locator: SessionLocator, lastActivityAt?: Date): Promise<void> {
    if (this.store.touchScoped) {
      return this.store.touchScoped(locator, lastActivityAt);
    }
    return this.store.touch(locator.sessionId, lastActivityAt);
  }

  // =========================================================================
  // Conversation Management
  // =========================================================================

  /**
   * Append messages and enforce sliding window.
   * Keeps first message (system/context) + last (windowSize - 1).
   */
  async appendToConversation(sessionId: string, messages: ConversationMessage[]): Promise<void> {
    await this.store.appendMessages(sessionId, messages);
    await this.store.trimConversation(sessionId, this.config.conversationWindow);
  }

  async replaceConversation(sessionId: string, messages: ConversationMessage[]): Promise<void> {
    await this.store.replaceConversation(sessionId, messages);
  }

  /**
   * Save session state and replace conversation in a single batched operation.
   * When the store supports pipelining (Redis), this reduces round-trips from 2 to 1.
   * Falls back to sequential save() + replaceConversation() for stores without support.
   *
   * Returns false on version conflict (same semantics as saveSession()).
   */
  async saveSessionAndConversation(
    session: SessionData,
    messages: ConversationMessage[],
  ): Promise<boolean> {
    // lastActivityAt is intentionally preserved from session — it reflects true user interaction
    // time, not persist time. The executor sets session.lastActivityAt on each user interaction.
    const updated = { ...session, version: session.version + 1 };

    // Use pipelined method if available (RedisSessionStore)
    if (this.store.saveAndReplaceConversation) {
      return this.store.saveAndReplaceConversation(updated, messages);
    }

    // Fallback: sequential save + replace
    const saved = await this.store.save(updated);
    if (saved) {
      await this.store.replaceConversation(session.id, messages);
    }
    return saved;
  }

  // =========================================================================
  // IR / Compilation Caching
  // =========================================================================

  /**
   * Cache an AgentIR and return its hash.
   * Stores in both L1 (pod-local) and L2 (store).
   */
  async cacheAgentIR(ir: AgentIR): Promise<string> {
    const hash = this.computeIRHash(ir);
    this.irL1Cache.set(hash, ir);
    await this.store.setAgentIR(hash, ir);
    return hash;
  }

  /**
   * Resolve an AgentIR by hash. Checks L1 then L2.
   */
  async resolveAgentIR(hash: string): Promise<AgentIR | null> {
    if (!hash) return null;
    const cached = this.irL1Cache.get(hash);
    if (cached) return cached;

    const fromStore = await this.store.getAgentIR(hash);
    if (fromStore) {
      this.irL1Cache.set(hash, fromStore);
    }
    return fromStore;
  }

  /**
   * Cache a CompilationOutput and return its hash.
   */
  async cacheCompilationOutput(output: CompilationOutput): Promise<string> {
    const hash = this.computeCompilationHash(output);
    this.compilationL1Cache.set(hash, output);
    await this.store.setCompilationOutput(hash, output);
    return hash;
  }

  /**
   * Resolve a CompilationOutput by hash. Checks L1 then L2.
   */
  async resolveCompilationOutput(hash: string): Promise<CompilationOutput | null> {
    if (!hash) return null;
    const cached = this.compilationL1Cache.get(hash);
    if (cached) return cached;

    const fromStore = await this.store.getCompilationOutput(hash);
    if (fromStore) {
      this.compilationL1Cache.set(hash, fromStore);
    }
    return fromStore;
  }

  // =========================================================================
  // Agent Registry
  // =========================================================================

  async setAgentRegistry(sessionId: string, registry: Record<string, string>): Promise<void> {
    await this.store.setAgentRegistry(sessionId, registry);
  }

  async setAgentRegistryScoped(
    locator: SessionLocator,
    registry: Record<string, string>,
  ): Promise<void> {
    if (this.store.setAgentRegistryScoped) {
      await this.store.setAgentRegistryScoped(locator, registry);
      return;
    }
    await this.store.setAgentRegistry(locator.sessionId, registry);
  }

  async getAgentRegistry(sessionId: string): Promise<Record<string, string> | null> {
    return this.store.getAgentRegistry(sessionId);
  }

  async getAgentRegistryScoped(locator: SessionLocator): Promise<Record<string, string> | null> {
    if (this.store.getAgentRegistryScoped) {
      return this.store.getAgentRegistryScoped(locator);
    }
    return this.store.getAgentRegistry(locator.sessionId);
  }

  // =========================================================================
  // Execution Lock
  // =========================================================================

  async acquireLock(sessionId: string): Promise<boolean> {
    return this.store.acquireLock(sessionId, this.config.lockTtlMs);
  }

  async acquireLockScoped(locator: SessionLocator): Promise<boolean> {
    if (this.store.acquireLockScoped) {
      return this.store.acquireLockScoped(locator, this.config.lockTtlMs);
    }
    return this.store.acquireLock(locator.sessionId, this.config.lockTtlMs);
  }

  async releaseLock(sessionId: string): Promise<void> {
    await this.store.releaseLock(sessionId);
  }

  async releaseLockScoped(locator: SessionLocator): Promise<void> {
    if (this.store.releaseLockScoped) {
      await this.store.releaseLockScoped(locator);
      return;
    }
    await this.store.releaseLock(locator.sessionId);
  }

  // =========================================================================
  // Config Access
  // =========================================================================

  getConfig(): SessionConfig {
    return this.config;
  }

  isDistributed(): boolean {
    return this.distributedStore;
  }

  private async hydrateSessionData(
    sessionData: SessionData | null,
    sessionId: string,
  ): Promise<HydratedSession | null> {
    if (!sessionData) {
      return null;
    }

    let agentIR: AgentIR | null = null;
    if (sessionData.irSourceHash) {
      agentIR = this.irL1Cache.get(sessionData.irSourceHash) || null;
      if (!agentIR) {
        agentIR = await this.store.getAgentIR(sessionData.irSourceHash);
        if (agentIR) {
          this.irL1Cache.set(sessionData.irSourceHash, agentIR);
        }
      }
    }
    if (sessionData.irSourceHash && !agentIR) {
      log.warn(
        `[SessionService] IR not found for hash "${sessionData.irSourceHash}" — session ${sessionId} may not function correctly`,
      );
    }

    let compilationOutput: CompilationOutput | null = null;
    if (sessionData.compilationHash) {
      compilationOutput = this.compilationL1Cache.get(sessionData.compilationHash) || null;
      if (!compilationOutput) {
        compilationOutput = await this.store.getCompilationOutput(sessionData.compilationHash);
        if (compilationOutput) {
          this.compilationL1Cache.set(sessionData.compilationHash, compilationOutput);
        }
      }
    }
    if (sessionData.compilationHash && !compilationOutput) {
      log.warn(
        `[SessionService] CompilationOutput not found for hash "${sessionData.compilationHash}" — session ${sessionId}`,
      );
    }

    return {
      ...sessionData,
      agentIR,
      compilationOutput,
    };
  }
}

// =============================================================================
// FACTORY
// =============================================================================

let sessionServiceInstance: SessionService | null = null;
let sessionServiceDefaultConfig: SessionConfig = { ...DEFAULT_SESSION_SERVICE_CONFIG };

function resolveSessionServiceConfig(config?: Partial<SessionConfig>): SessionConfig {
  return { ...sessionServiceDefaultConfig, ...config };
}

export function configureSessionServiceDefaults(config?: Partial<SessionConfig>): void {
  sessionServiceDefaultConfig = resolveSessionServiceConfig(config);
}

/**
 * Get or create the singleton SessionService.
 * Factory wires RedisSessionStore when Redis is available and configured,
 * otherwise falls back to MemorySessionStore.
 */
export function getSessionService(config?: Partial<SessionConfig>): SessionService {
  if (!sessionServiceInstance) {
    const resolvedConfig = resolveSessionServiceConfig(config);
    if (resolvedConfig.store === 'redis') {
      throw new Error(SESSION_SERVICE_SYNC_REDIS_INIT_ERROR);
    }

    // Default to memory only when the effective configuration explicitly allows it.
    sessionServiceInstance = new SessionService(new MemorySessionStore(), resolvedConfig);
    log.info('[SessionService] Initialized with MemorySessionStore (sync)');
  }
  return sessionServiceInstance;
}

/**
 * Async factory that properly initializes Redis-backed session store when configured.
 * Use this during startup or in async code paths.
 */
export async function ensureSessionService(
  config?: Partial<SessionConfig>,
  options?: { allowFallbackToMemory?: boolean },
): Promise<SessionService> {
  const resolvedConfig = resolveSessionServiceConfig(config);
  const allowFallbackToMemory = options?.allowFallbackToMemory ?? resolvedConfig.store !== 'redis';
  if (sessionServiceInstance) {
    if (resolvedConfig.store !== 'redis' || sessionServiceInstance.isDistributed()) {
      return sessionServiceInstance;
    }

    log.info('[SessionService] Upgrading existing singleton to distributed session store');
  }

  let store: import('./session-store.js').SessionStore;
  let distributedStore = false;

  if (resolvedConfig.store === 'redis') {
    try {
      const { ensureRedisInitialized, isRedisAvailable, getRedisClient } =
        await import('../redis/redis-client.js');
      await ensureRedisInitialized();
      const redisClient = getRedisClient();

      if (redisClient) {
        // Wait briefly for connection to establish
        await new Promise((resolve) => setTimeout(resolve, 500));

        if (isRedisAvailable()) {
          const { RedisSessionStore } = await import('./redis-session-store.js');
          // Wire optional encryption for at-rest session data
          let encryptionService;
          try {
            const { encryptForTenantAuto, decryptForTenantAuto, isTenantEncryptionReady } =
              await import('@agent-platform/shared/encryption');
            if (!isTenantEncryptionReady()) {
              throw new Error('Tenant DEK encryption is not initialized for session storage.');
            }
            encryptionService = {
              encryptForTenant: (plaintext: string, tenantId: string) =>
                encryptForTenantAuto(plaintext, tenantId, '_tenant', '_tenant'),
              decryptForTenant: (ciphertext: string, tenantId: string) =>
                decryptForTenantAuto(ciphertext, tenantId),
            };
          } catch (error) {
            throw new Error(
              `Tenant DEK encryption is required for Redis session storage: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          store = new RedisSessionStore(redisClient, {
            sessionTtlMinutes: resolvedConfig.sessionTtlMinutes,
            irTtlMinutes: resolvedConfig.sessionTtlMinutes,
            encryptionService,
          });
          distributedStore = true;
          log.info('[SessionService] Initialized with RedisSessionStore (encrypted)');
        } else {
          if (!allowFallbackToMemory) {
            throw new Error(SESSION_SERVICE_REDIS_FALLBACK_DISABLED_ERROR);
          }
          store = new MemorySessionStore();
          log.warn('[SessionService] Redis not ready, falling back to MemorySessionStore');
        }
      } else {
        if (!allowFallbackToMemory) {
          throw new Error(SESSION_SERVICE_REDIS_FALLBACK_DISABLED_ERROR);
        }
        store = new MemorySessionStore();
        log.warn('[SessionService] Redis not available, falling back to MemorySessionStore');
      }
    } catch (err) {
      if (!allowFallbackToMemory) {
        throw err instanceof Error ? err : new Error(SESSION_SERVICE_REDIS_FALLBACK_DISABLED_ERROR);
      }
      store = new MemorySessionStore();
      log.warn('failed to load Redis, falling back to MemorySessionStore', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    store = new MemorySessionStore();
    log.info('[SessionService] Initialized with MemorySessionStore');
  }

  // Wrap with TieredSessionStore for cold storage when enabled
  if (resolvedConfig.coldStorageEnabled) {
    try {
      const { TieredSessionStore } = await import('./tiered-session-store.js');
      store = new TieredSessionStore(store, {
        coldTtlDays: resolvedConfig.coldTtlDays,
        coldPersistDebounceMs: resolvedConfig.coldPersistDebounceMs,
        enabled: true,
      });
      log.info(`[SessionService] Cold storage enabled (TTL: ${resolvedConfig.coldTtlDays} days)`);
    } catch (err) {
      log.warn('failed to initialize cold storage, continuing without it', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  sessionServiceInstance = new SessionService(store, resolvedConfig, {
    distributedStore,
  });
  return sessionServiceInstance;
}

/**
 * Create a SessionService with a specific store (for testing or explicit config).
 */
export function createSessionService(
  store: SessionStore,
  config?: Partial<SessionConfig>,
  options?: { distributedStore?: boolean },
): SessionService {
  return new SessionService(store, config, options);
}

/**
 * Reset the singleton (for testing).
 */
export function resetSessionService(): void {
  sessionServiceInstance = null;
  sessionServiceDefaultConfig = { ...DEFAULT_SESSION_SERVICE_CONFIG };
}

export function peekSessionService(): SessionService | null {
  return sessionServiceInstance;
}
