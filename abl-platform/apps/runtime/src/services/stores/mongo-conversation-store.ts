import crypto from 'crypto';
import {
  ConversationStore,
  ConversationStoreConfig,
  CreateSessionParams,
  ResumeSessionParams,
  QuerySessionsParams,
} from '@abl/compiler/platform/stores/conversation-store.js';
import type {
  Session,
  CallDisposition,
  SessionSource,
  VoiceMetadata,
} from '@abl/compiler/platform/core/types';
import {
  Attachment as AttachmentModel,
  Message as MessageModel,
  Session as SessionModel,
} from '@agent-platform/database/models';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';
import { withTenantContext } from '@agent-platform/database/mongo';
import { getCurrentTenantId } from '@agent-platform/shared-auth/middleware';
import { hasPersistedSessionActivity } from '../session-activity.js';

/** Minimal interface satisfied by RuntimeEventBus — avoids circular deps with event-bus types */
interface StoreEventBus {
  emit(event: Record<string, unknown>): void;
}

function inferSessionSource(params: CreateSessionParams): SessionSource {
  if (params.source) {
    return params.source;
  }

  if (params.channel === 'web_debug') {
    return {
      type: 'studio',
      workspaceUserId: params.initiatedById ?? null,
    };
  }

  const endUserId = params.customerId ?? params.anonymousId ?? null;
  if (params.channelId) {
    return {
      type: 'channel',
      channelId: params.channelId,
      contactId: params.contactId ?? null,
      endUserId,
    };
  }

  return {
    type: 'public',
    contactId: params.contactId ?? null,
    endUserId,
  };
}

export class MongoConversationStore extends ConversationStore {
  private _eventBus: StoreEventBus | null = null;

  constructor(config: ConversationStoreConfig) {
    super(config);
  }

  /** Set EventBus for session lifecycle event emission (wired from server.ts) */
  setEventBus(bus: StoreEventBus): void {
    this._eventBus = bus;
  }

  /** Fire-and-forget session lifecycle event emission. No-ops when bus is null. */
  private emitSessionEvent(type: string, session: Session, extra?: Record<string, unknown>): void {
    if (!this._eventBus) return;
    try {
      this._eventBus.emit({
        eventId: crypto.randomUUID(),
        type,
        tenantId: session.tenantId || '',
        projectId: session.projectId || '',
        sessionId: session.id,
        agentName: session.currentAgent || '',
        channel: session.channel || 'unknown',
        timestamp: new Date().toISOString(),
        payload: extra ?? {},
      });
    } catch {
      // Fire-and-forget: never block store operations
    }
  }

  /**
   * Bridge shared ALS tenant context to the database ALS context.
   * Reads tenantId from the shared AsyncLocalStorage (set by unified-auth
   * for HTTP or runWithTenantContext for WebSocket) and sets the database
   * ALS so the Mongoose tenant-isolation plugin auto-injects tenantId filters.
   *
   * Fail-closed: throws if no tenant context is available, preventing
   * unscoped queries from leaking data across tenants.
   */
  private async withTenant<T>(fn: () => Promise<T>): Promise<T> {
    const tenantId = getCurrentTenantId();
    if (!tenantId) {
      throw new AppError('Tenant context required for database operation', {
        ...ErrorCodes.UNAUTHORIZED,
      });
    }
    return withTenantContext({ tenantId }, fn);
  }

  private mapDocToSession(doc: any): Session {
    return {
      id: doc._id,
      customerId: doc.customerId,
      anonymousId: doc.anonymousId,
      sessionPrincipalId: doc.sessionPrincipalId,
      channel: doc.channel,
      channelHistory: doc.channelHistory ?? [],
      status: doc.status,
      currentAgent: doc.currentAgent,
      agentVersion: doc.agentVersion,
      environment: doc.environment,
      context: doc.context ?? {},
      startedAt: doc.startedAt,
      lastActivityAt: doc.lastActivityAt,
      endedAt: doc.endedAt,
      disposition: doc.disposition,
      metadata: doc.metadata ?? {},
      contactId: doc.contactId,
      callerNumber: doc.callerNumber,
      initiatedById: doc.initiatedById,
      projectId: doc.projectId,
      tenantId: doc.tenantId,
      workflowId: doc.workflowId,
      workflowStepId: doc.workflowStepId,
      parentId: doc.parentId,
      callDuration: doc.callDuration,
      dispositionCode: doc.dispositionCode,
      archivedAt: doc.archivedAt,
      source: doc.source ?? null,
      knownSource: doc.knownSource ?? null,
    };
  }

