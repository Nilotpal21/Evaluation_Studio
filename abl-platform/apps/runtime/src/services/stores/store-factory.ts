/**
 * Store Factory
 *
 * Creates MongoDB-backed store implementations.
 * Includes DualWriteMessageStore for transparent Mongo + ClickHouse dual-write.
 *
 * Usage:
 *   const stores = getStores();   // Lazy singleton
 *   await stores.conversation.createSession(params);
 *   const registry = stores.createAgentRegistry({ tenantId, projectId });
 */

import type { ConversationStore } from '@abl/compiler/platform/stores/conversation-store.js';
import type { MessageStore } from '@abl/compiler/platform/stores/message-store.js';
import type {
  AddMessageParams,
  QueryMessagesParams,
} from '@abl/compiler/platform/stores/message-store.js';
import type { Message } from '@abl/compiler/platform/core/types';
import type { ContactStore } from '@abl/compiler/platform/stores/contact-store.js';
import type { FactStore } from '@abl/compiler/platform/stores/fact-store.js';
import type { WorkflowDefinitionStore } from '@abl/compiler/platform/stores/workflow-definition-store.js';
import type { AgentRegistry } from '@abl/compiler/platform/stores/agent-registry.js';
import type { AuditStore } from '@abl/compiler/platform/stores/audit-store.js';

import { MessageStore as MessageStoreBase } from '@abl/compiler/platform/stores/message-store.js';
import { createMongoConversationStore } from './mongo-conversation-store.js';
import { createMongoMessageStore, MongoMessageStore } from './mongo-message-store.js';
import { createMongoContactStore } from './mongo-contact-store.js';
import { createMongoFactStore } from './mongo-fact-store.js';
import { createMongoWorkflowDefinitionStore } from './mongo-workflow-definition-store.js';
import { createMongoAgentRegistry, type MongoAgentRegistryScope } from './mongo-agent-registry.js';
import { createLogger } from '@abl/compiler/platform';
import type { ClickHouseMessageStore } from './clickhouse-message-store.js';

const log = createLogger('store-factory');

// =============================================================================
// TYPES
// =============================================================================

export interface PlatformStores {
  conversation: ConversationStore;
  message: MessageStore;
  contact: ContactStore;
  fact: FactStore;
  workflowDefinition: WorkflowDefinitionStore;
  createAgentRegistry: (scope: MongoAgentRegistryScope, auditStore?: AuditStore) => AgentRegistry;
}

/** Factory function that creates a ClickHouseMessageStore for a given tenant */
export type ClickHouseStoreFactory = (tenantId: string) => Promise<ClickHouseMessageStore>;

// =============================================================================
// DUAL-WRITE MESSAGE STORE
// =============================================================================

/** Max number of per-tenant ClickHouse store instances to cache */
const MAX_CH_STORE_CACHE = 100;
/** TTL for cached ClickHouse store entries (30 minutes) */
const CH_STORE_TTL_MS = 30 * 60 * 1000;

/**
 * DualWriteMessageStore — wraps MongoMessageStore and optionally writes
 * to ClickHouse (fire-and-forget) when USE_MONGO_CLICKHOUSE=true.
 *
 * All reads delegate to Mongo. Writes go to both stores.
 * ClickHouse failures are logged but never propagate to callers.
 */
interface ChCacheEntry {
  store: ClickHouseMessageStore;
  createdAt: number;
}

export class DualWriteMessageStore extends MessageStoreBase {
  private mongo: MongoMessageStore;
  private chFactory: ClickHouseStoreFactory | null;
  /** LRU-ish bounded cache with TTL: insertion-order Map, oldest evicted at capacity */
  private chCache: Map<string, ChCacheEntry> = new Map();

  constructor(mongo: MongoMessageStore, chFactory?: ClickHouseStoreFactory) {
    super({ type: 'mongodb' });
    this.mongo = mongo;
    this.chFactory = chFactory ?? null;
  }

  /** Whether ClickHouse dual-write is active */
  private get dualWriteEnabled(): boolean {
    return process.env.USE_MONGO_CLICKHOUSE === 'true' && this.chFactory !== null;
  }

