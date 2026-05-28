/**
 * Resolve Session Use Case
 *
 * Looks up an existing session via a tenant-scoped resolution key and returns
 * the durable session-resolution provenance record.
 * Accepts a SessionResolutionStore port -- no concrete infrastructure dependency.
 */

import type { SessionResolutionRecord } from '../domain/session-resolution-record.js';

// =============================================================================
// PORT INTERFACE
// =============================================================================

/** Port for session resolution key storage (implemented by infrastructure). */
export interface SessionResolutionStore {
  findByKey(
    tenantId: string,
    channelId: string,
    artifactHash: string,
  ): Promise<SessionResolutionRecord | null>;

  save(
    key: import('../domain/session-resolution-record.js').SessionResolutionWriteInput,
  ): Promise<void>;
}

// =============================================================================
// RESULT TYPE
// =============================================================================

export type ResolveSessionResult =
  | {
      found: true;
      record: SessionResolutionRecord;
      sessionId: string;
      sessionLocator: SessionResolutionRecord['sessionLocator'];
      sessionPrincipalId: string;
    }
  | { found: false; sessionId?: undefined };

// =============================================================================
// USE CASE
// =============================================================================

export class ResolveSession {
  constructor(private readonly store: SessionResolutionStore) {}

  async execute(
    tenantId: string,
    channelId: string,
    artifactHash: string,
  ): Promise<ResolveSessionResult> {
    const match = await this.store.findByKey(tenantId, channelId, artifactHash);

    if (match) {
      return {
        found: true,
        record: match,
        sessionId: match.sessionLocator.sessionId,
        sessionLocator: match.sessionLocator,
        sessionPrincipalId: match.sessionPrincipalId,
      };
    }

    return { found: false };
  }
}