  async createSession(params: CreateSessionParams): Promise<Session> {
    // Validate caller-provided session ID — prevent oversized or malformed _id values
    if (params.id) {
      if (params.id.length > 128 || !/^[\w-]+$/.test(params.id)) {
        throw new AppError(
          'Invalid session ID format — must be alphanumeric/hyphens, max 128 chars',
          {
            ...ErrorCodes.VALIDATION_ERROR,
          },
        );
      }
    }

    const now = new Date();
    const doc = await SessionModel.create({
      ...(params.id && { _id: params.id }),
      tenantId: params.tenantId,
      projectId: params.projectId,
      customerId: params.customerId,
      anonymousId: params.anonymousId,
      sessionPrincipalId: params.sessionPrincipalId ?? params.anonymousId,
      channel: params.channel,
      channelHistory: params.channel ? [params.channel] : [],
      currentAgent: params.agentName,
      agentVersion: params.agentVersion,
      environment: params.environment ?? 'production',
      entryAgentName: params.entryAgentName || params.agentName,
      context: {},
      metadata: params.metadata ?? {},
      status: 'active',
      startedAt: now,
      lastActivityAt: now,
      contactId: params.contactId,
      callerNumber: params.callerNumber,
      initiatedById: params.initiatedById,
      source: inferSessionSource(params),
      workflowId: params.workflowId,
      parentId: params.parentId,
      messageCount: 0,
      tokenCount: 0,
      estimatedCost: 0,
      errorCount: 0,
      handoffCount: 0,
      isTest: false,
      tags: [],
      ...(params.deploymentId && { deploymentId: params.deploymentId }),
      // Session identity fields (Phase 1)
      ...(params.channelArtifact && { channelArtifact: params.channelArtifact }),
      ...(params.channelArtifactType && { channelArtifactType: params.channelArtifactType }),
      ...(params.identityTier != null && { identityTier: params.identityTier }),
      ...(params.verificationMethod && { verificationMethod: params.verificationMethod }),
      ...(params.channelId && { channelId: params.channelId }),
      ...(params.knownSource && { knownSource: params.knownSource }),
    });

    const result = this.mapDocToSession(doc);
    this.emitSessionEvent('session.created', result, {
      customerId: params.customerId,
      anonymousId: params.anonymousId,
      deploymentId: params.deploymentId,
    });
    return result;
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this.withTenant(async () => {
      const doc = await SessionModel.findOne({ _id: sessionId }).lean();
      if (!doc) return null;
      return this.mapDocToSession(doc);
    });
  }

  async updateSession(sessionId: string, updates: Partial<Session>): Promise<Session> {
    return this.withTenant(async () => {
      const existing = await SessionModel.findOne({ _id: sessionId }).lean();
      if (!existing) {
        throw new AppError(`Session not found: ${sessionId}`, { ...ErrorCodes.NOT_FOUND });
      }

      const updateFields: Record<string, unknown> = {
        lastActivityAt: new Date(),
      };

      if (updates.currentAgent !== undefined) updateFields.currentAgent = updates.currentAgent;
      if (updates.agentVersion !== undefined) updateFields.agentVersion = updates.agentVersion;
      if (updates.status !== undefined) updateFields.status = updates.status;
      if (updates.channel !== undefined) {
        updateFields.channel = updates.channel;

        if (updates.channel !== existing.channel) {
          const existingHistory =
            Array.isArray(existing.channelHistory) && existing.channelHistory.length > 0
              ? existing.channelHistory
              : existing.channel
                ? [existing.channel]
                : [];
          updateFields.channelHistory = [...existingHistory, updates.channel];
        }
      }
      if (updates.context !== undefined) updateFields.context = updates.context;
      if (updates.metadata !== undefined) updateFields.metadata = updates.metadata;
      if (updates.environment !== undefined) updateFields.environment = updates.environment;
      if (updates.disposition !== undefined) updateFields.disposition = updates.disposition;
      if (updates.dispositionCode !== undefined)
        updateFields.dispositionCode = updates.dispositionCode;
      if (updates.contactId !== undefined) updateFields.contactId = updates.contactId;
      if (updates.sessionPrincipalId !== undefined)
        updateFields.sessionPrincipalId = updates.sessionPrincipalId;
      if (updates.callerNumber !== undefined) updateFields.callerNumber = updates.callerNumber;
      if (updates.workflowId !== undefined) updateFields.workflowId = updates.workflowId;
      if (updates.workflowStepId !== undefined)
        updateFields.workflowStepId = updates.workflowStepId;
      if (updates.endedAt !== undefined) updateFields.endedAt = updates.endedAt;
      if (updates.callDuration !== undefined) updateFields.callDuration = updates.callDuration;

      const doc = await SessionModel.findOneAndUpdate(
        { _id: sessionId },
        { $set: updateFields },
        { new: true, lean: true },
      );

      if (!doc) {
        throw new AppError(`Session not found: ${sessionId}`, { ...ErrorCodes.NOT_FOUND });
      }

      return this.mapDocToSession(doc);
    });
  }

