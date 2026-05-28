/**
 * Tiered Session Store
 *
 * Wraps a primary SessionStore (Redis or Memory) with MongoDB cold storage.
 * On load: tries primary first, falls back to cold store + rehydrate.
 * On save/create: writes to primary, then fire-and-forget to cold store.
 * On delete: removes from both tiers.
 *
 * The cold tier is transparent — callers use the standard SessionStore interface
 * and get durable sessions without code changes.
 */

import { createLogger } from '@abl/compiler/platform';
import type { AgentIR, CompilationOutput } from '@abl/compiler';
import type { SessionStore } from './session-store.js';
import type { SessionLocator } from './execution-scope.js';
import type { ConversationMessage, SessionData } from './types.js';
import { SessionStateRepo } from './session-state-repo.js';

const log = createLogger('tiered-session-store');

export interface TieredSessionStoreOptions {
  /** Cold storage TTL in days (default: 7) */
  coldTtlDays?: number;
  /** Debounce repeated cold-store upserts for the same session */
  coldPersistDebounceMs?: number;
  /** Whether cold storage is enabled (default: true) */
  enabled?: boolean;
}

const MAX_PENDING_COLD_PERSISTS = 10_000;

export class TieredSessionStore implements SessionStore {
  private primary: SessionStore;
  private coldRepo: SessionStateRepo;
  private enabled: boolean;
  private coldPersistDebounceMs: number;
  private pendingColdPersists = new Map<string, { session: SessionData; timer: NodeJS.Timeout }>();
  private inFlightColdPersists = new Set<Promise<void>>();

  constructor(primary: SessionStore, options?: TieredSessionStoreOptions) {
    this.primary = primary;
    this.coldRepo = new SessionStateRepo({ coldTtlDays: options?.coldTtlDays ?? 7 });
    this.enabled = options?.enabled ?? true;
    this.coldPersistDebounceMs = options?.coldPersistDebounceMs ?? 0;
  }

  // =========================================================================
  // Session CRUD — tiered with cold fallback
  // =========================================================================

  async create(session: SessionData): Promise<void> {
    log.debug('[TIERED] create — writing to primary (Redis) + scheduling cold persist', {
      sessionId: session.id,
      agentName: session.agentName,
      tenantId: session.tenantId,
      coldEnabled: this.enabled,
    });
    await this.primary.create(session);
    if (this.enabled) {
      this.scheduleColdPersist(session);
    }
  }

