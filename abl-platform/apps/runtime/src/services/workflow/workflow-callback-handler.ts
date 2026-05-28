/**
 * Workflow Callback Handler — processes push callbacks from workflow-engine
 * for async workflow executions. Persists results to Redis, injects session
 * messages, and broadcasts WebSocket events.
 */
import { createLogger } from '@abl/compiler/platform';
import { verifyWebhookSignature } from '@agent-platform/shared-kernel/security';
import type { RedisClient } from '@agent-platform/redis';
import { z } from 'zod';
import type {
  WebSocketConnectionManager,
  ManagedClientState,
} from '../../websocket/connection-manager.js';
import { buildRedisKey } from './workflow-status-tool.js';

const log = createLogger('workflow-callback-handler');

const DEFAULT_ASYNC_RESULT_TTL_HOURS = 24;
const MAX_OUTPUT_SUMMARY_LENGTH = 2000;

const WorkflowCallbackPayloadSchema = z.object({
  executionId: z.string().min(1),
  tenantId: z.string().min(1),
  projectId: z.string().min(1),
  sessionId: z.string().min(1),
  workflowId: z.string().min(1),
  workflowName: z.string().min(1),
  status: z.string().min(1),
  output: z.record(z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  source: z.literal('agent_tool'),
});

export type WorkflowCallbackPayload = z.infer<typeof WorkflowCallbackPayloadSchema>;

/** Minimal interface for the message store dependency (avoids importing full DualWriteMessageStore). */
interface MessageStoreWriter {
  addMessage(params: {
    sessionId: string;
    role: 'system';
    content: string;
    channel: 'api';
    traceId: string;
    tenantId?: string;
    projectId?: string;
  }): Promise<unknown>;
}

export interface WorkflowCallbackHandlerConfig {
  redis: RedisClient;
  messageStore: MessageStoreWriter;
  internalWsManager: WebSocketConnectionManager<ManagedClientState>;
  sdkWsManager: WebSocketConnectionManager<ManagedClientState>;
  internalSecret: string;
  asyncResultTtlHours?: number;
}

export class WorkflowCallbackHandler {
  private readonly cfg: WorkflowCallbackHandlerConfig;
  private readonly ttlSeconds: number;

  constructor(cfg: WorkflowCallbackHandlerConfig) {
    this.cfg = cfg;
    this.ttlSeconds = (cfg.asyncResultTtlHours ?? DEFAULT_ASYNC_RESULT_TTL_HOURS) * 3600;
  }

  /**
   * Verify HMAC signature using the internal callback secret.
   */
  verifyHmac(body: string, signature: string, timestamp: string): boolean {
    return verifyWebhookSignature(this.cfg.internalSecret, body, signature, timestamp);
  }

  /**
   * Process a validated callback payload: persist to Redis, inject session message, broadcast WS event.
   */
  async handleCallback(
    rawPayload: unknown,
  ): Promise<{ injected: boolean; duplicate?: boolean; error?: string }> {
    const parsed = WorkflowCallbackPayloadSchema.safeParse(rawPayload);
    if (!parsed.success) {
      return { injected: false, error: parsed.error.message };
    }
    const payload = parsed.data;

    log.info('tool.workflow.callback.received', {
      executionId: payload.executionId,
      workflowId: payload.workflowId,
      sessionId: payload.sessionId,
      status: payload.status,
    });

    // Persist to Redis for polling fallback — SETNX prevents duplicate processing
    const redisKey = buildRedisKey(payload.tenantId, payload.projectId, payload.executionId);
    const redisValue = JSON.stringify({
      status: payload.status,
      output: payload.output ?? null,
      error: payload.error ? `${payload.error.code}: ${payload.error.message}` : null,
      workflowId: payload.workflowId,
      workflowName: payload.workflowName,
      executionId: payload.executionId,
      sessionId: payload.sessionId,
      projectId: payload.projectId,
      completedAt: new Date().toISOString(),
    });

    let isDuplicate = false;
    try {
      const setResult = await this.cfg.redis.set(redisKey, redisValue, 'EX', this.ttlSeconds, 'NX');
      // ioredis SET ... NX returns 'OK' on success, null when key already exists
      if (setResult === null) {
        isDuplicate = true;
        log.info('tool.workflow.callback.duplicate', {
          executionId: payload.executionId,
          sessionId: payload.sessionId,
        });
        return { injected: false, duplicate: true };
      }
    } catch (err) {
      log.warn('Failed to persist async result to Redis', {
        executionId: payload.executionId,
        error: err instanceof Error ? err.message : String(err),
      });
      // On Redis failure, proceed with injection (best-effort dedup)
    }

    // Format system message
    const message = this.formatSystemMessage(payload);

    // Inject message into session
    let injected = false;
    try {
      await this.cfg.messageStore.addMessage({
        sessionId: payload.sessionId,
        role: 'system',
        content: message,
        channel: 'api',
        traceId: payload.executionId,
        tenantId: payload.tenantId,
        projectId: payload.projectId,
      });
      injected = true;
      log.info('tool.workflow.callback.injected', {
        executionId: payload.executionId,
        sessionId: payload.sessionId,
      });
    } catch (err) {
      log.warn('tool.workflow.callback.session_inactive', {
        executionId: payload.executionId,
        sessionId: payload.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Broadcast WS event to both internal and SDK connections
    const wsPayload = {
      type: 'workflow.result',
      executionId: payload.executionId,
      workflowId: payload.workflowId,
      workflowName: payload.workflowName,
      status: payload.status,
      output: payload.output,
      error: payload.error,
    };
    const internalCount = this.cfg.internalWsManager.broadcastToSession(
      payload.sessionId,
      'workflow.result',
      wsPayload,
      payload.tenantId,
    );
    const sdkCount = this.cfg.sdkWsManager.broadcastToSession(
      payload.sessionId,
      'workflow.result',
      wsPayload,
      payload.tenantId,
    );

    log.debug('WS broadcast completed', {
      executionId: payload.executionId,
      sessionId: payload.sessionId,
      internalCount,
      sdkCount,
    });

    return { injected };
  }

  private formatSystemMessage(payload: WorkflowCallbackPayload): string {
    if (payload.status === 'completed') {
      let outputSummary = '';
      if (payload.output) {
        const raw = JSON.stringify(payload.output);
        outputSummary =
          raw.length > MAX_OUTPUT_SUMMARY_LENGTH
            ? `\nOutput: ${raw.slice(0, MAX_OUTPUT_SUMMARY_LENGTH)} [truncated]`
            : `\nOutput: ${raw}`;
      }
      return `[Workflow Complete] Execution ${payload.executionId} for workflow "${payload.workflowName}" completed successfully.${outputSummary}`;
    }
    const errorDetail = payload.error
      ? ` Error: ${payload.error.code} — ${payload.error.message}`
      : '';
    return `[Workflow Failed] Execution ${payload.executionId} for workflow "${payload.workflowName}" ${payload.status}.${errorDetail}`;
  }
}