  async endSession(sessionId: string, disposition: CallDisposition): Promise<Session> {
    return this.withTenant(async () => {
      const now = new Date();

      // If the session never had any messages, it was a ghost connection
      // (React Strict Mode double-mount, dropped WS, failed voice call, etc.),
      // and it also accumulated no durable activity such as traces, token usage,
      // or uploaded attachments, delete it instead of keeping a useless record.
      // NOTE: Still emit session.ended so downstream consumers receive closure.
      const existing = await SessionModel.findOne({ _id: sessionId }).lean();
      const scopedArtifactFilter =
        existing && typeof existing.tenantId === 'string'
          ? {
              sessionId,
              tenantId: existing.tenantId,
              ...(typeof existing.projectId === 'string' && existing.projectId.length > 0
                ? { projectId: existing.projectId }
                : {}),
            }
          : null;
      const [hasPersistedMessage, hasAttachment] =
        scopedArtifactFilter !== null
          ? await Promise.all([
              MessageModel.exists(scopedArtifactFilter).then(Boolean),
              AttachmentModel.exists(scopedArtifactFilter).then(Boolean),
            ])
          : [false, false];
      const activity = existing as
        | (typeof existing & {
            messageCount?: number;
            traceEventCount?: number;
            tokenCount?: number;
            errorCount?: number;
            handoffCount?: number;
          })
        | null;
      const messageCount = activity?.messageCount ?? 0;
      const traceEventCount = activity?.traceEventCount ?? 0;
      const tokenCount = activity?.tokenCount ?? 0;
      const errorCount = activity?.errorCount ?? 0;
      const handoffCount = activity?.handoffCount ?? 0;
      const hasDurableActivity = hasPersistedSessionActivity({
        messageCount,
        traceEventCount,
        tokenCount,
        errorCount,
        handoffCount,
        hasPersistedMessage,
        hasAttachment,
      });

      if (existing && !hasDurableActivity) {
        const { deleteSession: cascadeDeleteSession } =
          await import('@agent-platform/database/cascade');
        await cascadeDeleteSession(sessionId);
        const ghostResult = this.mapDocToSession({
          ...existing,
          status: 'ended',
          disposition,
          endedAt: now,
        });
        const durationMs = ghostResult.startedAt
          ? Date.now() - ghostResult.startedAt.getTime()
          : undefined;
        this.emitSessionEvent('session.ended', ghostResult, {
          reason: disposition,
          durationMs,
        });
        return ghostResult;
      }

      const doc = await SessionModel.findOneAndUpdate(
        { _id: sessionId },
        {
          $set: {
            status: 'ended',
            disposition,
            endedAt: now,
            lastActivityAt: now,
          },
        },
        { new: true, lean: true },
      );

      if (!doc) {
        throw new AppError(`Session not found: ${sessionId}`, { ...ErrorCodes.NOT_FOUND });
      }

      const result = this.mapDocToSession(doc);
      const durationMs = result.startedAt ? Date.now() - result.startedAt.getTime() : undefined;
      this.emitSessionEvent('session.ended', result, {
        reason: disposition,
        durationMs,
      });
      return result;
    });
  }

