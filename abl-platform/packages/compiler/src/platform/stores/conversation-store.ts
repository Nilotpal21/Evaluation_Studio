/**
 * Conversation Store
 *
 * Manages session state across all channels.
 * Message history is handled separately by MessageStore.
 * Captures ALL session interactions including failed/abandoned voice calls.
 */

import { randomUUID } from 'crypto';
import type {
  Session,
  SessionStatus,
  Channel,
  Environment,
  CallDisposition,
  SessionMetadata,
  SessionSource,
  VoiceMetadata,
} from '../core/types.js';
import { getCurrentTenantId } from '@agent-platform/shared';
import { createLogger } from '../logger.js';

const log = createLogger('conversation-store');
const ORPHANED_TENANT_ID = '__orphaned__';
const ABANDONED_CALL_TAG = 'abandoned_call';
const INCOMPLETE_TRANSCRIPT_TAG = 'incomplete_transcript';
const ORPHANED_TENANT_TAG = 'tenant_orphaned';

function mergeTags(existing: string[] | undefined, next: string[]): string[] {
  return Array.from(new Set([...(existing ?? []), ...next]));
}

function resolveAbandonedCallTenant(existingSession?: Pick<Session, 'tenantId'>): {
  tenantId: string;
  orphaned: boolean;
} {
  if (existingSession?.tenantId) {
    return { tenantId: existingSession.tenantId, orphaned: false };
  }

  const ambientTenantId = getCurrentTenantId();
  if (ambientTenantId) {
    return { tenantId: ambientTenantId, orphaned: false };
  }

  return { tenantId: ORPHANED_TENANT_ID, orphaned: true };
}

// =============================================================================
// INTERFACES
// =============================================================================

export interface ConversationStoreConfig {
  type: 'postgres' | 'mongodb' | 'memory';
  connectionString?: string;
  sessionTtlMs?: number;
  messageTtlMs?: number;
}

export interface CreateSessionParams {
  /** Explicit session ID. When provided, used as the MongoDB _id.
   *  Unifies runtime session ID and DB session ID into a single value. */
  id?: string;
  customerId?: string;
  anonymousId?: string;
  sessionPrincipalId?: string;
  channel: Channel;
  environment: Environment;
  agentName: string;
  agentVersion: string;
  metadata?: Partial<SessionMetadata>;
  contactId?: string;
  callerNumber?: string;
  initiatedById?: string;
  projectId?: string;
  tenantId?: string;
  workflowId?: string;
  parentId?: string;
  entryAgentName?: string;
  deploymentId?: string;
  // Session identity fields (Phase 1)
  /** SHA-256 hashed channel artifact for session resolution */
  channelArtifact?: string;
  /** Type of the channel artifact (caller_id, cookie, device_id, etc.) */
  channelArtifactType?: string;
  /** Identity tier: 0=anonymous, 1=unverified, 2=verified */
  identityTier?: number;
  /** How the user's identity was verified */
  verificationMethod?: string;
  /** SDK channel ID for channel-scoped operations */
  channelId?: string;
  source?: SessionSource;
  /** Session purpose tag — orthogonal to `source` (front-door type). */
  knownSource?: 'production' | 'eval' | 'synthetic';
}

export interface ResumeSessionParams {
  customerId?: string;
  anonymousId?: string;
  channel: Channel;
  maxAgeMs?: number;
}

export interface QuerySessionsParams {
  customerId?: string;
  channel?: Channel;
  status?: SessionStatus;
  environment?: Environment;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

// Re-export message types from message-store for backwards compatibility
export type { AddMessageParams, QueryMessagesParams } from './message-store.js';

// =============================================================================
// ABSTRACT STORE
// =============================================================================

export abstract class ConversationStore {
  protected config: ConversationStoreConfig;

  constructor(config: ConversationStoreConfig) {
    this.config = config;
  }

  // Session operations
  abstract createSession(params: CreateSessionParams): Promise<Session>;
  abstract getSession(sessionId: string): Promise<Session | null>;
  abstract updateSession(sessionId: string, updates: Partial<Session>): Promise<Session>;
  abstract endSession(sessionId: string, disposition: CallDisposition): Promise<Session>;
  abstract resumeSession(params: ResumeSessionParams): Promise<Session | null>;
  abstract querySessions(
    params: QuerySessionsParams,
  ): Promise<{ sessions: Session[]; total: number }>;

