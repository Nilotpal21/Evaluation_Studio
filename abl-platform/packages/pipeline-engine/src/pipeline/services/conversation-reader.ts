/**
 * ConversationReader — reads conversation data from MongoDB (primary store).
 *
 * Reconstructs full conversation transcripts from messages stored in MongoDB.
 * Designed for batch pipeline processing with tenant-scoped encryption.
 *
 * Messages in MongoDB are expected to be DEK-envelope ciphertext or already
 * decrypted by the Mongoose encryption plugin before they reach this reader.
 * Trace data in ClickHouse is stored as JSON or DEK-encrypted field-interceptor
 * values that are decrypted via decryptForTenantAuto().
 *
 * Includes a retry mechanism to handle the race between BullMQ message
 * persistence and session.ended event emission — messages may still be
 * in-flight when the pipeline triggers.
 *
 * Usage:
 *   const reader = new ConversationReader();
 *   const data = await reader.readSession('tenant-1', 'sess-1', { enrichWithTraces: true });
 *   const transcript = reader.formatTranscript(data);
 */
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import { Message, Session } from '@agent-platform/database/models';
import { decryptForTenantAuto, isAlreadyEncrypted } from '@agent-platform/shared/encryption';
import { createLogger } from '@abl/compiler/platform';
import { renderPipelineReadValue } from './pii-boundary.js';

const log = createLogger('conversation-reader');

/** Max retries when message count is suspiciously low (race with BullMQ persistence). */
const MESSAGE_RETRY_COUNT = 3;
const MESSAGE_RETRY_DELAY_MS = 1_000;

/**
 * Quick check: does this string look like one of the active encrypted formats?
 * This is a guard to avoid noisy decrypt attempts on plaintext content.
 */
function looksEncrypted(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  return isAlreadyEncrypted(value);
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Thrown when a message's content cannot be recovered after decryption. Permanent — do not retry. */
export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

export interface ConversationMessage {
  messageId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: string;
  channel?: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
  result: unknown;
  success: boolean;
  errorMessage?: string;
  timestamp: string;
  durationMs: number;
}

export interface ConversationEscalation {
  reason: string;
  severity: string;
  timestamp: string;
}

export interface ConversationData {
  tenantId: string;
  sessionId: string;
  messages: ConversationMessage[];
  toolCalls: ConversationToolCall[];
  escalations: ConversationEscalation[];
  metadata: {
    agentName?: string;
    channel?: string;
    messageCount: number;
    durationMs?: number;
  };
}

export interface ReadSessionOptions {
  enrichWithTraces?: boolean;
  roles?: string[];
}

export interface ConversationReaderOptions {
  tenantId?: string;
  projectId?: string;
}

// ---------------------------------------------------------------------------
// ClickHouse trace row shape (traces remain in ClickHouse)
// ---------------------------------------------------------------------------

interface TraceRow {
  event_type: string;
  agent_name: string;
  data: string;
  timestamp: string;
  duration_ms: number;
  has_error: number;
}

// ---------------------------------------------------------------------------
// Role label mapping for transcript formatting
// ---------------------------------------------------------------------------

const ROLE_LABELS: Record<string, string> = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System',
  tool: 'Tool',
};

// ---------------------------------------------------------------------------
// ConversationReader
// ---------------------------------------------------------------------------

export class ConversationReader {
  constructor(private readonly options: ConversationReaderOptions = {}) {}

