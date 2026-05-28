import {
  MessageStore,
  MessageStoreConfig,
  AddMessageParams,
  QueryMessagesParams,
} from '@abl/compiler/platform/stores/message-store.js';
import type { Message } from '@abl/compiler/platform/core/types';
import { Message as MessageModel, Session as SessionModel } from '@agent-platform/database/models';
import { getTenantConfigService, PLAN_LIMITS } from '../tenant-config.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('mongo-message-store');

/** Fallback retention when tenant config is unavailable — TEAM is safer than FREE */
const FALLBACK_MESSAGE_TTL_DAYS = PLAN_LIMITS.TEAM.messageRetentionDays;

export class MongoMessageStore extends MessageStore {
  constructor(config: MessageStoreConfig) {
    super(config);
  }

  private mapDocToMessage(doc: any): Message {
    // Decryption is handled by the Mongoose encryption plugin — no app-layer decrypt needed
    const metadata = doc.metadata ?? {};
    // Surface agentName from the top-level column into metadata for callers that
    // read `Message.metadata.agentName`. Top-level wins when present (it's the
    // canonical source post-ABLP-1068).
    if (doc.agentName && !metadata.agentName) {
      metadata.agentName = doc.agentName;
    }
    return {
      id: doc._id,
      sessionId: doc.sessionId,
      role: doc.role,
      content: doc.content,
      channel: doc.channel,
      timestamp: doc.timestamp,
      traceId: doc.traceId,
      metadata,
    };
  }