  async load(sessionId: string): Promise<SessionData | null> {
    // Try primary (hot) store first
    const hot = await this.primary.load(sessionId);
    if (hot) return hot;

    // Cold fallback
    if (!this.enabled) return null;

    log.info('cold restore: loading from MongoDB', { sessionId });
    const cold = await this.coldRepo.loadInternal(sessionId);
    if (!cold) return null;

    // Rehydrate: write back to primary store
    try {
      await this.primary.create(cold);
      log.info('cold restore: rehydrated to primary store', { sessionId });
    } catch (err) {
      log.warn('cold restore: failed to rehydrate to primary', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return cold;
  }

  /**
   * Load from hot (primary) store only — no cold fallback.
   * Used by session list endpoints where cold restore is wasteful.
   */
  async loadHotOnlyScoped(locator: SessionLocator): Promise<SessionData | null> {
    return this.primary.loadScoped
      ? await this.primary.loadScoped(locator)
      : await this.primary.load(locator.sessionId);
  }

  async loadScoped(locator: SessionLocator): Promise<SessionData | null> {
    const hot = this.primary.loadScoped
      ? await this.primary.loadScoped(locator)
      : await this.primary.load(locator.sessionId);
    if (hot) {
      return hot;
    }

    if (!this.enabled) {
      return null;
    }

    log.info('cold restore: loading from MongoDB (scoped)', {
      sessionId: locator.sessionId,
      tenantId: locator.tenantId,
      projectId: locator.projectId,
      scopeKind: locator.kind,
    });
    const cold = await this.coldRepo.load(locator.sessionId, locator.tenantId, locator.projectId);
    if (!cold) {
      return null;
    }

    try {
      await this.primary.create(cold);
      log.info('cold restore: rehydrated to primary store (scoped)', {
        sessionId: locator.sessionId,
        tenantId: locator.tenantId,
      });
    } catch (err) {
      log.warn('cold restore: failed to rehydrate to primary (scoped)', {
        sessionId: locator.sessionId,
        tenantId: locator.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return cold;
  }

  async getVersion(sessionId: string, knownTenantId?: string): Promise<number | null> {
    const version = await this.primary.getVersion(sessionId, knownTenantId);
    if (version !== null) return version;

    if (!this.enabled) return null;

    // Lightweight projection query — avoids loading the full cold document
    return this.coldRepo.getVersionInternal(sessionId);
  }

  async getVersionScoped(locator: SessionLocator): Promise<number | null> {
    const version = this.primary.getVersionScoped
      ? await this.primary.getVersionScoped(locator)
      : await this.primary.getVersion(locator.sessionId, locator.tenantId);
    if (version !== null) {
      return version;
    }

    if (!this.enabled) {
      return null;
    }

    return this.coldRepo.getVersion(locator.sessionId, locator.tenantId, locator.projectId);
  }

  async save(session: SessionData): Promise<boolean> {
    log.debug('[TIERED] save — updating primary (Redis) + scheduling cold persist', {
      sessionId: session.id,
      agentName: session.agentName,
      version: session.version,
      coldEnabled: this.enabled,
    });
    const result = await this.primary.save(session);
    log.debug('[TIERED] save — primary result', { sessionId: session.id, saved: result });
    if (result && this.enabled) {
      this.scheduleColdPersist(session);
    }
    return result;
  }

  async saveAndReplaceConversation(
    session: SessionData,
    messages: ConversationMessage[],
  ): Promise<boolean> {
    // Delegate to primary's pipelined method if available (RedisSessionStore)
    if (this.primary.saveAndReplaceConversation) {
      const result = await this.primary.saveAndReplaceConversation(session, messages);
      if (result && this.enabled) {
        this.scheduleColdPersist(session);
      }
      return result;
    }
    // Fallback: sequential save + replaceConversation
    const result = await this.primary.save(session);
    if (result) {
      await this.primary.replaceConversation(session.id, messages);
      if (this.enabled) {
        this.scheduleColdPersist(session);
      }
    }
    return result;
  }

  async delete(sessionId: string): Promise<void> {
    this.clearPendingColdPersist(sessionId);
    await this.primary.delete(sessionId);
    if (this.enabled) {
      this.coldRepo.deleteInternal(sessionId).catch((err) => {
        log.warn('cold delete failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  async deleteScoped(locator: SessionLocator): Promise<void> {
    this.clearPendingColdPersist(locator.sessionId);
    if (this.primary.deleteScoped) {
      await this.primary.deleteScoped(locator);
    } else {
      await this.primary.delete(locator.sessionId);
    }
    if (this.enabled) {
      this.coldRepo.delete(locator.sessionId, locator.tenantId, locator.projectId).catch((err) => {
        log.warn('cold delete failed (scoped)', {
          sessionId: locator.sessionId,
          tenantId: locator.tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /**
   * Evict a session from the hot tier (Redis) only, preserving the cold-store
   * (MongoDB session_states) doc so the session can be resumed later.
   *
   * Use this when the user starts a new chat — the old session is no longer
   * active on this connection but should remain resumable from the sidebar.
   */
  async evictHotOnly(sessionId: string, locator?: SessionLocator): Promise<void> {
    this.clearPendingColdPersist(sessionId);
    if (locator && this.primary.deleteScoped) {
      await this.primary.deleteScoped(locator);
    } else {
      await this.primary.delete(sessionId);
    }
    // Intentionally NOT deleting from cold store (session_states).
  }

  // =========================================================================
  // Conversation History — delegated to primary
  // =========================================================================

  async appendMessages(sessionId: string, messages: ConversationMessage[]): Promise<void> {
    return this.primary.appendMessages(sessionId, messages);
  }

  async getConversationHistory(sessionId: string, limit?: number): Promise<ConversationMessage[]> {
    return this.primary.getConversationHistory(sessionId, limit);
  }

  async replaceConversation(sessionId: string, messages: ConversationMessage[]): Promise<void> {
    return this.primary.replaceConversation(sessionId, messages);
  }

  async trimConversation(sessionId: string, maxMessages: number): Promise<void> {
    return this.primary.trimConversation(sessionId, maxMessages);
  }

  // =========================================================================
  // IR / Compilation Cache — delegated to primary
  // =========================================================================

  async getAgentIR(sourceHash: string): Promise<AgentIR | null> {
    return this.primary.getAgentIR(sourceHash);
  }

  async setAgentIR(sourceHash: string, ir: AgentIR): Promise<void> {
    return this.primary.setAgentIR(sourceHash, ir);
  }

  async getCompilationOutput(hash: string): Promise<CompilationOutput | null> {
    return this.primary.getCompilationOutput(hash);
  }

  async setCompilationOutput(hash: string, output: CompilationOutput): Promise<void> {
    return this.primary.setCompilationOutput(hash, output);
  }

  // =========================================================================
  // Agent Registry — delegated to primary
  // =========================================================================

  async setAgentRegistry(sessionId: string, registry: Record<string, string>): Promise<void> {
    return this.primary.setAgentRegistry(sessionId, registry);
  }

  async setAgentRegistryScoped(
    locator: SessionLocator,
    registry: Record<string, string>,
  ): Promise<void> {
    if (this.primary.setAgentRegistryScoped) {
      return this.primary.setAgentRegistryScoped(locator, registry);
    }
    return this.primary.setAgentRegistry(locator.sessionId, registry);
  }

  async getAgentRegistry(sessionId: string): Promise<Record<string, string> | null> {
    return this.primary.getAgentRegistry(sessionId);
  }

  async getAgentRegistryScoped(locator: SessionLocator): Promise<Record<string, string> | null> {
    if (this.primary.getAgentRegistryScoped) {
      return this.primary.getAgentRegistryScoped(locator);
    }
    return this.primary.getAgentRegistry(locator.sessionId);
  }

  // =========================================================================
  // Execution Lock — delegated to primary
  // =========================================================================

  async acquireLock(sessionId: string, ttlMs?: number): Promise<boolean> {
    return this.primary.acquireLock(sessionId, ttlMs);
  }

  async acquireLockScoped(locator: SessionLocator, ttlMs?: number): Promise<boolean> {
    if (this.primary.acquireLockScoped) {
      return this.primary.acquireLockScoped(locator, ttlMs);
    }
    return this.primary.acquireLock(locator.sessionId, ttlMs);
  }

  async releaseLock(sessionId: string): Promise<void> {
    return this.primary.releaseLock(sessionId);
  }

  async releaseLockScoped(locator: SessionLocator): Promise<void> {
    if (this.primary.releaseLockScoped) {
      return this.primary.releaseLockScoped(locator);
    }
    return this.primary.releaseLock(locator.sessionId);
  }

  // =========================================================================
  // TTL Management — hot store only; cold store is refreshed by debounced snapshot persists
  // =========================================================================

  async touch(sessionId: string, lastActivityAt?: Date): Promise<void> {
    await this.primary.touch(sessionId, lastActivityAt);
  }

  async touchScoped(locator: SessionLocator, lastActivityAt?: Date): Promise<void> {
    if (this.primary.touchScoped) {
      await this.primary.touchScoped(locator, lastActivityAt);
      return;
    }
    await this.primary.touch(locator.sessionId, lastActivityAt);
  }

  // =========================================================================
  // Session Resolution Keys — delegated to primary
  // =========================================================================

  async setResolutionKey(
    tenantId: string,
    channelId: string,
    artifactHash: string,
    sessionId: string,
    ttlSeconds: number,
  ): Promise<void> {
    return this.primary.setResolutionKey(tenantId, channelId, artifactHash, sessionId, ttlSeconds);
  }

  async getResolutionKey(
    tenantId: string,
    channelId: string,
    artifactHash: string,
  ): Promise<string | null> {
    return this.primary.getResolutionKey(tenantId, channelId, artifactHash);
  }

  async deleteResolutionKey(
    tenantId: string,
    channelId: string,
    artifactHash: string,
  ): Promise<void> {
    return this.primary.deleteResolutionKey(tenantId, channelId, artifactHash);
  }

  // =========================================================================
  // Access to underlying stores (for testing / advanced operations)
  // =========================================================================

  /** Get the cold storage repository (for fork, compaction, etc.) */
  getColdRepo(): SessionStateRepo {
    return this.coldRepo;
  }

  /** Get the primary (hot) store */
  getPrimaryStore(): SessionStore {
    return this.primary;
  }

  // =========================================================================
  // PRIVATE — fire-and-forget cold persistence
  // =========================================================================

  private scheduleColdPersist(session: SessionData): void {
    if (this.coldPersistDebounceMs <= 0) {
      this.persistToCold(session);
      return;
    }

    const existing = this.pendingColdPersists.get(session.id);
    if (existing) {
      clearTimeout(existing.timer);
    } else if (this.pendingColdPersists.size >= MAX_PENDING_COLD_PERSISTS) {
      const oldest = this.pendingColdPersists.keys().next().value;
      if (oldest !== undefined) {
        void this.flushPendingColdPersist(oldest);
      }
    }

    const timer = setTimeout(() => {
      void this.flushPendingColdPersist(session.id);
    }, this.coldPersistDebounceMs);
    timer.unref(); // Don't prevent process exit
    this.pendingColdPersists.set(session.id, { session: structuredClone(session), timer });
  }

  private async flushPendingColdPersist(sessionId: string): Promise<void> {
    const pending = this.pendingColdPersists.get(sessionId);
    if (!pending) {
      return;
    }
    this.pendingColdPersists.delete(sessionId);
    clearTimeout(pending.timer);
    await this.persistToCold(pending.session);
  }

  private clearPendingColdPersist(sessionId: string): void {
    const pending = this.pendingColdPersists.get(sessionId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingColdPersists.delete(sessionId);
  }

  private async persistToCold(session: SessionData): Promise<void> {
    log.debug('[TIERED] cold persist — upserting to MongoDB session_states', {
      sessionId: session.id,
      agentName: session.agentName,
      tenantId: session.tenantId,
      version: session.version,
    });
    const persistPromise = this.coldRepo
      .upsert(session)
      .catch((err) => {
        log.warn('cold persist failed (fire-and-forget)', {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.inFlightColdPersists.delete(persistPromise);
      });

    this.inFlightColdPersists.add(persistPromise);
    await persistPromise;
  }

  /** Flush all pending debounced cold persists — call during graceful shutdown. */
  async flushPendingColdPersists(): Promise<void> {
    while (this.pendingColdPersists.size > 0) {
      const ids = [...this.pendingColdPersists.keys()];
      await Promise.all(ids.map((id) => this.flushPendingColdPersist(id)));
    }

    if (this.inFlightColdPersists.size > 0) {
      await Promise.allSettled([...this.inFlightColdPersists]);
    }
  }
}
