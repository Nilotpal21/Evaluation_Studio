import type { WebSocket } from 'ws';
import { createLogger } from '@abl/compiler/platform';
import { TENANT_ROLE_PERMISSIONS, hasPermission } from '@agent-platform/shared/rbac';
import type { RedisClient, RedisConnectionHandle } from '@agent-platform/redis';
import { createSubscriber } from '@agent-platform/redis';
import { WfSubscriptionRegistry } from './wf-subscription-registry.js';
import type { SubscribeExecutionMsg, UnsubscribeExecutionMsg } from './wf-events.js';
import type { WfServerMessage } from './wf-events.js';
import { WfClientMessage } from './wf-events.js';

const log = createLogger('runtime:wf-ws');

const WF_WS_MAX_SUBSCRIPTIONS = parseInt(process.env.WF_WS_MAX_SUBSCRIPTIONS ?? '10000', 10);
const WF_WS_TERMINAL_GRACE_MS = parseInt(process.env.WF_WS_TERMINAL_GRACE_MS ?? '30000', 10);
const WF_WS_BUFFERED_AMOUNT_MAX = parseInt(process.env.WF_WS_BUFFERED_AMOUNT_MAX ?? '524288', 10);
const SWEEP_INTERVAL_MS = 30_000;
const ACCESS_CHECK_TIMEOUT_MS = 5_000;

const SNAPSHOT_TRIGGER_META_REDACT = new Set(['encryptedAccessToken', 'accessToken']);
// callbackSecret is stripped from step contexts in snapshots — it is encrypted
// at rest but must not cross to Studio clients. Connector step outputs are
// intentionally NOT stripped; Studio is project-scoped + authenticated, so full
// connector API responses are visible to the workflow designer by design.
// (data-flow-audit F-1, docs/sdlc-logs/ws-relocation/data-flow-audit.md)
// awakeableId is also stripped: resolving a Restate awakeable requires nothing
// beyond the ID itself, so a Studio client with read access to the execution doc
// could resume any parked step via the public Restate ingress (SEC-8).
// Orchestration-internal routing fields are stripped for parity with
// STEP_SENSITIVE_FIELDS in workflow-executions.ts (REST API) and
// PUBLISH_SENSITIVE_STEP_FIELDS in workflow-handler.ts (Redis pub-sub).
const SNAPSHOT_STEP_SENSITIVE_FIELDS = new Set([
  'callbackSecret',
  'awakeableId',
  'parkPoint',
  'nextStepIds',
  'rejectStepIds',
  'joinStepId',
  'barrierTotal',
  'barrierCount',
  'barrierFailCount',
  'branchId',
  'failureStrategy',
]);

export interface ExecutionReadModel {
  findOne(
    filter: Record<string, unknown>,
    projection?: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null>;
}

export interface WfBridgeDeps {
  getRedisClient(): RedisClient | null;
  getRedisHandle?(): RedisConnectionHandle | null;
  executionModel: ExecutionReadModel;
  checkProjectAccess(tenantId: string, userId: string, projectId: string): Promise<boolean>;
}

export interface WfAuthContext {
  tenantId: string;
  userId: string;
  role?: string;
}

export class WfBridge {
  private readonly registry = new WfSubscriptionRegistry(WF_WS_MAX_SUBSCRIPTIONS);
  private subscriber: RedisClient | null = null;
  private readonly subscribedChannels = new Map<string, number>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly deps: WfBridgeDeps;

  constructor(deps: WfBridgeDeps) {
    this.deps = deps;
  }