  // Voice-specific operations
  abstract recordVoiceMetadata(sessionId: string, metadata: VoiceMetadata): Promise<void>;
  abstract captureAbandonedCall(
    sessionId: string,
    lastTranscript: string,
    reason: string,
  ): Promise<void>;

  // Contact & workflow linking
  abstract linkContact(sessionId: string, contactId: string): Promise<void>;
  abstract associateWorkflow(sessionId: string, workflowId: string, stepId?: string): Promise<void>;

  // Cleanup
  abstract cleanup(olderThanMs: number): Promise<number>;
}

// =============================================================================
// IN-MEMORY IMPLEMENTATION (for development/testing)
// =============================================================================

export class InMemoryConversationStore extends ConversationStore {
  private sessions: Map<string, Session> = new Map();

  async createSession(params: CreateSessionParams): Promise<Session> {
    const session: Session = {
      id: params.id || randomUUID(),
      customerId: params.customerId,
      anonymousId: params.anonymousId,
      sessionPrincipalId: params.sessionPrincipalId,
      channel: params.channel,
      channelHistory: [params.channel],
      status: 'active',
      currentAgent: params.agentName,
      agentVersion: params.agentVersion,
      environment: params.environment,
      context: {},
      startedAt: new Date(),
      lastActivityAt: new Date(),
      metadata: params.metadata || {},
      contactId: params.contactId,
      callerNumber: params.callerNumber,
      initiatedById: params.initiatedById,
      projectId: params.projectId,
      tenantId: params.tenantId,
      workflowId: params.workflowId,
      parentId: params.parentId,
      source: params.source,
    };

    this.sessions.set(session.id, session);

    return session;
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this.sessions.get(sessionId) || null;
  }

  async updateSession(sessionId: string, updates: Partial<Session>): Promise<Session> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const updated: Session = {
      ...session,
      ...updates,
      lastActivityAt: new Date(),
    };

    // Track channel switches
    if (updates.channel && updates.channel !== session.channel) {
      updated.channelHistory = [...session.channelHistory, updates.channel];
    }

    this.sessions.set(sessionId, updated);
    return updated;
  }

  async endSession(sessionId: string, disposition: CallDisposition): Promise<Session> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const updated: Session = {
      ...session,
      status:
        disposition === 'completed'
          ? 'completed'
          : disposition === 'transferred'
            ? 'escalated'
            : 'abandoned',
      disposition,
      endedAt: new Date(),
      lastActivityAt: new Date(),
    };