  async addMessage(params: AddMessageParams): Promise<Message> {
    const now = new Date();

    // Prefer the session document when present, but keep the caller-provided
    // scope as a bounded fallback for direct-write paths that race slightly
    // ahead of session materialization.
    const sessionFilter: Record<string, unknown> = { _id: params.sessionId };
    if (params.tenantId) sessionFilter.tenantId = params.tenantId;
    const session = await SessionModel.findOne(sessionFilter, { tenantId: 1, projectId: 1 }).lean();
    const tenantId = (session as any)?.tenantId || params.tenantId;
    const projectId = (session as any)?.projectId || params.projectId;

    if (!tenantId || !projectId) {
      throw new Error(
        `Cannot persist message: session ${params.sessionId} missing tenantId or projectId`,
      );
    }

    // Encryption is handled by the Mongoose encryption plugin in pre('save') — pass plaintext
    const content = params.content;

    // Resolve per-tenant message retention (async: Redis → DB → plan defaults)
    // Then check for project-level override (capped at plan max)
    let retentionDays = FALLBACK_MESSAGE_TTL_DAYS;
    if (tenantId) {
      try {
        const configService = getTenantConfigService();
        const config = await configService.getConfigAsync(tenantId);
        retentionDays = config.limits?.messageRetentionDays ?? FALLBACK_MESSAGE_TTL_DAYS;

        // Check for project-level override (capped at plan max by resolveProjectMessageRetention)
        if (projectId) {
          const projectRetention = await configService.resolveProjectMessageRetention(
            tenantId,
            projectId,
          );
          if (projectRetention !== null) {
            retentionDays = projectRetention;
          }
        }
      } catch (err) {
        log.warn('Failed to resolve message retention for tenant, using fallback', {
          tenantId,
          fallbackDays: FALLBACK_MESSAGE_TTL_DAYS,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const messageTimestamp =
      params.messageTimestamp != null ? new Date(params.messageTimestamp) : now;

    // When the caller provides an explicit messageId (e.g. transport
    // responseMessageId), use it as the Mongo `_id` so the persisted record
    // is addressable by that same id across all three stores.
    const createData: Record<string, unknown> = {
      ...(params.messageId ? { _id: params.messageId } : {}),
      sessionId: params.sessionId,
      tenantId,
      projectId,
      role: params.role,
      content,
      ...(params.contentEnvelope ? { contentEnvelope: params.contentEnvelope } : {}),
      channel: params.channel,
      traceId: params.traceId,
      metadata: params.metadata ?? {},
      timestamp: messageTimestamp,
      encrypted: true,
      expiresAt: new Date(messageTimestamp.getTime() + retentionDays * 86_400_000),
      ...(params.contactId && { contactId: params.contactId }),
      ...(params.hasPII !== undefined && { hasPII: params.hasPII }),
      agentName: params.agentName ?? '',
    };

    if (params.idempotencyKey) {
      createData.idempotencyKey = params.idempotencyKey;
    }

    let doc;
    try {
      doc = await MessageModel.create(createData);
    } catch (err: any) {
      // E11000 duplicate key on idempotencyKey — return the existing message
      if (err?.code === 11000 && params.idempotencyKey) {
        const [existing] = await MessageModel.find({
          idempotencyKey: params.idempotencyKey,
          tenantId,
          sessionId: params.sessionId,
        }).limit(1);
        if (existing) {
          return this.mapDocToMessage(existing);
        }
      }
      throw err;
    }

    // Non-blocking: update session's lastActivityAt and increment messageCount
    SessionModel.findOneAndUpdate(
      { _id: params.sessionId, tenantId },
      {
        $set: { lastActivityAt: now },
        $inc: { messageCount: 1 },
      },
    ).catch((err: unknown) => {
      log.warn('Session activity update failed', {
        sessionId: params.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Re-read through a post-find path so plugin-managed encrypted fields are
    // returned as plaintext to callers instead of the raw ciphertext written by create().
    const [storedDoc] = await MessageModel.find({ _id: doc._id, tenantId }).limit(1);
    return this.mapDocToMessage(storedDoc ?? doc);
  }

  async getMessages(params: QueryMessagesParams): Promise<Message[]> {
    const filter: Record<string, any> = {
      sessionId: params.sessionId,
    };
    if (!params.tenantId) {
      throw new Error('tenantId is required for tenant-scoped message queries');
    }
    filter.tenantId = params.tenantId;

    // Build role filter
    if (params.roles && params.roles.length > 0) {
      let allowedRoles = [...params.roles];
      if (!params.includeSystem) {
        allowedRoles = allowedRoles.filter((r) => r !== 'system');
      }
      if (allowedRoles.length > 0) {
        filter.role = { $in: allowedRoles };
      }
    } else if (!params.includeSystem) {
      filter.role = { $ne: 'system' };
    }

    const limit = params.limit ?? 100;
    const offset = params.offset ?? 0;

    const docs = await MessageModel.find(filter)
      .sort({ timestamp: 1 })
      .skip(offset)
      .limit(limit)
      .lean();

    return docs.map((doc: unknown) => this.mapDocToMessage(doc));
  }

  async getMessageCount(sessionId: string): Promise<number> {
    return MessageModel.countDocuments({ sessionId });
  }

  async deleteBySession(sessionId: string): Promise<number> {
    const result = await MessageModel.deleteMany({ sessionId });
    return result.deletedCount ?? 0;
  }

  async scrubMessages(tenantId: string, contactId: string): Promise<number> {
    // Use native driver to bypass encryption plugin — scrubbing deliberately
    // replaces encrypted content with a plaintext redaction marker (GDPR right-to-erasure).
    // Must also clear encryption metadata so the post-find hook sees the scrubbed
    // plaintext redaction marker instead of attempting legacy/facade decryption.
    const result = await MessageModel.collection.updateMany(
      { tenantId, contactId, scrubbed: { $ne: true } },
      {
        $set: {
          content: '[REDACTED]',
          contentEnvelope: null,
          metadata: {},
          scrubbed: true,
          encrypted: false,
          scrubbedAt: new Date(),
        },
        $unset: { ire: '', iv: '', cek: '', kmsKeyId: '' },
      },
    );
    return result.modifiedCount;
  }

  async scrubMessagesBySession(tenantId: string, sessionId: string): Promise<number> {
    // Use native driver to bypass encryption plugin — scrubbing deliberately
    // replaces encrypted content with a plaintext redaction marker (GDPR right-to-erasure).
    // Must also clear encryption metadata so the post-find hook sees the scrubbed
    // plaintext redaction marker instead of attempting legacy/facade decryption.
    const result = await MessageModel.collection.updateMany(
      { tenantId, sessionId, scrubbed: { $ne: true } },
      {
        $set: {
          content: '[REDACTED]',
          contentEnvelope: null,
          metadata: {},
          scrubbed: true,
          encrypted: false,
          scrubbedAt: new Date(),
        },
        $unset: { ire: '', iv: '', cek: '', kmsKeyId: '' },
      },
    );
    return result.modifiedCount;
  }

  async cleanup(olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);

    const result = await MessageModel.deleteMany({
      timestamp: { $lt: cutoff },
    });

    return result.deletedCount ?? 0;
  }

  async getMessageById(
    tenantId: string,
    projectId: string,
    sessionId: string,
    messageId: string,
  ): Promise<Message | null> {
    // Cross-scope reads return null (404, not 403) — see Resource Isolation
    // invariant in CLAUDE.md. tenant/project/session are all required filters.
    const doc = await MessageModel.findOne({
      _id: messageId,
      tenantId,
      projectId,
      sessionId,
    }).lean();
    if (!doc) return null;
    return this.mapDocToMessage(doc);
  }
}

export function createMongoMessageStore(config?: Partial<MessageStoreConfig>): MongoMessageStore {
  return new MongoMessageStore({
    type: 'mongodb',
    ...config,
  });
}