  /**
   * Read and decrypt all messages for a single session from MongoDB.
   * Retries if message count is suspiciously low (BullMQ persistence race).
   * Optionally enriches with trace data from ClickHouse (tool calls, escalations).
   */
  async readSession(
    tenantId: string,
    sessionId: string,
    options?: ReadSessionOptions,
  ): Promise<ConversationData> {
    // Look up the session to get expected message count for retry logic
    const session = (await Session.findOne(
      { _id: sessionId, tenantId },
      { messageCount: 1, currentAgent: 1, channel: 1 },
    ).lean()) as { messageCount?: number; currentAgent?: string; channel?: string } | null;
    const expectedCount = session?.messageCount ?? 0;

    // Query messages from MongoDB with retry for BullMQ persistence race
    let { messages, rawCount } = await this.readMessagesFromMongo(tenantId, sessionId, options);

    // Retry if we got fewer messages than expected (BullMQ worker still flushing)
    if (expectedCount > 0 && rawCount < expectedCount) {
      for (let attempt = 1; attempt <= MESSAGE_RETRY_COUNT; attempt++) {
        log.debug('Message count lower than expected, retrying', {
          sessionId,
          got: rawCount,
          expected: expectedCount,
          attempt,
        });
        await sleep(MESSAGE_RETRY_DELAY_MS);
        const readResult = await this.readMessagesFromMongo(tenantId, sessionId, options);
        messages = readResult.messages;
        rawCount = readResult.rawCount;
        if (rawCount >= expectedCount) break;
      }
    }

    // Enrich with traces if requested
    let toolCalls: ConversationToolCall[] = [];
    let escalations: ConversationEscalation[] = [];
    let agentName = session?.currentAgent;

    if (options?.enrichWithTraces) {
      const traceData = await this.readTracesFromClickHouse(tenantId, sessionId);
      toolCalls = traceData.toolCalls;
      escalations = traceData.escalations;
      if (!agentName && traceData.agentName) {
        agentName = traceData.agentName;
      }
    }

    // Compute duration from first to last message
    let durationMs: number | undefined;
    if (messages.length >= 2) {
      const first = new Date(messages[0].timestamp).getTime();
      const last = new Date(messages[messages.length - 1].timestamp).getTime();
      durationMs = last - first;
    }

    return {
      tenantId,
      sessionId,
      messages,
      toolCalls,
      escalations,
      metadata: {
        agentName,
        channel: session?.channel ?? messages[0]?.channel,
        messageCount: messages.length,
        durationMs,
      },
    };
  }

  /**
   * Read messages for multiple sessions from MongoDB, group by session.
   */
  async readBatch(
    tenantId: string,
    sessionIds: string[],
    options?: ReadSessionOptions,
  ): Promise<Map<string, ConversationData>> {
    const results = new Map<string, ConversationData>();

    if (sessionIds.length === 0) {
      return results;
    }

    // Query all messages for all sessions in one batch
    const filter: Record<string, unknown> = {
      tenantId,
      sessionId: { $in: sessionIds },
    };
    const docs = await Message.find(filter).sort({ sessionId: 1, timestamp: 1 }).lean();

    // Group by session
    const grouped = new Map<string, any[]>();
    for (const doc of docs) {
      const sid = (doc as any).sessionId as string;
      let group = grouped.get(sid);
      if (!group) {
        group = [];
        grouped.set(sid, group);
      }
      group.push(doc);
    }

    // Process each session
    for (const sessionId of sessionIds) {
      const sessionDocs = grouped.get(sessionId) ?? [];

      let messages: ConversationMessage[] = [];
      for (const doc of sessionDocs) {
        messages.push(await this.mapMongoDoc(doc, tenantId));
      }

      // Filter by roles if specified
      if (options?.roles && options.roles.length > 0) {
        const allowedRoles = new Set(options.roles);
        messages = messages.filter((m) => allowedRoles.has(m.role));
      }

      // Compute duration
      let durationMs: number | undefined;
      if (messages.length >= 2) {
        const first = new Date(messages[0].timestamp).getTime();
        const last = new Date(messages[messages.length - 1].timestamp).getTime();
        durationMs = last - first;
      }

      results.set(sessionId, {
        tenantId,
        sessionId,
        messages,
        toolCalls: [],
        escalations: [],
        metadata: {
          channel: messages[0]?.channel,
          messageCount: messages.length,
          durationMs,
        },
      });
    }

    return results;
  }