  async resumeSession(params: ResumeSessionParams): Promise<Session | null> {
    return this.withTenant(async () => {
      const query: Record<string, any> = {
        status: { $in: ['active', 'paused'] },
        channel: params.channel,
      };

      if (params.customerId) {
        query.customerId = params.customerId;
      }
      if (params.anonymousId) {
        query.anonymousId = params.anonymousId;
      }
      if (params.maxAgeMs) {
        query.lastActivityAt = { $gte: new Date(Date.now() - params.maxAgeMs) };
      }

      const doc = await SessionModel.findOne(query).sort({ lastActivityAt: -1 }).lean();

      if (!doc) return null;

      // Reactivate if paused
      if (doc.status === 'paused') {
        const updated = await SessionModel.findOneAndUpdate(
          { _id: doc._id },
          {
            $set: {
              status: 'active',
              lastActivityAt: new Date(),
            },
          },
          { new: true, lean: true },
        );
        if (!updated) return null;
        return this.mapDocToSession(updated);
      }

      return this.mapDocToSession(doc);
    });
  }

  async querySessions(
    params: QuerySessionsParams,
  ): Promise<{ sessions: Session[]; total: number }> {
    return this.withTenant(async () => {
      const filter: Record<string, any> = {};

      if (params.customerId) filter.customerId = params.customerId;
      if (params.status) filter.status = params.status;
      if (params.channel) filter.channel = params.channel;
      if (params.environment) filter.environment = params.environment;

      if (params.startDate || params.endDate) {
        filter.startedAt = {};
        if (params.startDate) filter.startedAt.$gte = params.startDate;
        if (params.endDate) filter.startedAt.$lte = params.endDate;
      }

      const limit = params.limit ?? 50;
      const offset = params.offset ?? 0;

      const [docs, total] = await Promise.all([
        SessionModel.find(filter).sort({ lastActivityAt: -1 }).skip(offset).limit(limit).lean(),
        SessionModel.countDocuments(filter),
      ]);

      return {
        sessions: docs.map((doc: unknown) => this.mapDocToSession(doc)),
        total,
      };
    });
  }

  async recordVoiceMetadata(sessionId: string, metadata: VoiceMetadata): Promise<void> {
    return this.withTenant(async () => {
      await SessionModel.findOneAndUpdate(
        { _id: sessionId },
        {
          $set: {
            'metadata.voice': metadata,
            lastActivityAt: new Date(),
          },
        },
      );
    });
  }

  async captureAbandonedCall(
    sessionId: string,
    lastTranscript: string,
    reason: string,
  ): Promise<void> {
    return this.withTenant(async () => {
      await SessionModel.findOneAndUpdate(
        { _id: sessionId },
        {
          $set: {
            status: 'ended',
            disposition: 'abandoned',
            'metadata.abandonReason': reason,
            'metadata.lastTranscript': lastTranscript,
            endedAt: new Date(),
            lastActivityAt: new Date(),
          },
        },
      );
    });
  }

  async linkContact(sessionId: string, contactId: string): Promise<void> {
    return this.withTenant(async () => {
      await SessionModel.findOneAndUpdate(
        { _id: sessionId },
        {
          $set: {
            contactId,
            lastActivityAt: new Date(),
          },
        },
      );
    });
  }

  async associateWorkflow(sessionId: string, workflowId: string, stepId?: string): Promise<void> {
    return this.withTenant(async () => {
      const update: Record<string, any> = {
        workflowId,
        lastActivityAt: new Date(),
      };
      if (stepId !== undefined) {
        update.workflowStepId = stepId;
      }

      await SessionModel.findOneAndUpdate({ _id: sessionId }, { $set: update });
    });
  }

  async cleanup(olderThanMs: number): Promise<number> {
    return this.withTenant(async () => {
      const cutoff = new Date(Date.now() - olderThanMs);

      const result = await SessionModel.deleteMany({
        status: 'ended',
        endedAt: { $lt: cutoff },
      });

      return result.deletedCount ?? 0;
    });
  }
}

export function createMongoConversationStore(
  config?: Partial<ConversationStoreConfig>,
): MongoConversationStore {
  return new MongoConversationStore({
    type: 'mongodb',
    ...config,
  });
}
