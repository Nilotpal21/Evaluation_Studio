/**
 * In-Memory Session Store
 *
 * Single-pod fallback implementation of SessionStore.
 * Uses Maps for all storage — no external dependencies.
 * All operations are synchronous wrapped in resolved Promises.
 *
 * All Maps have max size limits and LRU eviction to prevent unbounded growth.
 */

import type { AgentIR, CompilationOutput } from '@abl/compiler';
import type { SessionStore } from './session-store.js';
import type { SessionLocator } from './execution-scope.js';
import type { ConversationMessage, SessionData } from './types.js';

// =============================================================================
// CAPACITY LIMITS
// =============================================================================

/** Maximum number of active sessions before eviction */
const MAX_SESSIONS = 10_000;

/** Maximum number of cached IR entries */
const MAX_IR_CACHE = 500;

/** Maximum number of cached compilations */
const MAX_COMPILATION_CACHE = 500;

/** Maximum number of resolution keys */
const MAX_RESOLUTION_KEYS = 50_000;

/** Evict oldest entries when a Map exceeds its limit */
function evictOldest<K, V>(map: Map<K, V>, maxSize: number): void {
  if (map.size <= maxSize) return;
  const excess = map.size - maxSize;
  const iter = map.keys();
  for (let i = 0; i < excess; i++) {
    const key = iter.next().value;
    if (key !== undefined) map.delete(key);
  }
}

