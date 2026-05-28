/**
 * Session Store Interface
 *
 * Defines the contract for session state persistence.
 * Implementations: MemorySessionStore (single-pod), RedisSessionStore (cluster).
 */

import type { AgentIR, CompilationOutput } from '@abl/compiler';
import type { SessionLocator } from './execution-scope.js';
import type { ConversationMessage, SessionData } from './types.js';

export interface SessionStore {
  // =========================================================================
  // Session CRUD
  // =========================================================================

  /** Create a new session */
  create(session: SessionData): Promise<void>;

  /** Load session data by ID. Returns null if not found. */
  load(sessionId: string): Promise<SessionData | null>;

  /** Scoped session load that avoids reverse-lookup and empty-tenant fallbacks. */
  loadScoped?(locator: SessionLocator): Promise<SessionData | null>;

  /** Lightweight version read for stale detection. Returns null if not found.
   *  Pass knownTenantId to skip the Redis reverse-lookup round-trip when available. */
  getVersion(sessionId: string, knownTenantId?: string): Promise<number | null>;

  /** Scoped version read that uses the canonical session locator. */
  getVersionScoped?(locator: SessionLocator): Promise<number | null>;

  /**
   * Save session data with optimistic concurrency.
   * Returns false if version conflict (another pod saved first).
   */
  save(session: SessionData): Promise<boolean>;

  /** Delete a session and all associated data */
  delete(sessionId: string): Promise<void>;

  /** Delete using the canonical session locator. */
  deleteScoped?(locator: SessionLocator): Promise<void>;

  /**
   * Evict a session from the hot tier only, preserving the cold store so the
   * session can be resumed later. Optional — falls back to full delete.
   */
  evictHotOnly?(sessionId: string, locator?: SessionLocator): Promise<void>;

  // =========================================================================
  // Conversation History
  // =========================================================================

  /** Append messages to conversation history */
  appendMessages(sessionId: string, messages: ConversationMessage[]): Promise<void>;

  /** Get conversation history, optionally limited to last N messages */
  getConversationHistory(sessionId: string, limit?: number): Promise<ConversationMessage[]>;

  /** Replace entire conversation history (used by session reset / snapshot sync) */
  replaceConversation(sessionId: string, messages: ConversationMessage[]): Promise<void>;

  /**
   * Atomic save + conversation replace in a single round-trip.
   * Combines `save()` and `replaceConversation()` into one pipeline to reduce
   * Redis round-trips from 2 to 1 during session snapshot persistence.
   *
   * Returns false on version conflict (same semantics as `save()`).
   * Implementations that don't support pipelining can fall back to sequential calls.
   */
  saveAndReplaceConversation?(
    session: SessionData,
    messages: ConversationMessage[],
  ): Promise<boolean>;

  /** Trim conversation to window (keep first message + last N-1) */
  trimConversation(sessionId: string, maxMessages: number): Promise<void>;

  // =========================================================================
  // AgentIR Cache (L2 — Redis or Memory)
  // =========================================================================

  /** Get cached AgentIR by source hash */
  getAgentIR(sourceHash: string): Promise<AgentIR | null>;

  /** Cache AgentIR by source hash */
  setAgentIR(sourceHash: string, ir: AgentIR): Promise<void>;

  // =========================================================================
  // CompilationOutput Cache
  // =========================================================================

  /** Get cached CompilationOutput by hash */
  getCompilationOutput(hash: string): Promise<CompilationOutput | null>;

  /** Cache CompilationOutput by hash */
  setCompilationOutput(hash: string, output: CompilationOutput): Promise<void>;

  // =========================================================================
  // Agent Registry (for handoff/delegate lookups)
  // =========================================================================

  /** Store agent registry for a session: { agentName: irSourceHash } */
  setAgentRegistry(sessionId: string, registry: Record<string, string>): Promise<void>;

  /** Store agent registry using the canonical session locator. */
  setAgentRegistryScoped?(locator: SessionLocator, registry: Record<string, string>): Promise<void>;

  /** Get agent registry for a session */
  getAgentRegistry(sessionId: string): Promise<Record<string, string> | null>;

  /** Get the agent registry using the canonical session locator. */
  getAgentRegistryScoped?(locator: SessionLocator): Promise<Record<string, string> | null>;

  // =========================================================================
  // Execution Lock
  // =========================================================================

  /**
   * Acquire an exclusive execution lock for a session.
   * Returns true if lock acquired, false if already held.
   */
  acquireLock(sessionId: string, ttlMs?: number): Promise<boolean>;

  /** Acquire the execution lock using the canonical session locator. */
  acquireLockScoped?(locator: SessionLocator, ttlMs?: number): Promise<boolean>;

  /** Release the execution lock for a session */
  releaseLock(sessionId: string): Promise<void>;

  /** Release the execution lock using the canonical session locator. */
  releaseLockScoped?(locator: SessionLocator): Promise<void>;

  // =========================================================================
  // TTL Management
  // =========================================================================

  /** Touch a session to refresh its TTL.
   *  When lastActivityAt is provided, the cold store persists it faithfully
   *  instead of falling back to `new Date()` (persist-time). */
  touch(sessionId: string, lastActivityAt?: Date): Promise<void>;

  /** Touch a session using the canonical session locator. */
  touchScoped?(locator: SessionLocator, lastActivityAt?: Date): Promise<void>;

  // =========================================================================
  // Session Resolution Keys
  // =========================================================================

  /** Set a resolution key mapping a channel artifact to a session ID */
  setResolutionKey(
    tenantId: string,
    channelId: string,
    artifactHash: string,
    sessionId: string,
    ttlSeconds: number,
  ): Promise<void>;

  /** Look up a session ID by channel artifact */
  getResolutionKey(
    tenantId: string,
    channelId: string,
    artifactHash: string,
  ): Promise<string | null>;

  /** Delete a resolution key */
  deleteResolutionKey(tenantId: string, channelId: string, artifactHash: string): Promise<void>;
}
