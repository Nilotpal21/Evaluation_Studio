/**
 * ClickHouse Message Store
 *
 * Implements MessageStore for ClickHouse backend.
 * Encrypts `content` using the ClickHouse field-encryption pipeline configured via
 * tenant DEK envelope encryption.
 * Metadata is stored as plaintext JSON.
 */

import { randomUUID } from 'crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import {
  MessageStore,
  type MessageStoreConfig,
  type AddMessageParams,
  type QueryMessagesParams,
} from '@abl/compiler/platform/stores/message-store.js';
import type { Message } from '@abl/compiler/platform/core/types';
import {
  BufferedClickHouseWriter,
  parseClickHouseTimestamp,
  toClickHouseDateTime,
} from '@agent-platform/database/clickhouse';
import { createLogger } from '@abl/compiler/platform';
import { getClickHouseEncryptionInterceptor } from './clickhouse-encryption-singleton.js';

const log = createLogger('clickhouse-message-store');
const WAIT_FOR_LOCAL_MUTATION_SETTING = 'SETTINGS mutations_sync = 1';

function tryParseJson(str: string): any {
  try {
    return JSON.parse(str);
  } catch {
    return undefined;
  }
}

interface ClickHouseMessageRow {
  tenant_id: string;
  project_id: string;
  session_id: string;
  created_at: string;
  message_id: string;
  contact_id: string;
  role: string;
  channel: string;
  agent_name: string;
  content: string;
  metadata: string;
  encrypted: number;
  key_version: number;
  has_pii: number;
  scrubbed: number;
  trace_id: string;
}

export interface ClickHouseMessageStoreOptions {
  client: ClickHouseClient;
  tenantId: string;
}

export class ClickHouseMessageStore extends MessageStore {
  private client: ClickHouseClient;
  private tenantId: string;
  private writer: BufferedClickHouseWriter<ClickHouseMessageRow>;

  constructor(config: MessageStoreConfig, options: ClickHouseMessageStoreOptions) {
    super(config);
    this.client = options.client;
    this.tenantId = options.tenantId;
    this.writer = new BufferedClickHouseWriter(this.client, {
      table: 'abl_platform.messages',
      encryptionInterceptor: getClickHouseEncryptionInterceptor() ?? undefined,
      onError: (err, ctx) => {
        log.error('Writer flush error', {
          error: err instanceof Error ? err.message : String(err),
          context: ctx,
        });
      },
    });
  }