export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionData>();
  private conversations = new Map<string, ConversationMessage[]>();
  private irCache = new Map<string, AgentIR>();
  private compilationCache = new Map<string, CompilationOutput>();
  private agentRegistries = new Map<string, Record<string, string>>();
  private locks = new Set<string>();
  private resolutionKeys = new Map<string, { sessionId: string; expiresAt: number }>();

  // =========================================================================
  // Session CRUD
  // =========================================================================

  async create(session: SessionData): Promise<void> {
    evictOldest(this.sessions, MAX_SESSIONS);
    this.sessions.set(session.id, { ...session });
    this.conversations.set(session.id, [...session.conversationHistory]);
  }

  async load(sessionId: string): Promise<SessionData | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    // Return a copy with fresh conversation history
    const conversation = this.conversations.get(sessionId) || [];
    return { ...session, conversationHistory: [...conversation] };
  }

  async loadScoped(locator: SessionLocator): Promise<SessionData | null> {
    return this.load(locator.sessionId);
  }

  // The optional tenant hint exists for SessionStore parity; the in-memory store keys by sessionId.
  async getVersion(sessionId: string, _knownTenantId?: string): Promise<number | null> {
    const session = this.sessions.get(sessionId);
    return session ? session.version : null;
  }

  async getVersionScoped(locator: SessionLocator): Promise<number | null> {
    return this.getVersion(locator.sessionId, locator.tenantId);
  }

  async save(session: SessionData): Promise<boolean> {
    const existing = this.sessions.get(session.id);
    if (!existing) return false;

    // Optimistic concurrency check
    if (existing.version !== session.version - 1) {
      return false;
    }

    this.sessions.set(session.id, { ...session });
    this.conversations.set(session.id, [...session.conversationHistory]);
    return true;
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.conversations.delete(sessionId);
    this.agentRegistries.delete(sessionId);
    this.locks.delete(sessionId);
  }

  async deleteScoped(locator: SessionLocator): Promise<void> {
    await this.delete(locator.sessionId);
  }

  // =========================================================================
  // Conversation History
  // =========================================================================

  async appendMessages(sessionId: string, messages: ConversationMessage[]): Promise<void> {
    const conv = this.conversations.get(sessionId);
    if (!conv) {
      console.warn(
        `[MemoryStore] appendMessages called for unknown session ${sessionId}, ${messages.length} messages dropped`,
      );
      return;
    }
    conv.push(...messages);
  }

  async replaceConversation(sessionId: string, messages: ConversationMessage[]): Promise<void> {
    if (!this.conversations.has(sessionId)) return;
    this.conversations.set(sessionId, [...messages]);
  }

  async getConversationHistory(sessionId: string, limit?: number): Promise<ConversationMessage[]> {
    const conv = this.conversations.get(sessionId) || [];
    if (limit && conv.length > limit) {
      // Keep first message (system/context) + last (limit-1) messages
      if (limit === 1) return [conv[0]];
      return [conv[0], ...conv.slice(-(limit - 1))];
    }
    return [...conv];
  }

  async trimConversation(sessionId: string, maxMessages: number): Promise<void> {
    const conv = this.conversations.get(sessionId);
    if (!conv || conv.length <= maxMessages) return;

    // Keep first message + last (maxMessages-1)
    if (maxMessages === 1) {
      this.conversations.set(sessionId, [conv[0]]);
      return;
    }
    const trimmed = [conv[0], ...conv.slice(-(maxMessages - 1))];
    this.conversations.set(sessionId, trimmed);
  }

  // =========================================================================
  // AgentIR Cache
  // =========================================================================

  async getAgentIR(sourceHash: string): Promise<AgentIR | null> {
    return this.irCache.get(sourceHash) || null;
  }

  async setAgentIR(sourceHash: string, ir: AgentIR): Promise<void> {
    evictOldest(this.irCache, MAX_IR_CACHE);
    this.irCache.set(sourceHash, ir);
  }

  // =========================================================================
  // CompilationOutput Cache
  // =========================================================================

  async getCompilationOutput(hash: string): Promise<CompilationOutput | null> {
    return this.compilationCache.get(hash) || null;
  }

  async setCompilationOutput(hash: string, output: CompilationOutput): Promise<void> {
    evictOldest(this.compilationCache, MAX_COMPILATION_CACHE);
    this.compilationCache.set(hash, output);
  }

  // =========================================================================
  // Agent Registry
  // =========================================================================

  async setAgentRegistry(sessionId: string, registry: Record<string, string>): Promise<void> {
    this.agentRegistries.set(sessionId, { ...registry });
  }

  async setAgentRegistryScoped(
    locator: SessionLocator,
    registry: Record<string, string>,
  ): Promise<void> {
    await this.setAgentRegistry(locator.sessionId, registry);
  }

  async getAgentRegistry(sessionId: string): Promise<Record<string, string> | null> {
    return this.agentRegistries.get(sessionId) || null;
  }

  async getAgentRegistryScoped(locator: SessionLocator): Promise<Record<string, string> | null> {
    return this.getAgentRegistry(locator.sessionId);
  }

  // =========================================================================
  // Execution Lock
  // =========================================================================

  async acquireLock(sessionId: string, _ttlMs?: number): Promise<boolean> {
    if (this.locks.has(sessionId)) return false;
    this.locks.add(sessionId);
    return true;
  }

  async acquireLockScoped(locator: SessionLocator, ttlMs?: number): Promise<boolean> {
    return this.acquireLock(locator.sessionId, ttlMs);
  }

  async releaseLock(sessionId: string): Promise<void> {
    this.locks.delete(sessionId);
  }

  async releaseLockScoped(locator: SessionLocator): Promise<void> {
    await this.releaseLock(locator.sessionId);
  }

  // =========================================================================
  // TTL Management
  // =========================================================================

  async touch(sessionId: string, lastActivityAt?: Date): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = lastActivityAt ? lastActivityAt.getTime() : Date.now();
    }
  }

  async touchScoped(locator: SessionLocator, lastActivityAt?: Date): Promise<void> {
    await this.touch(locator.sessionId, lastActivityAt);
  }

  // =========================================================================
  // Session Resolution Keys
  // =========================================================================

  async setResolutionKey(
    tenantId: string,
    channelId: string,
    artifactHash: string,
    sessionId: string,
    ttlSeconds: number,
  ): Promise<void> {
    // Purge expired keys before inserting to reclaim space
    this.purgeExpiredResolutionKeys();
    evictOldest(this.resolutionKeys, MAX_RESOLUTION_KEYS);
    const key = `resolve:${tenantId}:${channelId}:${artifactHash}`;
    this.resolutionKeys.set(key, {
      sessionId,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async getResolutionKey(
    tenantId: string,
    channelId: string,
    artifactHash: string,
  ): Promise<string | null> {
    const key = `resolve:${tenantId}:${channelId}:${artifactHash}`;
    const entry = this.resolutionKeys.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.resolutionKeys.delete(key);
      return null;
    }
    return entry.sessionId;
  }

  async deleteResolutionKey(
    tenantId: string,
    channelId: string,
    artifactHash: string,
  ): Promise<void> {
    const key = `resolve:${tenantId}:${channelId}:${artifactHash}`;
    this.resolutionKeys.delete(key);
  }

  // =========================================================================
  // Maintenance
  // =========================================================================

  /** Remove expired resolution keys to reclaim memory */
  private purgeExpiredResolutionKeys(): void {
    const now = Date.now();
    for (const [key, entry] of this.resolutionKeys) {
      if (now > entry.expiresAt) {
        this.resolutionKeys.delete(key);
      }
    }
  }

  // =========================================================================
  // Testing Helpers
  // =========================================================================

  getSessionCount(): number {
    return this.sessions.size;
  }

  getIRCacheSize(): number {
    return this.irCache.size;
  }

  clear(): void {
    this.sessions.clear();
    this.conversations.clear();
    this.irCache.clear();
    this.compilationCache.clear();
    this.agentRegistries.clear();
    this.locks.clear();
    this.resolutionKeys.clear();
  }
}
