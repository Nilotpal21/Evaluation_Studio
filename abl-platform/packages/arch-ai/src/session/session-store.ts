/**
 * Session store factory for the active engine.
 *
 * Provides a thin Model-agnostic wrapper over the ArchSessions Mongoose collection
 * for fetching schema-versioned Arch sessions. Message handlers use this to decouple from direct
 * Model imports so the dependency stays explicit.
 *
 * Source of truth: docs/superpowers/specs/2026-04-17-arch-ai-orchestration-redesign-design.md §6.1
 */

import type { ArchSessionV2 } from '../types/session-v2.js';
import { SCHEMA_VERSION_V2 } from '../types/session-v2.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface SessionStoreContext {
  tenantId: string;
  userId: string;
}

export interface SessionStoreOptions {
  /** Mongoose Model<unknown> for the arch_sessions collection. */
  ArchSessions: {
    findOne(
      filter: Record<string, unknown>,
      projection?: Record<string, unknown>,
    ): { lean(): Promise<unknown> };
  };
}

export interface SessionStore {
  /**
   * Get a schema-versioned session by sessionId, scoped by tenantId + userId.
   * Returns null if not found or not owned by the caller.
   */
  getSession(ctx: SessionStoreContext, sessionId: string): Promise<ArchSessionV2 | null>;
}

// ─── Factory ──────────────────────────────────────────────────────────────

/**
 * Create a session store backed by the provided ArchSessions model.
 */
export function createSessionStore(opts: SessionStoreOptions): SessionStore {
  return {
    async getSession(ctx: SessionStoreContext, sessionId: string): Promise<ArchSessionV2 | null> {
      const doc = await opts.ArchSessions.findOne({
        _id: sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        schemaVersion: SCHEMA_VERSION_V2,
      }).lean();

      if (!doc) return null;
      return doc as ArchSessionV2;
    },
  };
}