  start(): void {
    this.sweepTimer = setInterval(() => {
      const { evicted } = this.registry.sweep(Date.now());
      for (const executionId of evicted) {
        const channel = this.channelForId(executionId);
        this.decrChannel(channel);
      }
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  close(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.subscriber) {
      void this.subscriber.quit();
      this.subscriber = null;
    }
  }

  handleMessage(ws: WebSocket, authCtx: WfAuthContext, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.send(ws, { type: 'error', code: 'invalid_json' });
      return;
    }

    const result = WfClientMessage.safeParse(parsed);
    if (!result.success) {
      this.send(ws, { type: 'error', code: 'unknown_message_type' });
      return;
    }

    const msg = result.data;
    if (msg.type === 'subscribe_execution') {
      this.handleSubscribeExecution(ws, authCtx, msg).catch((err: unknown) => {
        log.error('wf-ws.handler.subscribe_error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } else if (msg.type === 'unsubscribe_execution') {
      this.handleUnsubscribeExecution(ws, msg, authCtx.tenantId);
    }
  }

  async handleSubscribeExecution(
    ws: WebSocket,
    authCtx: WfAuthContext,
    msg: SubscribeExecutionMsg,
  ): Promise<void> {
    const { executionId, projectId, workflowId } = msg;
    const { tenantId } = authCtx;

    const rolePerms = authCtx.role
      ? ((TENANT_ROLE_PERMISSIONS as Record<string, string[]>)[authCtx.role] ?? [])
      : [];
    const hasTenantBypass = hasPermission(rolePerms, 'project:*');

    let hasAccess = hasTenantBypass;
    if (!hasTenantBypass) {
      try {
        hasAccess = await Promise.race([
          this.deps.checkProjectAccess(tenantId, authCtx.userId, projectId),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('access_check_timeout')), ACCESS_CHECK_TIMEOUT_MS),
          ),
        ]);
      } catch (err) {
        log.warn('wf-ws.subscribe.access_check_error', {
          executionId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.send(ws, {
          type: 'error',
          code: 'access_check_failed',
          message: 'Access check failed',
        });
        return;
      }
    }
    if (!hasAccess) {
      this.send(ws, {
        type: 'error',
        code: 'forbidden',
        message: 'You do not have access to this project',
      });
      return;
    }

    const LOOKUP_RETRIES = 5;
    const LOOKUP_RETRY_DELAY_MS = 400;
    let execDoc: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt <= LOOKUP_RETRIES; attempt++) {
      try {
        execDoc = await this.deps.executionModel.findOne(
          { _id: executionId, tenantId, projectId, workflowId },
          {
            _id: 1,
            status: 1,
            context: 1,
            startedAt: 1,
            completedAt: 1,
            output: 1,
            workflowId: 1,
            workflowVersionId: 1,
            workflowVersion: 1,
            projectId: 1,
            tenantId: 1,
            triggerType: 1,
            triggerMetadata: 1,
            input: 1,
            durationMs: 1,
            error: 1,
          },
        );
      } catch (err) {
        log.warn('wf-ws.subscribe.db_error', {
          executionId,
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (execDoc) break;
      if (attempt < LOOKUP_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, LOOKUP_RETRY_DELAY_MS));
      }
    }

    if (!execDoc) {
      this.send(ws, { type: 'execution_not_found', executionId });
      return;
    }

    const result = this.registry.register(executionId, { tenantId, projectId }, ws);
    if (!result.ok) {
      this.send(ws, {
        type: 'error',
        code: 'subscription_limit_reached',
        message: 'Maximum concurrent subscriptions reached',
      });
      return;
    }

    if (result.firstSubscriberForChannel) {
      const channel = this.channelForId(executionId, tenantId);
      const subscribed = await this.ensureSubscribed(channel);
      if (!subscribed) {
        this.send(ws, {
          type: 'error',
          code: 'subscription_failed',
          message: 'Real-time updates unavailable; use polling fallback',
        });
      }
    }

    this.send(ws, {
      type: 'workflow_execution_snapshot',
      execution: { ...sanitizeSnapshotDoc(execDoc), id: execDoc._id },
    });

    log.info('wf-ws.subscribe', { executionId, tenantId, projectId });
  }

  handleUnsubscribeExecution(ws: WebSocket, msg: UnsubscribeExecutionMsg, tenantId: string): void {
    const { executionId } = msg;
    const { lastSubscriberForChannel } = this.registry.unregister(executionId, ws);
    if (lastSubscriberForChannel) {
      const channel = this.channelForId(executionId, tenantId);
      this.decrChannel(channel);
    }
    log.info('wf-ws.unsubscribe', { executionId });
  }

  handleClose(ws: WebSocket, tenantId?: string): void {
    const { channelsDropped } = this.registry.removeWebSocket(ws);
    if (!tenantId) return;
    for (const executionId of channelsDropped) {
      this.decrChannel(this.channelForId(executionId, tenantId));
    }
  }

  onRedisMessage(channel: string, raw: string): void {
    const executionId = this.extractExecutionId(channel);
    if (!executionId) return;

    const entry = this.registry.get(executionId);
    if (!entry) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const msgType = parsed.type as string | undefined;
    const isTerminal = this.isTerminalWorkflowEvent(msgType);

    const wsMsg = this.toWsMessage(executionId, parsed);
    if (!wsMsg) return;

    for (const conn of entry.connections) {
      this.forward(conn, wsMsg);
    }

    if (isTerminal) {
      this.registry.markTerminal(executionId, WF_WS_TERMINAL_GRACE_MS);
    }
  }

  // PARITY INVARIANT: every step event type published by workflow-handler.ts must be listed
  // here. When adding a new step.* event type, add it to BOTH this allowlist AND update
  // statusFromEventType() below. Unlisted types are silently dropped and the Studio will
  // miss those state transitions, falling back to polling with a delay.
  private toWsMessage(
    executionId: string,
    parsed: Record<string, unknown>,
  ): WfServerMessage | null {
    const type = parsed.type as string;
    const timestamp = (parsed.timestamp as string | undefined) ?? new Date().toISOString();

    if (
      type === 'step.started' ||
      type === 'step.completed' ||
      type === 'step.failed' ||
      type === 'step.skipped' ||
      type === 'step.rejected' ||
      type === 'step.waiting_approval' ||
      type === 'step.waiting_human_task' ||
      type === 'step.waiting_callback'
    ) {
      return {
        type: 'workflow_step_status',
        executionId,
        stepId: (parsed.stepId as string) ?? '',
        stepName: parsed.stepName as string | undefined,
        stepType: (parsed.stepType as string | undefined) ?? (parsed.stepId as string),
        status: (parsed.status as string | undefined) ?? this.statusFromEventType(type),
        stepData: parsed.stepData as Record<string, unknown> | undefined,
        contextPatch: parsed.contextPatch as Record<string, unknown> | undefined,
        timestamp,
        durationMs: parsed.durationMs as number | undefined,
        pathState: parsed.pathState as Record<string, 'running' | 'completed'> | undefined,
        iterationPathState: parsed.iterationPathState as
          | Record<string, Record<string, Record<string, 'running' | 'completed'>>>
          | undefined,
      };
    }

    if (
      type === 'workflow.started' ||
      type === 'workflow.completed' ||
      type === 'workflow.failed' ||
      type === 'workflow.rejected' ||
      type === 'workflow.cancelled'
    ) {
      return {
        type: 'workflow_execution_status',
        executionId,
        status: this.lifecycleStatus(type),
        timestamp,
        startedAt: parsed.startedAt as string | undefined,
        completedAt: parsed.completedAt as string | undefined,
        durationMs: parsed.durationMs as number | undefined,
        output: parsed.output as Record<string, unknown> | undefined,
        error: parsed.error as string | undefined,
        pathState: parsed.pathState as Record<string, 'running' | 'completed'> | undefined,
        iterationPathState: parsed.iterationPathState as
          | Record<string, Record<string, Record<string, 'running' | 'completed'>>>
          | undefined,
      };
    }

    return null;
  }

  private forward(ws: WebSocket, msg: WfServerMessage): void {
    if (ws.readyState !== ws.OPEN) return;
    const buffered = (ws as unknown as { bufferedAmount?: number }).bufferedAmount ?? 0;
    if (buffered > WF_WS_BUFFERED_AMOUNT_MAX) {
      log.warn('wf-ws.backpressure_drop', { bufferedAmount: buffered });
      return;
    }
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      log.warn('wf-ws.send_error', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private send(ws: WebSocket, msg: WfServerMessage): void {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      log.warn('wf-ws.send_error', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async ensureSubscribed(channel: string): Promise<boolean> {
    const existing = this.subscribedChannels.get(channel) ?? 0;
    this.subscribedChannels.set(channel, existing + 1);
    if (existing === 0) {
      const sub = this.getOrCreateSubscriber();
      if (sub) {
        try {
          await Promise.race([
            sub.subscribe(channel),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error('redis_subscribe_timeout')),
                ACCESS_CHECK_TIMEOUT_MS,
              ),
            ),
          ]);
        } catch (err) {
          log.warn('wf-ws.redis_subscribe_error', {
            channel,
            error: err instanceof Error ? err.message : String(err),
          });
          this.subscribedChannels.delete(channel);
          return false;
        }
      }
    }
    return true;
  }

  private decrChannel(channel: string | null): void {
    if (!channel) return;
    const count = (this.subscribedChannels.get(channel) ?? 1) - 1;
    if (count <= 0) {
      this.subscribedChannels.delete(channel);
      if (this.subscriber) {
        this.subscriber.unsubscribe(channel).catch((err: unknown) => {
          log.warn('wf-ws.redis_unsubscribe_error', {
            channel,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } else {
      this.subscribedChannels.set(channel, count);
    }
  }

  private getOrCreateSubscriber(): RedisClient | null {
    if (this.subscriber) return this.subscriber;
    const handle = this.deps.getRedisHandle?.();
    if (!handle) return null;
    this.subscriber = createSubscriber(handle);
    this.subscriber.on('message', (channel: string, message: string) => {
      this.onRedisMessage(channel, message);
    });
    this.subscriber.on('error', (err: Error) => {
      log.warn('wf-ws.redis_subscriber_error', { error: err.message });
    });
    return this.subscriber;
  }

  private channelForId(executionId: string, tenantId?: string): string {
    if (tenantId) {
      return `workflow:${tenantId}:execution:${executionId}:status`;
    }
    const entry = this.registry.get(executionId);
    if (entry) {
      return `workflow:${entry.tenantId}:execution:${executionId}:status`;
    }
    return `workflow:unknown:execution:${executionId}:status`;
  }

  private extractExecutionId(channel: string): string | null {
    const match = /^workflow:[^:]+:execution:([^:]+):status$/.exec(channel);
    return match ? match[1] : null;
  }

  private isTerminalWorkflowEvent(type: string | undefined): boolean {
    return (
      type === 'workflow.completed' ||
      type === 'workflow.failed' ||
      type === 'workflow.cancelled' ||
      type === 'workflow.rejected'
    );
  }

  private statusFromEventType(type: string): string {
    if (type === 'step.started') return 'running';
    if (type === 'step.completed') return 'completed';
    if (type === 'step.failed') return 'failed';
    if (type === 'step.skipped') return 'skipped';
    if (type === 'step.rejected') return 'rejected';
    if (type === 'step.waiting_approval') return 'waiting_approval';
    if (type === 'step.waiting_human_task') return 'waiting_human_task';
    if (type === 'step.waiting_callback') return 'waiting_callback';
    return 'unknown';
  }

  private lifecycleStatus(type: string): string {
    return type.replace('workflow.', '');
  }
}

function sanitizeSnapshotDoc(doc: Record<string, unknown>): Record<string, unknown> {
  const result = { ...doc };

  if (result.triggerMetadata && typeof result.triggerMetadata === 'object') {
    result.triggerMetadata = Object.fromEntries(
      Object.entries(result.triggerMetadata as Record<string, unknown>).filter(
        ([k]) => !SNAPSHOT_TRIGGER_META_REDACT.has(k),
      ),
    );
  }

  if (result.context && typeof result.context === 'object') {
    const ctx = result.context as Record<string, unknown>;
    if (ctx.steps && typeof ctx.steps === 'object') {
      result.context = {
        ...ctx,
        steps: Object.fromEntries(
          Object.entries(ctx.steps as Record<string, Record<string, unknown>>).map(
            ([name, step]) => [
              name,
              step && typeof step === 'object'
                ? Object.fromEntries(
                    Object.entries(step).filter(([k]) => !SNAPSHOT_STEP_SENSITIVE_FIELDS.has(k)),
                  )
                : step,
            ],
          ),
        ),
      };
    }
  }

  return result;
}