  async addMessage(params: AddMessageParams): Promise<Message> {
    // Honour an explicit messageId so the CH `message_id` lines up with Mongo
    // `_id` and the transport `responseMessageId` (ABLP-1068). Fall back to a
    // generated UUID when the caller does not provide one.
    const messageId = params.messageId ?? randomUUID();
    const now = new Date();

    // Encryption is handled by the ClickHouse interceptor in BufferedWriter.flush() — pass plaintext
    const encInterceptor = getClickHouseEncryptionInterceptor();
    const row: ClickHouseMessageRow = {
      tenant_id: this.tenantId,
      project_id: params.projectId || '',
      session_id: params.sessionId,
      created_at: toClickHouseDateTime(now),
      message_id: messageId,
      contact_id: params.contactId || '',
      role: params.role,
      channel: params.channel,
      agent_name: params.agentName ?? params.metadata?.agentName ?? '',
      content: params.content,
      metadata: JSON.stringify(params.metadata || {}),
      encrypted: encInterceptor ? 1 : 0,
      key_version: encInterceptor ? 1 : 0,
      has_pii: params.hasPII ? 1 : 0,
      scrubbed: 0,
      trace_id: params.traceId || '',
    };

    this.writer.insert(row);
    // Flush immediately for dev; in production the 5s timer handles it
    await this.writer.flush().catch((err) => {
      log.error('Immediate flush failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    const metadata = { ...(params.metadata || {}) };
    if (row.agent_name && !metadata.agentName) {
      metadata.agentName = row.agent_name;
    }

    return {
      id: messageId,
      sessionId: params.sessionId,
      role: params.role,
      content: params.content,
      channel: params.channel,
      timestamp: now,
      traceId: params.traceId,
      metadata,
    };
  }

  async getMessages(params: QueryMessagesParams): Promise<Message[]> {
    const conditions = [`tenant_id = {tenantId:String}`, `session_id = {sessionId:String}`];
    const queryParams: Record<string, string | number> = {
      tenantId: this.tenantId,
      sessionId: params.sessionId,
    };

    if (!params.includeSystem) {
      conditions.push(`role != 'system'`);
    }

    if (params.roles && params.roles.length > 0) {
      conditions.push(`role IN ({roles:Array(String)})`);
      queryParams.roles = params.roles as unknown as string;
    }

    const offset = params.offset || 0;
    const limit = params.limit || 100;

    const result = await this.client.query({
      query: `
        SELECT *
        FROM abl_platform.messages
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at ASC
        LIMIT {limit:UInt32} OFFSET {offset:UInt32}
        SETTINGS max_execution_time = 10
      `,
      query_params: { ...queryParams, limit, offset },
      format: 'JSONEachRow',
    });

    let rows = await result.json<ClickHouseMessageRow>();

    // Decrypt fields via interceptor (handles _enc marker detection)
    const encInterceptor = getClickHouseEncryptionInterceptor();
    if (encInterceptor) {
      rows = (await encInterceptor.afterQuery(
        'messages',
        rows as unknown as Record<string, unknown>[],
      )) as unknown as ClickHouseMessageRow[];
    }

    return rows.map((row: ClickHouseMessageRow) => this.mapRowToMessage(row));
  }

  private mapRowToMessage(row: ClickHouseMessageRow): Message {
    const metadata = row.metadata ? tryParseJson(row.metadata) || {} : {};
    if (row.agent_name && !metadata.agentName) {
      metadata.agentName = row.agent_name;
    }
    return {
      id: row.message_id,
      sessionId: row.session_id,
      role: row.role as Message['role'],
      content: row.content,
      channel: row.channel as Message['channel'],
      timestamp: parseClickHouseTimestamp(row.created_at),
      traceId: row.trace_id || '',
      metadata,
    } as Message;
  }

  async getMessageCount(sessionId: string): Promise<number> {
    const result = await this.client.query({
      query: `
        SELECT count() AS cnt
        FROM abl_platform.messages
        WHERE tenant_id = {tenantId:String} AND session_id = {sessionId:String}
        SETTINGS max_execution_time = 10
      `,
      query_params: { tenantId: this.tenantId, sessionId },
      format: 'JSONEachRow',
    });

    const rows = await result.json<{ cnt: string }>();
    return parseInt(rows[0]?.cnt || '0', 10);
  }

  async deleteBySession(sessionId: string): Promise<number> {
    const count = await this.getMessageCount(sessionId);

    await this.client.command({
      query: `
        ALTER TABLE abl_platform.messages DELETE
        WHERE tenant_id = {tenantId:String} AND session_id = {sessionId:String}
        ${WAIT_FOR_LOCAL_MUTATION_SETTING}
      `,
      query_params: { tenantId: this.tenantId, sessionId },
    });

    return count;
  }

  async cleanup(olderThanMs: number): Promise<number> {
    const cutoffDate = new Date(Date.now() - olderThanMs);

    const countResult = await this.client.query({
      query: `
        SELECT count() AS cnt
        FROM abl_platform.messages
        WHERE tenant_id = {tenantId:String} AND created_at < {cutoff:DateTime64(3)}
        SETTINGS max_execution_time = 10
      `,
      query_params: { tenantId: this.tenantId, cutoff: toClickHouseDateTime(cutoffDate) },
      format: 'JSONEachRow',
    });

    const rows = await countResult.json<{ cnt: string }>();
    const count = parseInt(rows[0]?.cnt || '0', 10);

    if (count > 0) {
      await this.client.command({
        query: `
          ALTER TABLE abl_platform.messages DELETE
          WHERE tenant_id = {tenantId:String} AND created_at < {cutoff:DateTime64(3)}
          ${WAIT_FOR_LOCAL_MUTATION_SETTING}
        `,
        query_params: { tenantId: this.tenantId, cutoff: toClickHouseDateTime(cutoffDate) },
      });
    }

    return count;
  }

  async scrubByContact(contactId: string): Promise<void> {
    await scrubContactMessages(this.client, this.tenantId, contactId);
  }

  async getMessageById(
    tenantId: string,
    projectId: string,
    sessionId: string,
    messageId: string,
  ): Promise<Message | null> {
    // Cross-scope reads return null — per Resource Isolation invariant.
    // tenantId argument MUST match this store's bound tenantId; an explicit
    // mismatch is a programmer error rather than a missing row.
    if (tenantId !== this.tenantId) return null;

    const result = await this.client.query({
      query: `
        SELECT *
        FROM abl_platform.messages
        WHERE tenant_id = {tenantId:String}
          AND project_id = {projectId:String}
          AND session_id = {sessionId:String}
          AND message_id = {messageId:String}
        ORDER BY created_at DESC
        LIMIT 1
        SETTINGS max_execution_time = 10
      `,
      query_params: { tenantId, projectId, sessionId, messageId },
      format: 'JSONEachRow',
    });

    let rows = await result.json<ClickHouseMessageRow>();
    if (rows.length === 0) return null;

    // Decrypt fields via interceptor (handles _enc marker detection)
    const encInterceptor = getClickHouseEncryptionInterceptor();
    if (encInterceptor) {
      rows = (await encInterceptor.afterQuery(
        'messages',
        rows as unknown as Record<string, unknown>[],
      )) as unknown as ClickHouseMessageRow[];
    }

    const row = rows[0];
    if (!row) return null;
    return this.mapRowToMessage(row);
  }

  async close(): Promise<void> {
    await this.writer.close();
  }
}

/** Shared SQL for scrubbing all messages belonging to a contact */
const SCRUB_CONTACT_SQL = `ALTER TABLE abl_platform.messages
UPDATE scrubbed = 1, content = '[REDACTED]', metadata = '{}', encrypted = 0
WHERE tenant_id = {tenantId:String}
AND contact_id = {contactId:String}
${WAIT_FOR_LOCAL_MUTATION_SETTING}`;

async function scrubContactMessages(
  client: ClickHouseClient,
  tenantId: string,
  contactId: string,
): Promise<void> {
  await client.command({
    query: SCRUB_CONTACT_SQL,
    query_params: { tenantId, contactId },
  });
}

export async function clickhouseContactCleanup(
  client: ClickHouseClient,
  tenantId: string,
  contactId: string,
): Promise<void> {
  await scrubContactMessages(client, tenantId, contactId);
}