  /**
   * Format a ConversationData object as a human-readable transcript string.
   *
   * Output format:
   *   User: Hello, I need help.
   *   Assistant: Sure, I can help you with that.
   */
  formatTranscript(data: ConversationData): string {
    return data.messages
      .map((msg) => {
        const label = ROLE_LABELS[msg.role] ?? msg.role;
        return `${label}: ${msg.content}`;
      })
      .join('\n');
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Query messages from MongoDB and decrypt if needed.
   */
  private async readMessagesFromMongo(
    tenantId: string,
    sessionId: string,
    options?: ReadSessionOptions,
  ): Promise<{ messages: ConversationMessage[]; rawCount: number }> {
    const filter: Record<string, unknown> = { sessionId, tenantId };
    const docs = await Message.find(filter).sort({ timestamp: 1 }).lean();
    const rawCount = docs.length;

    let messages: ConversationMessage[] = [];
    for (const doc of docs) {
      messages.push(await this.mapMongoDoc(doc, tenantId));
    }

    // Filter by roles if specified
    if (options?.roles && options.roles.length > 0) {
      const allowedRoles = new Set(options.roles);
      messages = messages.filter((m) => allowedRoles.has(m.role));
    }

    return { messages, rawCount };
  }

  /**
   * Map a MongoDB message document to a ConversationMessage, decrypting if needed.
   */
  private async mapMongoDoc(doc: any, tenantId: string): Promise<ConversationMessage> {
    let content: string = doc.content;

    // The plugin should have already decrypted Mongo-managed fields. Manual decrypt
    // is only a fallback for rows that still contain ciphertext.
    if (doc.encrypted && tenantId && looksEncrypted(doc.content)) {
      try {
        content = await decryptForTenantAuto(doc.content, tenantId);
      } catch (err) {
        log.warn('Failed to decrypt message content', {
          messageId: doc._id,
          sessionId: doc.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw new DecryptionError(
          `Message content unavailable after decryption for message ${String(doc._id)}`,
        );
      }
    }

    // Guard against null content (e.g., plugin decryption failed upstream). Do
    // not feed a placeholder transcript into downstream LLM/action steps.
    if (content == null) {
      log.warn('Message content is null after decryption', {
        messageId: doc._id,
        sessionId: doc.sessionId,
      });
      throw new DecryptionError(
        `Message content unavailable after decryption for message ${String(doc._id)}`,
      );
    }

    return {
      messageId: doc._id,
      role: doc.role,
      content: await renderPipelineReadValue(content, {
        tenantId,
        projectId: this.options.projectId,
        role: doc.role,
      }),
      timestamp:
        doc.timestamp instanceof Date ? doc.timestamp.toISOString() : String(doc.timestamp),
      channel: doc.channel || undefined,
      metadata:
        doc.metadata !== undefined
          ? await renderPipelineReadValue(doc.metadata, {
              tenantId,
              projectId: this.options.projectId,
              role: doc.role,
            })
          : undefined,
    };
  }

  /**
   * Read trace data (tool calls, escalations) from ClickHouse.
   */
  private async readTracesFromClickHouse(
    tenantId: string,
    sessionId: string,
  ): Promise<{
    toolCalls: ConversationToolCall[];
    escalations: ConversationEscalation[];
    agentName?: string;
  }> {
    const toolCalls: ConversationToolCall[] = [];
    const escalations: ConversationEscalation[] = [];
    let agentName: string | undefined;

    try {
      const client = getClickHouseClient();

      const tracesResult = await client.query({
        query: `
          SELECT event_type, agent_name, data, timestamp, duration_ms, has_error
          FROM abl_platform.platform_events
          WHERE tenant_id = {tenantId:String}
            AND session_id = {sessionId:String}
            AND event_type IN ('tool.call.completed', 'tool.call.failed', 'agent.escalated')
          ORDER BY timestamp ASC
          SETTINGS max_execution_time = 30
        `,
        query_params: { tenantId, sessionId },
      });

      const traceRows = ((await tracesResult.json()) as { data: TraceRow[] }).data;

      for (const trace of traceRows) {
        if (!agentName && trace.agent_name) {
          agentName = trace.agent_name;
        }

        let parsedData: Record<string, unknown>;
        try {
          // EventStore writes trace data as plain JSON (JSON.stringify in ClickHouseRowMapper).
          // Try JSON.parse first; fall back to tenant decrypt for encrypted rows.
          parsedData = JSON.parse(trace.data);
        } catch {
          try {
            const decrypted = await decryptForTenantAuto(trace.data, tenantId);
            parsedData = JSON.parse(decrypted);
          } catch (err) {
            log.warn('Failed to parse trace data', {
              eventType: trace.event_type,
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
            continue;
          }
        }

        if (trace.event_type === 'tool.call.completed' || trace.event_type === 'tool.call.failed') {
          const toolCall = {
            toolName: (parsedData.toolName as string) ?? '',
            arguments: (parsedData.arguments as Record<string, unknown>) ?? {},
            result: parsedData.result,
            success: (parsedData.success as boolean) ?? false,
            errorMessage: parsedData.errorMessage as string | undefined,
            timestamp: trace.timestamp,
            durationMs: trace.duration_ms,
          };
          toolCalls.push(
            await renderPipelineReadValue(toolCall, {
              tenantId,
              projectId: this.options.projectId,
            }),
          );
        } else if (trace.event_type === 'agent.escalated') {
          const escalation = {
            reason: (parsedData.reason as string) ?? '',
            severity: (parsedData.severity as string) ?? '',
            timestamp: trace.timestamp,
          };
          escalations.push(
            await renderPipelineReadValue(escalation, {
              tenantId,
              projectId: this.options.projectId,
            }),
          );
        }
      }
    } catch (err) {
      log.warn('Failed to read traces from ClickHouse (non-fatal)', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return { toolCalls, escalations, agentName };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