  /** Get or create a per-tenant ClickHouse store (bounded LRU cache with TTL) */
  private async getChStore(tenantId: string): Promise<ClickHouseMessageStore | null> {
    if (!this.dualWriteEnabled) return null;

    const now = Date.now();

    // Check existing entry (with TTL expiry)
    const existing = this.chCache.get(tenantId);
    if (existing) {
      if (now - existing.createdAt > CH_STORE_TTL_MS) {
        // Expired — remove and recreate
        this.chCache.delete(tenantId);
      } else {
        // Move to end for LRU freshness
        this.chCache.delete(tenantId);
        this.chCache.set(tenantId, existing);
        return existing.store;
      }
    }

    // Evict expired entries first, then oldest if still at capacity
    for (const [key, entry] of this.chCache) {
      if (now - entry.createdAt > CH_STORE_TTL_MS) {
        this.chCache.delete(key);
      }
    }
    if (this.chCache.size >= MAX_CH_STORE_CACHE) {
      const oldest = this.chCache.keys().next().value;
      if (oldest !== undefined) this.chCache.delete(oldest);
    }

    try {
      const store = await this.chFactory!(tenantId);
      this.chCache.set(tenantId, { store, createdAt: now });
      return store;
    } catch (err) {
      log.error('Failed to create ClickHouse message store for tenant', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // WRITE: Mongo (await) + ClickHouse (fire-and-forget)
  // ---------------------------------------------------------------------------

  async addMessage(params: AddMessageParams): Promise<Message> {
    const result = await this.mongo.addMessage(params);

    if (this.dualWriteEnabled) {
      // Prefer explicit tenantId param, fall back to metadata extraction
      const tenantId =
        params.tenantId ??
        ((params.metadata as Record<string, unknown> | undefined)?.tenantId as string | undefined);
      if (tenantId) {
        this.getChStore(tenantId)
          .then((chStore) => {
            if (chStore) return chStore.addMessage(params);
          })
          .catch((err) => {
            log.error('ClickHouse fire-and-forget addMessage failed', {
              sessionId: params.sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // READS: delegate to Mongo
  // ---------------------------------------------------------------------------

  async getMessages(params: QueryMessagesParams): Promise<Message[]> {
    return this.mongo.getMessages(params);
  }

  async getMessageCount(sessionId: string): Promise<number> {
    return this.mongo.getMessageCount(sessionId);
  }

  async deleteBySession(sessionId: string): Promise<number> {
    return this.mongo.deleteBySession(sessionId);
  }

  async cleanup(olderThanMs: number): Promise<number> {
    return this.mongo.cleanup(olderThanMs);
  }

  async getMessageById(
    tenantId: string,
    projectId: string,
    sessionId: string,
    messageId: string,
  ): Promise<Message | null> {
    // Reads always go through Mongo — it is the source of truth for the
    // message row. CH dual-write is fire-and-forget and may lag.
    return this.mongo.getMessageById(tenantId, projectId, sessionId, messageId);
  }

  // ---------------------------------------------------------------------------
  // SCRUB: call both stores
  // ---------------------------------------------------------------------------

  async scrubMessages(tenantId: string, contactId: string): Promise<number> {
    const mongoCount = await this.mongo.scrubMessages(tenantId, contactId);

    if (this.dualWriteEnabled) {
      this.getChStore(tenantId)
        .then((chStore) => {
          if (chStore) return chStore.scrubByContact(contactId);
        })
        .catch((err) => {
          log.error('ClickHouse scrubMessages failed', {
            tenantId,
            contactId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    return mongoCount;
  }

  async scrubMessagesBySession(tenantId: string, sessionId: string): Promise<number> {
    const mongoCount = await this.mongo.scrubMessagesBySession(tenantId, sessionId);

    if (this.dualWriteEnabled) {
      this.getChStore(tenantId)
        .then((chStore) => {
          if (chStore) return chStore.deleteBySession(sessionId);
        })
        .catch((err) => {
          log.error('ClickHouse scrubMessagesBySession failed', {
            tenantId,
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    return mongoCount;
  }

  /**
   * Write a message to ClickHouse only (no Mongo). Used by the BullMQ worker
   * which handles Mongo writes via batchCreateMessages() and needs a separate
   * CH write path for dual-write consistency.
   *
   * Fire-and-forget: CH failures are logged but never propagate.
   */
  async writeToClickHouseOnly(params: AddMessageParams): Promise<void> {
    if (!this.dualWriteEnabled) return;
    const tenantId =
      params.tenantId ??
      ((params.metadata as Record<string, unknown> | undefined)?.tenantId as string | undefined);
    if (!tenantId) return;
    try {
      const chStore = await this.getChStore(tenantId);
      if (chStore) await chStore.addMessage(params);
    } catch (err) {
      log.error('ClickHouse-only write failed', {
        sessionId: params.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Expose the underlying Mongo store for callers that need Mongo-specific methods */
  get mongoStore(): MongoMessageStore {
    return this.mongo;
  }

  /** Expose cache size for testing */
  get clickHouseCacheSize(): number {
    return this.chCache.size;
  }
}

// =============================================================================
// FACTORY
// =============================================================================

function createMongoStores(): PlatformStores {
  // Encryption for Mongo messages is handled by the Mongoose encryption plugin (pre-save hook).
  // ClickHouse encryption is handled by the interceptor in BufferedWriter.
  const mongoMessageStore = createMongoMessageStore();

  // Build ClickHouse factory if dual-write is enabled
  let chFactory: ClickHouseStoreFactory | undefined;
  if (process.env.USE_MONGO_CLICKHOUSE === 'true') {
    chFactory = async (tenantId: string): Promise<ClickHouseMessageStore> => {
      const { ClickHouseMessageStore: CHStore } = await import('./clickhouse-message-store.js');
      const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
      const client = getClickHouseClient();
      return new CHStore({ type: 'clickhouse' }, { client, tenantId });
    };
  }

  const dualWriteMessageStore = new DualWriteMessageStore(mongoMessageStore, chFactory);

  return {
    conversation: createMongoConversationStore(),
    message: dualWriteMessageStore,
    contact: createMongoContactStore(),
    fact: createMongoFactStore(),
    workflowDefinition: createMongoWorkflowDefinitionStore(),
    createAgentRegistry: (scope: MongoAgentRegistryScope, auditStore?: AuditStore) =>
      createMongoAgentRegistry(scope, auditStore),
  };
}

// =============================================================================
// SINGLETON
// =============================================================================

let _stores: PlatformStores | null = null;

/**
 * Get the platform stores (lazy singleton).
 * Creates MongoDB store instances on first call.
 */
export function getStores(): PlatformStores {
  if (!_stores) {
    _stores = createMongoStores();
  }
  return _stores;
}