    this.sessions.set(sessionId, updated);
    return updated;
  }

  async resumeSession(params: ResumeSessionParams): Promise<Session | null> {
    const maxAge = params.maxAgeMs || 24 * 60 * 60 * 1000; // 24 hours default
    const cutoff = new Date(Date.now() - maxAge);

    let bestMatch: Session | null = null;

    for (const session of this.sessions.values()) {
      const matchesCustomer = params.customerId && session.customerId === params.customerId;
      const matchesAnonymous = params.anonymousId && session.anonymousId === params.anonymousId;

      if (
        (matchesCustomer || matchesAnonymous) &&
        session.status === 'active' &&
        session.lastActivityAt > cutoff
      ) {
        // Pick the most recently active session
        if (!bestMatch || session.lastActivityAt > bestMatch.lastActivityAt) {
          bestMatch = session;
        }
      }
    }

    if (bestMatch) {
      // Track channel switch
      if (params.channel !== bestMatch.channel) {
        bestMatch.channelHistory.push(params.channel);
        bestMatch.channel = params.channel;
      }
      bestMatch.lastActivityAt = new Date();
    }

    return bestMatch;
  }

  async querySessions(
    params: QuerySessionsParams,
  ): Promise<{ sessions: Session[]; total: number }> {
    let sessions = Array.from(this.sessions.values());

    if (params.customerId) {
      sessions = sessions.filter((s) => s.customerId === params.customerId);
    }
    if (params.channel) {
      sessions = sessions.filter((s) => s.channel === params.channel);
    }
    if (params.status) {
      sessions = sessions.filter((s) => s.status === params.status);
    }
    if (params.environment) {
      sessions = sessions.filter((s) => s.environment === params.environment);
    }
    if (params.startDate) {
      sessions = sessions.filter((s) => s.startedAt >= params.startDate!);
    }
    if (params.endDate) {
      sessions = sessions.filter((s) => s.startedAt <= params.endDate!);
    }

    // Sort by most recent first
    sessions.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

    const total = sessions.length;
    const offset = params.offset || 0;
    const limit = params.limit || 50;

    return {
      sessions: sessions.slice(offset, offset + limit),
      total,
    };
  }

  async recordVoiceMetadata(sessionId: string, metadata: VoiceMetadata): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.metadata.voiceMetadata = {
        ...session.metadata.voiceMetadata,
        ...metadata,
      };
    }
  }

  /**
   * Capture abandoned call - CRITICAL for voice compliance
   * Handles session state only. The runtime is responsible for
   * saving transcript messages via MessageStore.
   */
  async captureAbandonedCall(
    sessionId: string,
    lastTranscript: string,
    reason: string,
  ): Promise<void> {
    log.warn('Abandoned call captured', { sessionId, reason, hasTranscript: !!lastTranscript });
    const session = this.sessions.get(sessionId);
    const { tenantId, orphaned } = resolveAbandonedCallTenant(session);
    const tags = orphaned
      ? [ABANDONED_CALL_TAG, INCOMPLETE_TRANSCRIPT_TAG, ORPHANED_TENANT_TAG]
      : [ABANDONED_CALL_TAG, INCOMPLETE_TRANSCRIPT_TAG];
    if (!session) {
      const now = new Date();
      // Create a minimal session record for the abandoned call
      const abandonedSession: Session = {
        id: sessionId,
        channel: 'voice',
        channelHistory: ['voice'],
        status: 'abandoned',
        currentAgent: 'unknown',
        agentVersion: 'unknown',
        environment: 'production',
        context: {
          abandonReason: reason,
          ...(lastTranscript ? { lastTranscript } : {}),
          ...(orphaned ? { tenantResolution: 'orphaned' } : {}),
        },
        startedAt: now,
        lastActivityAt: now,
        endedAt: now,
        disposition: 'abandoned',
        metadata: { tags },
        tenantId,
      };
      this.sessions.set(sessionId, abandonedSession);
    } else {
      const now = new Date();
      session.status = 'abandoned';
      session.disposition = 'abandoned';
      session.endedAt = now;
      session.lastActivityAt = now;
      session.tenantId = tenantId;
      session.context.abandonReason = reason;
      if (lastTranscript) {
        session.context.lastTranscript = lastTranscript;
      }
      if (orphaned) {
        session.context.tenantResolution = 'orphaned';
      }
      session.metadata = {
        ...session.metadata,
        tags: mergeTags(session.metadata.tags, tags),
      };
    }
  }

  async linkContact(sessionId: string, contactId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    session.contactId = contactId;
    session.lastActivityAt = new Date();
  }

  async associateWorkflow(sessionId: string, workflowId: string, stepId?: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    session.workflowId = workflowId;
    if (stepId) {
      session.workflowStepId = stepId;
    }
    session.lastActivityAt = new Date();
  }

  async cleanup(olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    let deleted = 0;

    for (const [id, session] of this.sessions.entries()) {
      if (session.lastActivityAt < cutoff && session.status !== 'active') {
        this.sessions.delete(id);
        deleted++;
      }
    }

    return deleted;
  }
}

// =============================================================================
// FACTORY
// =============================================================================

export function createConversationStore(config: ConversationStoreConfig): ConversationStore {
  switch (config.type) {
    case 'memory':
      return new InMemoryConversationStore(config);
    case 'postgres':
      // TODO: Implement PostgresConversationStore
      throw new Error('PostgreSQL conversation store not yet implemented');
    case 'mongodb':
      // TODO: Implement MongoDBConversationStore
      throw new Error('MongoDB conversation store not yet implemented');
    default:
      throw new Error(`Unknown conversation store type: ${config.type}`);
  }
}
