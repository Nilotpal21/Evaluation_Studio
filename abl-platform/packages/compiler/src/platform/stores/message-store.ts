/**
 * Message Store
 *
 * Standalone message storage interface, extracted from ConversationStore.
 * Manages message history independently of session lifecycle.
 *
 * Production implementation: ClickHouseMessageStore (high-volume, columnar storage).
 * Development fallback: InMemoryMessageStore (below).
 */

import { randomUUID } from 'crypto';
import type { Message, MessageRole, Channel, MessageMetadata } from '../core/types.js';

// =============================================================================
// INTERFACES
// =============================================================================

export interface MessageStoreConfig {
  type: 'mongodb' | 'clickhouse' | 'memory';
  connectionString?: string;
  messageTtlMs?: number;
}

export interface AddMessageParams {
  sessionId: string;
  role: MessageRole;
  content: string;
  /** Serialized durable message envelope for rich/history fidelity */
  contentEnvelope?: string;
  channel: Channel;
  traceId: string;
  metadata?: Partial<MessageMetadata>;
  idempotencyKey?: string;
  /** Contact ID for cross-session message correlation (set when contact is resolved) */
  contactId?: string;
  /** Whether PII was detected in the message content */
  hasPII?: boolean;
  /** Tenant ID — used by DualWriteMessageStore to route ClickHouse writes without session lookup */
  tenantId?: string;
  /** Project ID for project-scoped message isolation (omnichannel recall) */
  projectId?: string;
  /** Explicit logical timestamp for the message (ms since epoch). When set, overrides the
   * store's default of using the DB write time. Use for user-arrival time and LLM completion time. */
  messageTimestamp?: number;
  /**
   * Explicit message id. When provided, the store MUST persist the row with this id
   * (Mongo `_id`, CH `message_id`, in-memory `id`) instead of generating a random one.
   * This is how the transport `responseMessageId` becomes the durable identifier used
   * by downstream features (e.g. feedback capture) to bind back to a specific assistant turn.
   */
  messageId?: string;
  /**
   * Agent that produced the message. Persisted as a top-level field (and as
   * `metadata.agentName`) so per-agent analytics queries do not have to parse JSON.
   */
  agentName?: string;
}

export interface QueryMessagesParams {
  sessionId: string;
  tenantId?: string;
  roles?: MessageRole[];
  limit?: number;
  offset?: number;
  includeSystem?: boolean;
}

// =============================================================================
// ABSTRACT STORE
// =============================================================================

export abstract class MessageStore {
  protected config: MessageStoreConfig;

  constructor(config: MessageStoreConfig) {
    this.config = config;
  }

  abstract addMessage(params: AddMessageParams): Promise<Message>;
  abstract getMessages(params: QueryMessagesParams): Promise<Message[]>;
  abstract getMessageCount(sessionId: string): Promise<number>;
  abstract deleteBySession(sessionId: string): Promise<number>;
  abstract cleanup(olderThanMs: number): Promise<number>;

  /**
   * Fetch a single persisted message by its id, scoped by tenant + project + session.
   * Returns `null` when the message does not exist or is outside the requested scope —
   * implementations MUST NOT return rows that belong to a different tenant/project/session.
   *
   * Used by feedback capture (and similar downstream features) to validate that a
   * client-supplied `messageId` references a real assistant turn in the active session
   * before persisting any side-effect rows.
   */
  abstract getMessageById(
    tenantId: string,
    projectId: string,
    sessionId: string,
    messageId: string,
  ): Promise<Message | null>;
}

// =============================================================================
// IN-MEMORY IMPLEMENTATION (for development/testing)
// =============================================================================

export class InMemoryMessageStore extends MessageStore {
  private messages: Map<string, Message[]> = new Map();
  /**
   * Side index for `getMessageById(...)`. Keyed by composite scope tuple so the
   * in-memory store enforces the same isolation rule as the production stores
   * (returning `null` for cross-scope lookups).
   */
  private messageScopes: Map<
    string,
    { tenantId: string; projectId: string; sessionId: string; message: Message }
  > = new Map();

  async addMessage(params: AddMessageParams): Promise<Message> {
    const metadata: MessageMetadata = { ...(params.metadata || {}) };
    if (params.agentName && !metadata.agentName) {
      metadata.agentName = params.agentName;
    }
    const message: Message = {
      id: params.messageId ?? randomUUID(),
      sessionId: params.sessionId,
      role: params.role,
      content: params.content,
      channel: params.channel,
      timestamp: new Date(),
      traceId: params.traceId,
      metadata,
    };

    const sessionMessages = this.messages.get(params.sessionId) || [];
    sessionMessages.push(message);
    this.messages.set(params.sessionId, sessionMessages);

    this.messageScopes.set(message.id, {
      tenantId: params.tenantId ?? '',
      projectId: params.projectId ?? '',
      sessionId: params.sessionId,
      message,
    });

    return message;
  }

  async getMessages(params: QueryMessagesParams): Promise<Message[]> {
    let messages = this.messages.get(params.sessionId) || [];

    if (!params.includeSystem) {
      messages = messages.filter((m) => m.role !== 'system');
    }

    if (params.roles) {
      messages = messages.filter((m) => params.roles!.includes(m.role));
    }

    // Sort by timestamp (oldest first for conversation flow)
    messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const offset = params.offset || 0;
    const limit = params.limit || 100;

    return messages.slice(offset, offset + limit);
  }

  async getMessageCount(sessionId: string): Promise<number> {
    return (this.messages.get(sessionId) || []).length;
  }

  async deleteBySession(sessionId: string): Promise<number> {
    const count = (this.messages.get(sessionId) || []).length;
    this.messages.delete(sessionId);
    return count;
  }

  async cleanup(olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    let deleted = 0;

    for (const [sessionId, msgs] of this.messages.entries()) {
      const latest = msgs[msgs.length - 1];
      if (latest && latest.timestamp < cutoff) {
        deleted += msgs.length;
        this.messages.delete(sessionId);
        for (const msg of msgs) {
          this.messageScopes.delete(msg.id);
        }
      }
    }

    return deleted;
  }

  async getMessageById(
    tenantId: string,
    projectId: string,
    sessionId: string,
    messageId: string,
  ): Promise<Message | null> {
    const entry = this.messageScopes.get(messageId);
    if (!entry) return null;
    if (entry.tenantId !== tenantId) return null;
    if (entry.projectId !== projectId) return null;
    if (entry.sessionId !== sessionId) return null;
    return entry.message;
  }
}

// =============================================================================
// FACTORY
// =============================================================================

export function createMessageStore(config: MessageStoreConfig): MessageStore {
  switch (config.type) {
    case 'memory':
      return new InMemoryMessageStore(config);
    case 'mongodb':
      throw new Error(
        'MongoDB message store requires runtime dependencies — use MongoMessageStore from @agent-platform/runtime',
      );
    case 'clickhouse':
      throw new Error(
        'ClickHouse message store requires runtime dependencies — use ClickHouseMessageStore from @agent-platform/runtime',
      );
    default:
      throw new Error(`Unknown message store type: ${config.type}`);
  }
}
