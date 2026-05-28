/**
 * TriggerEngine Service
 *
 * Manages lifecycle of workflow trigger registrations: register, deregister,
 * pause, resume, and fire. Delegates workflow execution to Restate via the
 * RestateWorkflowClient.
 */

import { createLogger } from '@abl/compiler/platform';
import crypto from 'node:crypto';
import type { TriggerScheduler } from './trigger-scheduler.js';
import { resolvePreset, type PresetConfig } from './preset-resolver.js';
import { resolveWorkflowDefinition } from '../lib/version-resolution.js';
import { buildWorkflowExecutionPayload } from '../lib/execution-payload.js';

const log = createLogger('workflow-engine:trigger-engine');

// ─── Types ──────────────────────────────────────────────────────────────

export interface TriggerRegistration {
  workflowId: string;
  tenantId: string;
  projectId: string;
  triggerType: 'webhook' | 'cron' | 'event';
  config: Record<string, unknown>;
  environment?: string;
  workflowVersionId?: string;
  workflowVersion?: string;
  triggerName?: string;
}

/**
 * Structured audit event for trigger-lifecycle mutations. Emitted via the
 * optional `auditEmitter` dep so a deployment can route these to TraceStore /
 * the audit pipeline without coupling the engine to a specific sink. Field
 * names follow the runtime audit-helpers shape so a single backend can
 * consume both surfaces.
 */
export interface TriggerAuditEvent {
  action:
    | 'trigger.registered'
    | 'trigger.updated'
    | 'trigger.update_failed'
    | 'trigger.paused'
    | 'trigger.resumed'
    | 'trigger.deregistered'
    | 'trigger.test_sample'
    | 'trigger.test_action';
  registrationId: string;
  tenantId: string;
  projectId?: string;
  workflowId?: string;
  triggerType?: string;
  /** 'success' on the happy path; 'error' when the mutation failed or rolled back. */
  outcome: 'success' | 'error';
  /** Free-form metadata — connector strategy change, rollback reason, etc. */
  metadata?: Record<string, unknown>;
}

export interface TriggerEngineDeps {
  triggerModel: {
    create(data: unknown): Promise<{ _id: string }>;
    find(filter: Record<string, unknown>): { lean(): Promise<Record<string, unknown>[]> };
    findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null>;
    findOneAndUpdate(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ): Promise<Record<string, unknown> | null>;
  };
  /**
   * Optional execution model — used by `getLastFirePayload` to look up the
   * most recent triggerPayload for a given registration so the "Fire Now" UI
   * can pre-populate the payload editor. Omitted in unit tests that do not
   * exercise replay.
   */
  executionModel?: {
    findOne(filter: Record<string, unknown>): {
      sort(sort: Record<string, number>): {
        select(fields: string): { lean(): Promise<{ input?: unknown } | null> };
      };
    };
  };
  workflowModel: {
    findOne(filter: Record<string, unknown>): Promise<{
      _id: string;
      name: string;
      steps?: unknown[];
      nodes?: unknown[];
      edges?: unknown[];
    } | null>;
    findOneAndUpdate(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ): Promise<{ _id: string } | null>;
  };
  restateClient: {
    startWorkflow(executionId: string, input: Record<string, unknown>): Promise<void>;
  };
  /** Optional scheduler for cron/polling triggers (requires Redis) */
  scheduler?: TriggerScheduler;
  /** Optional: Deployment model for fire-time version resolution */
  deploymentModel?: {
    findOne(filter: Record<string, unknown>): {
      sort(sort: Record<string, number>): { lean(): Promise<Record<string, unknown> | null> };
    };
  };
  /** Optional: WorkflowVersion model for loading pinned definitions */
  workflowVersionModel?: {
    findOne(filter: Record<string, unknown>): { lean(): Promise<Record<string, unknown> | null> };
    /**
     * Optional on the deps contract because older tests stub only `findOne`;
     * required in production (Mongoose `WorkflowVersion.find`) and used by
     * `fireWebhookTrigger` for semver-desc default resolution.
     */
    find?(filter: Record<string, unknown>): { lean(): Promise<Record<string, unknown>[]> };
  };
  /**
   * Optional audit emitter — invoked fire-and-forget after successful lifecycle
   * mutations (register / update / pause / resume / deregister). When the
   * workflow-engine is wired to a TraceStore / audit pipeline, the emitter
   * writes a structured event; otherwise (unit tests, deployments without an
   * audit sink) it stays unset and the engine is silent. Never throws back to
   * the caller — the emitter is expected to swallow its own errors.
   */
  auditEmitter?: (event: TriggerAuditEvent) => void | Promise<void>;
  /**
   * Optional field-level decryption for design-time sample payloads. When
   * provided, `getLastFirePayload` decrypts the stored encrypted JSON string
   * before returning it to the caller. Omit only in test environments.
   */
  decryptSample?: (ciphertext: string, tenantId: string) => Promise<string>;
  /** Optional connector trigger engine — handles connector-native triggers */
  connectorTriggerEngine?: {
    registerTrigger(input: {
      registrationId: string;
      tenantId: string;
      projectId: string;
      workflowId: string;
      connectorName: string;
      triggerName: string;
      connectionId: string;
      config?: Record<string, unknown>;
      pollingIntervalMs?: number;
      cronExpression?: string;
      triggerParams?: Record<string, unknown>;
    }): Promise<{ triggerType: string }>;
    deregisterTrigger(
      registrationId: string,
      strategy: 'webhook' | 'polling' | 'cron' | 'event',
      config?: {
        pollingIntervalMs?: number;
        cronExpression?: string;
        connectorName?: string;
        triggerName?: string;
        tenantId?: string;
        projectId?: string;
        connectionId?: string;
        triggerParams?: Record<string, unknown>;
      },
    ): Promise<void>;
    testSample?(
      registrationId: string,
      tenantId: string,
      projectId: string,
    ): Promise<{ sample: Record<string, unknown>; itemCount: number }>;
  };
}

/**
 * Build the structured `reason` field for trigger audit events from an
 * arbitrary thrown value. Prefers a stable class signal (`err.name`, then
 * `err.code` for Node `SystemError`-shaped throws) over the free-form
 * `err.message`, which can carry caller context if an upstream library
 * formats user-supplied values into its error strings.
 *
 * Also redacts obvious bearer-shaped substrings (the literal `Bearer ...`
 * header pattern Web SDK clients sometimes echo back in error responses)
 * as a belt-and-braces guard before the value reaches an audit sink that
 * may have longer retention than logs.
 *
 * Returns `{ code, message }` so the audit event records both the
 * stable identifier and a sanitized human-readable message.
 */
export function summarizeTriggerError(err: unknown): { code: string; message: string } {
  if (err instanceof Error) {
    const code =
      (err as { code?: string }).code ?? (err.name && err.name !== 'Error' ? err.name : 'ERROR');
    const message = redactBearerToken(err.message);
    return { code, message };
  }
  return { code: 'ERROR', message: redactBearerToken(String(err)) };
}

/**
 * Replace any `Bearer <token>` substring with `Bearer [REDACTED]`. Conservative:
 * we don't try to detect tokens by entropy or shape — only the explicit header
 * literal that has the highest likelihood of appearing in upstream error
 * messages (HTTP client errors that echo the request headers).
 */
function redactBearerToken(input: string): string {
  return input.replace(/Bearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, 'Bearer [REDACTED]');
}

// ─── Service ────────────────────────────────────────────────────────────

export class TriggerEngine {
  constructor(private readonly deps: TriggerEngineDeps) {}

  /**
   * Fire-and-forget audit emission. Wraps the optional emitter so callers
   * inside `updateTrigger` etc. never await it directly — the engine's
   * lifecycle methods stay focused on the mutation, and a misconfigured
   * audit sink can never block or fail a trigger update.
   */
  private emitAudit(event: TriggerAuditEvent): void {
    const emitter = this.deps.auditEmitter;
    if (!emitter) return;
    try {
      const result = emitter(event);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((err) => {
          log.warn('Trigger audit emitter rejected', {
            action: event.action,
            registrationId: event.registrationId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err) {
      log.warn('Trigger audit emitter threw synchronously', {
        action: event.action,
        registrationId: event.registrationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private connectorStrategyFrom(
    triggerType: string | undefined,
    cfg: Record<string, unknown>,
  ): 'webhook' | 'polling' | 'cron' | 'event' {
    if (triggerType === 'webhook') return 'webhook';
    if (typeof cfg.pollingIntervalMs === 'number') return 'polling';
    if (cfg.preset || typeof cfg.cronExpression === 'string') return 'cron';
    return 'event';
  }

  private normalizeCronConfig(
    config: Record<string, unknown>,
    options: { strict?: boolean } = {},
  ): {
    nextConfig: Record<string, unknown>;
    resolvedCron?: string;
    resolvedTz?: string;
    resolvedDelay?: number;
  } {
    let resolvedCron: string | undefined;
    let resolvedTz: string | undefined;
    let resolvedDelay: number | undefined;

    if (config.preset) {
      try {
        const resolved = resolvePreset(config as unknown as PresetConfig);
        resolvedCron = resolved.cronExpression;
        resolvedTz = resolved.tz;
        resolvedDelay = resolved.delay;
      } catch (err) {
        log.warn('Failed to resolve cron preset', {
          error: err instanceof Error ? err.message : String(err),
        });
        if (options.strict) {
          throw err;
        }
      }
    } else {
      resolvedCron = config.cronExpression as string | undefined;
      resolvedTz = config.timezone as string | undefined;
    }

    const nextConfig: Record<string, unknown> = { ...config };
    if (resolvedCron) nextConfig.cronExpression = resolvedCron;
    if (resolvedTz) nextConfig.timezone = resolvedTz;

    // Canonicalize schedule-related fields so stale values don't linger when
    // switching presets (e.g., weekly->daily keeps dayOfWeek, daily->once keeps
    // cronExpression). This avoids Studio rendering old times based on leftover
    // fields and keeps persisted config easier to reason about.
    const preset = nextConfig.preset as string | undefined;
    if (preset) {
      switch (preset) {
        case 'daily': {
          delete nextConfig.dayOfWeek;
          delete nextConfig.dayOfMonth;
          delete nextConfig.datetime;
          break;
        }
        case 'weekly': {
          delete nextConfig.dayOfMonth;
          delete nextConfig.datetime;
          break;
        }
        case 'monthly': {
          delete nextConfig.dayOfWeek;
          delete nextConfig.datetime;
          break;
        }
        case 'once': {
          delete nextConfig.time;
          delete nextConfig.dayOfWeek;
          delete nextConfig.dayOfMonth;
          // One-shot schedules use datetime+delay; never persist a cron string.
          delete nextConfig.cronExpression;
          break;
        }
        case 'cron': {
          delete nextConfig.time;
          delete nextConfig.dayOfWeek;
          delete nextConfig.dayOfMonth;
          delete nextConfig.datetime;
          break;
        }
        default:
          break;
      }
    }

    return { nextConfig, resolvedCron, resolvedTz, resolvedDelay };
  }

  /**
   * List trigger registrations for a project, optionally filtered by workflowId.
   * Excludes soft-deleted registrations.
   */
  async list(
    tenantId: string,
    projectId: string,
    workflowId?: string,
  ): Promise<Record<string, unknown>[]> {
    const filter: Record<string, unknown> = {
      tenantId,
      projectId,
      status: { $ne: 'deleted' },
    };
    if (workflowId) filter.workflowId = workflowId;
    return this.deps.triggerModel.find(filter).lean();
  }

  /**
   * Register a new trigger for a workflow.
   * Creates a document in the trigger registrations collection and returns
   * the generated registration ID.
   */
  async register(registration: TriggerRegistration): Promise<{ registrationId: string }> {
    const registrationId = crypto.randomUUID();
    // The TriggerRegistration schema requires `triggerName`. Connector triggers
    // supply the connector's named trigger (e.g., "push"); user-created
    // webhook/cron/event triggers have no named trigger, so default to the
    // triggerType. Keeps the DB invariant without forcing every client to
    // send a placeholder name.
    const triggerName = registration.triggerName ?? registration.triggerType;
    const connectorNameForDoc =
      typeof (registration.config as Record<string, unknown>)?.connectorName === 'string'
        ? ((registration.config as Record<string, unknown>).connectorName as string)
        : undefined;
    await this.deps.triggerModel.create({
      _id: registrationId,
      workflowId: registration.workflowId,
      tenantId: registration.tenantId,
      projectId: registration.projectId,
      triggerType: registration.triggerType,
      triggerName,
      ...(connectorNameForDoc ? { connectorName: connectorNameForDoc } : {}),
      ...((registration.config as Record<string, unknown>).connectionId
        ? { connectionId: (registration.config as Record<string, unknown>).connectionId }
        : {}),
      config: registration.config,
      status: 'active',
      ...(registration.environment ? { environment: registration.environment } : {}),
      ...(registration.workflowVersionId
        ? { workflowVersionId: registration.workflowVersionId }
        : {}),
      ...(registration.workflowVersion ? { workflowVersion: registration.workflowVersion } : {}),
    });

    // Sync trigger summary into workflow document (denormalized copy).
    // The TriggerRegistration collection is the canonical source of truth;
    // this embedded array is a convenience for OverviewTab/StepsTab display.
    await this.deps.workflowModel.findOneAndUpdate(
      { _id: registration.workflowId, tenantId: registration.tenantId },
      {
        $push: {
          triggers: {
            id: registrationId,
            type: registration.triggerType,
            config: registration.config,
            status: 'active',
          },
        },
      },
    );

    // Delegate connector-backed triggers (Gmail, Slack, Jira, …) to the
    // connector trigger engine. The unified `triggerType` enum only captures
    // the Studio-facing category (webhook/cron/event) — the connector engine
    // is authoritative on the actual scheduling strategy (polling / cron /
    // inbound webhook) based on the connector's trigger definition. Any
    // registration whose `config.connectorName` is set is a connector trigger
    // regardless of its `triggerType` label, and the BullMQ scheduler below
    // must NOT also pick it up (would double-fire).
    //
    // If `connectorTriggerEngine` is not wired (deployments without Redis or
    // without the connectors package), the registration is still persisted so
    // an operator can attach the engine later and resume without data loss —
    // same pattern as the cron scheduler-absent branch.
    const connectorName = registration.config.connectorName as string | undefined;
    if (connectorName) {
      if (this.deps.connectorTriggerEngine) {
        await this.deps.connectorTriggerEngine.registerTrigger({
          registrationId,
          tenantId: registration.tenantId,
          projectId: registration.projectId,
          workflowId: registration.workflowId,
          connectorName,
          triggerName: (registration.config.triggerName as string) ?? '',
          connectionId: (registration.config.connectionId as string) ?? '',
          pollingIntervalMs: registration.config.pollingIntervalMs as number | undefined,
          cronExpression: registration.config.cronExpression as string | undefined,
          triggerParams: registration.config.triggerParams as Record<string, unknown> | undefined,
        });
        log.info('Connector trigger delegated to connector engine', {
          registrationId,
          connectorName,
          triggerName: registration.config.triggerName,
        });
      } else {
        log.warn(
          'Connector trigger persisted but connectorTriggerEngine is unavailable — trigger will not fire until connectors runtime is attached',
          {
            registrationId,
            connectorName,
            triggerName: registration.config.triggerName,
          },
        );
      }
      return { registrationId };
    }

    // Delegate cron triggers to the BullMQ scheduler.
    //
    // Two responsibilities here:
    //   1. RESOLVE preset/cronExpression and persist the canonical expression
    //      into `config.cronExpression` so the UI list, and the resume() path,
    //      can display / reschedule without re-running the preset resolver.
    //      This must happen regardless of whether a scheduler is available —
    //      otherwise a cron trigger registered without Redis would show up
    //      as "Schedule not configured" in the UI.
    //   2. SCHEDULE the BullMQ job when a scheduler is wired. If Redis is
    //      absent, log a warning so the silent-no-fire mode is visible in logs.
    if (registration.triggerType === 'cron') {
      let resolvedCron: string | undefined;
      let resolvedTz: string | undefined;
      let resolvedDelay: number | undefined;

      if (registration.config.preset) {
        try {
          const resolved = resolvePreset(registration.config as unknown as PresetConfig);
          resolvedCron = resolved.cronExpression;
          resolvedTz = resolved.tz;
          resolvedDelay = resolved.delay;
        } catch (err) {
          // Preset resolution failed (e.g. missing datetime for 'once'). Log
          // and continue — the trigger is still persisted so the user can
          // fix and resume.
          log.warn('Failed to resolve cron preset', {
            registrationId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        resolvedCron = registration.config.cronExpression as string | undefined;
        resolvedTz = registration.config.timezone as string | undefined;
      }

      // Persist the canonical cronExpression inside config so the UI and
      // resume() path see it. We keep the legacy top-level write too for
      // backwards compatibility with older readers.
      if (resolvedCron) {
        await this.deps.triggerModel.findOneAndUpdate(
          { _id: registrationId, tenantId: registration.tenantId },
          {
            $set: {
              cronExpression: resolvedCron,
              'config.cronExpression': resolvedCron,
              ...(resolvedTz ? { 'config.timezone': resolvedTz } : {}),
            },
          },
        );
      }

      if (this.deps.scheduler) {
        const jobData = {
          registrationId,
          tenantId: registration.tenantId,
          projectId: registration.projectId,
          workflowId: registration.workflowId,
          type: registration.triggerType,
          ...(registration.workflowVersionId
            ? { workflowVersionId: registration.workflowVersionId }
            : {}),
          ...(registration.environment ? { environment: registration.environment } : {}),
        };

        if (resolvedCron) {
          await this.deps.scheduler.scheduleCron(registrationId, jobData, resolvedCron, resolvedTz);
        } else if (resolvedDelay !== undefined) {
          await this.deps.scheduler.scheduleOnce(registrationId, jobData, resolvedDelay);
        } else {
          log.warn('Cron trigger registered with no resolvable schedule', {
            registrationId,
            preset: registration.config.preset,
          });
        }
      } else {
        // Scheduler not wired (Redis absent in this deployment). The trigger
        // is persisted but will NOT fire until a scheduler is attached.
        log.warn(
          'Cron trigger persisted but scheduler is unavailable — trigger will not fire until Redis/BullMQ is configured',
          {
            registrationId,
            workflowId: registration.workflowId,
            cronExpression: resolvedCron,
          },
        );
      }
    } else if (registration.triggerType === 'event') {
      // Event triggers are passive — they fire when an external event arrives.
      // No scheduling needed; the trigger registration is stored for lookup on event receipt.
    }

    log.info('Trigger registered', {
      registrationId,
      triggerType: registration.triggerType,
      workflowId: registration.workflowId,
    });
    return { registrationId };
  }

  /**
   * Update a trigger's config. Keeps the same registrationId.
   *
   * - Cron: resolves preset/cronExpression, persists canonical config, and
   *   reschedules immediately if active (when BullMQ scheduler is wired).
   * - Connector-backed triggers: persists config and re-registers with the
   *   connector trigger engine when available.
   * - Webhook/event: persists config only.
   */
  async updateTrigger(
    registrationId: string,
    config: Record<string, unknown>,
    tenantId: string,
    projectId?: string,
  ): Promise<void> {
    const filter: Record<string, unknown> = {
      _id: registrationId,
      tenantId,
      status: { $ne: 'deleted' },
    };
    if (projectId) filter.projectId = projectId;

    const trigger = await this.deps.triggerModel.findOne(filter);
    if (!trigger) {
      throw new Error('Trigger not found');
    }

    const existingConfig = (trigger.config ?? {}) as Record<string, unknown>;
    const mergedConfig: Record<string, unknown> = { ...existingConfig, ...config };

    // Empty callbackUrl means "unset"; leaving token blank preserves existing token.
    //
    // NOTE: `config.callbackAccessToken` and `config.callbackUrl` are
    // DISPLAY VALUES, not the bearer the engine sends on trigger-fired
    // callbacks. The actual outbound bearer is `triggerMetadata
    // .encryptedAccessToken` resolved at execute time by the proxy
    // (apps/runtime/src/middleware/workflow-engine-proxy.ts) and consumed
    // by `callback-delivery-worker.ts` after tenant-scoped decryption.
    // This field is rendered by Studio's WebhookQuickStart code-snippet
    // panel so the user can copy-paste their own example cURL; the
    // server never reads it during fire. If you change that, encrypt at
    // rest first (see callback-delivery-worker for the encryption hook).
    if (mergedConfig.callbackUrl === '') {
      delete mergedConfig.callbackUrl;
      delete mergedConfig.callbackAccessToken;
    }

    const triggerType = trigger.triggerType as string | undefined;
    const mergedConnectorName = mergedConfig.connectorName;
    const isConnectorBacked =
      (typeof existingConfig.connectorName === 'string' &&
        existingConfig.connectorName.length > 0) ||
      (typeof mergedConnectorName === 'string' && mergedConnectorName.length > 0);

    const shouldNormalizeCron = triggerType === 'cron' && !isConnectorBacked;
    // Strict on update: a bad preset/time/cronExpression must fail the request
    // instead of silently unscheduling a previously-working trigger.
    const normalizedCron = shouldNormalizeCron
      ? this.normalizeCronConfig(mergedConfig, { strict: true })
      : null;
    const nextConfig = normalizedCron ? normalizedCron.nextConfig : mergedConfig;
    const resolvedCron = normalizedCron?.resolvedCron;
    const resolvedTz = normalizedCron?.resolvedTz;
    const resolvedDelay = normalizedCron?.resolvedDelay;

    // Connector-backed triggers are delegated. Persisting config is necessary but
    // not sufficient; re-register so provider webhooks/polling use the new config.
    if (isConnectorBacked) {
      if (this.deps.connectorTriggerEngine) {
        const oldStrategy = this.connectorStrategyFrom(triggerType, existingConfig);
        const newStrategy = this.connectorStrategyFrom(triggerType, nextConfig);

        // Fail-closed: do not persist the new config unless we successfully rewire
        // the provider-side trigger. Avoids "UI updated but trigger doesn't fire".
        const normalizedConnectorCron =
          newStrategy === 'cron' ? this.normalizeCronConfig(nextConfig) : null;
        const connectorConfig = normalizedConnectorCron
          ? normalizedConnectorCron.nextConfig
          : nextConfig;

        await this.deps.connectorTriggerEngine.deregisterTrigger(registrationId, oldStrategy, {
          tenantId,
          projectId: projectId ?? (trigger.projectId as string | undefined) ?? undefined,
          connectorName: existingConfig.connectorName as string | undefined,
          triggerName: existingConfig.triggerName as string | undefined,
          connectionId: existingConfig.connectionId as string | undefined,
          pollingIntervalMs: existingConfig.pollingIntervalMs as number | undefined,
          cronExpression: existingConfig.cronExpression as string | undefined,
          triggerParams: existingConfig.triggerParams as Record<string, unknown> | undefined,
        });

        try {
          // Pass only the typed named params the connector engine actually
          // consumes. Forwarding the whole `connectorConfig` blob here would
          // leak unrelated fields (e.g. webhook display tokens) to whatever
          // connector implementation chooses to read `input.config`. The
          // connector engine's register path doesn't read `input.config`
          // today — but the field is in the type signature, so any future
          // implementation could start to. Keep the contract narrow.
          await this.deps.connectorTriggerEngine.registerTrigger({
            registrationId,
            tenantId,
            projectId: (trigger.projectId as string) ?? projectId ?? '',
            workflowId: (trigger.workflowId as string) ?? '',
            connectorName: (connectorConfig.connectorName as string) ?? '',
            triggerName: (connectorConfig.triggerName as string) ?? '',
            connectionId: (connectorConfig.connectionId as string) ?? '',
            pollingIntervalMs: connectorConfig.pollingIntervalMs as number | undefined,
            cronExpression:
              (normalizedConnectorCron?.resolvedCron as string | undefined) ??
              (connectorConfig.cronExpression as string | undefined),
            triggerParams: connectorConfig.triggerParams as Record<string, unknown> | undefined,
          });
        } catch (err) {
          // Roll back provider-side wiring best-effort by re-registering the
          // previous config so an edit doesn't delete the subscription.
          let rollbackRestored = false;
          try {
            // Same narrow shape as the primary register call above — strip
            // the wider `config` blob so the rollback path does not start
            // forwarding fields the primary path now hides.
            await this.deps.connectorTriggerEngine.registerTrigger({
              registrationId,
              tenantId,
              projectId: (trigger.projectId as string) ?? projectId ?? '',
              workflowId: (trigger.workflowId as string) ?? '',
              connectorName: (existingConfig.connectorName as string) ?? '',
              triggerName: (existingConfig.triggerName as string) ?? '',
              connectionId: (existingConfig.connectionId as string) ?? '',
              pollingIntervalMs: existingConfig.pollingIntervalMs as number | undefined,
              cronExpression: existingConfig.cronExpression as string | undefined,
              triggerParams: existingConfig.triggerParams as Record<string, unknown> | undefined,
            });
            rollbackRestored = true;
          } catch (rollbackErr) {
            log.error('Connector trigger rollback re-register failed', {
              registrationId,
              error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
            });
          }
          if (!rollbackRestored) {
            // Provider has no subscription AND we couldn't restore. Mark the
            // trigger 'error' so operators can detect the broken state via the
            // standard list view, and emit a failure audit event so monitoring
            // pipelines see it. Without this the DB still claims 'active' but
            // the trigger silently never fires again.
            try {
              await this.deps.triggerModel.findOneAndUpdate(filter, {
                $set: { status: 'error' },
              });
            } catch (statusErr) {
              log.error('Failed to mark trigger status=error after rollback failure', {
                registrationId,
                error: statusErr instanceof Error ? statusErr.message : String(statusErr),
              });
            }
          }
          const summary = summarizeTriggerError(err);
          this.emitAudit({
            action: 'trigger.update_failed',
            registrationId,
            tenantId,
            projectId: projectId ?? (trigger.projectId as string | undefined),
            workflowId: trigger.workflowId as string | undefined,
            triggerType,
            outcome: 'error',
            metadata: {
              reasonCode: summary.code,
              reason: summary.message,
              rollback: rollbackRestored ? 'restored' : 'failed',
              connectorBacked: true,
            },
          });
          throw err;
        }

        const unsetTopLevelCronConnector =
          triggerType === 'cron' &&
          typeof (connectorConfig as Record<string, unknown>).cronExpression !== 'string';
        await this.deps.triggerModel.findOneAndUpdate(filter, {
          $set: {
            config: connectorConfig,
            ...(normalizedConnectorCron?.resolvedCron
              ? { cronExpression: normalizedConnectorCron.resolvedCron }
              : {}),
          },
          ...(unsetTopLevelCronConnector ? { $unset: { cronExpression: 1 } } : {}),
        });

        const workflowId = trigger.workflowId as string | undefined;
        if (workflowId) {
          await this.deps.workflowModel.findOneAndUpdate(
            { _id: workflowId, tenantId, 'triggers.id': registrationId },
            { $set: { 'triggers.$.config': connectorConfig } },
          );
        }

        log.info('Connector trigger updated', { registrationId, oldStrategy, newStrategy });
        this.emitAudit({
          action: 'trigger.updated',
          registrationId,
          tenantId,
          projectId: projectId ?? (trigger.projectId as string | undefined),
          workflowId: trigger.workflowId as string | undefined,
          triggerType,
          outcome: 'success',
          metadata: { connectorBacked: true, oldStrategy, newStrategy },
        });
      } else {
        log.warn('Connector trigger update rejected — connectorTriggerEngine unavailable', {
          registrationId,
        });
        this.emitAudit({
          action: 'trigger.update_failed',
          registrationId,
          tenantId,
          projectId: projectId ?? (trigger.projectId as string | undefined),
          workflowId: trigger.workflowId as string | undefined,
          triggerType,
          outcome: 'error',
          metadata: {
            reasonCode: 'CONNECTOR_RUNTIME_UNAVAILABLE',
            reason: 'CONNECTOR_RUNTIME_UNAVAILABLE',
            connectorBacked: true,
          },
        });
        throw new Error('CONNECTOR_RUNTIME_UNAVAILABLE');
      }
      return;
    }

    const unsetTopLevelCron =
      shouldNormalizeCron && resolvedCron === undefined && resolvedDelay !== undefined;
    await this.deps.triggerModel.findOneAndUpdate(filter, {
      $set: {
        config: nextConfig,
        ...(resolvedCron ? { cronExpression: resolvedCron } : {}),
      },
      ...(unsetTopLevelCron ? { $unset: { cronExpression: 1 } } : {}),
    });

    // Keep the denormalized workflow.triggers[] copy in sync (Overview/Steps tabs).
    const workflowId = trigger.workflowId as string | undefined;
    if (workflowId) {
      await this.deps.workflowModel.findOneAndUpdate(
        { _id: workflowId, tenantId, 'triggers.id': registrationId },
        { $set: { 'triggers.$.config': nextConfig } },
      );
    }

    // Reschedule cron if active; paused triggers will be picked up on resume().
    if (shouldNormalizeCron && this.deps.scheduler) {
      // Best-effort rollback: if rescheduling fails after unschedule, try to restore
      // the previous schedule AND the previous DB config so an edit doesn't leave
      // DB and BullMQ in conflicting states.
      const previous = this.normalizeCronConfig(existingConfig);
      const prevCron = previous.resolvedCron;
      const prevTz = previous.resolvedTz;
      const prevDelay = previous.resolvedDelay;

      await this.deps.scheduler.unschedule(registrationId);

      if ((trigger.status as string | undefined) === 'active') {
        const triggerVersionId = trigger.workflowVersionId as string | undefined;
        const triggerEnvironment = trigger.environment as string | undefined;
        const jobData = {
          registrationId,
          tenantId,
          projectId: (trigger.projectId as string) ?? projectId ?? '',
          workflowId: (trigger.workflowId as string) ?? '',
          type: 'cron' as const,
          ...(triggerVersionId ? { workflowVersionId: triggerVersionId } : {}),
          ...(triggerEnvironment ? { environment: triggerEnvironment } : {}),
        };

        try {
          if (resolvedCron) {
            await this.deps.scheduler.scheduleCron(
              registrationId,
              jobData,
              resolvedCron,
              resolvedTz,
            );
          } else if (resolvedDelay !== undefined) {
            await this.deps.scheduler.scheduleOnce(
              registrationId,
              { ...jobData, type: 'once' as const },
              resolvedDelay,
            );
          } else {
            log.warn('Cron trigger updated with no resolvable schedule', {
              registrationId,
              preset: config.preset,
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error('Failed to reschedule cron trigger after update', {
            registrationId,
            error: msg,
          });
          let rescheduleRestored = false;
          try {
            if (prevCron) {
              await this.deps.scheduler.scheduleCron(registrationId, jobData, prevCron, prevTz);
              rescheduleRestored = true;
            } else if (prevDelay !== undefined) {
              await this.deps.scheduler.scheduleOnce(
                registrationId,
                { ...jobData, type: 'once' as const },
                prevDelay,
              );
              rescheduleRestored = true;
            }
          } catch (rollbackErr) {
            log.error('Failed to restore previous cron schedule after update failure', {
              registrationId,
              error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
            });
          }
          // Revert the DB config to the existing snapshot so that DB and BullMQ
          // agree. Without this revert, the trigger record would advertise the
          // new schedule while BullMQ runs the old one (rollback succeeded) or
          // nothing at all (rollback failed). Also revert the workflow doc's
          // denormalized triggers[].config copy. Mark status='error' when the
          // schedule could not be restored.
          //
          // The trigger doc stores `cronExpression` BOTH at the document root
          // and inside `config.cronExpression` (legacy + canonical). Restore
          // whichever was present pre-edit; fall back to the snapshot's
          // top-level value so callers that wrote only the root field don't
          // lose it on revert.
          try {
            const prevTopLevelCron =
              (trigger.cronExpression as string | undefined) ??
              (typeof existingConfig.cronExpression === 'string'
                ? (existingConfig.cronExpression as string)
                : undefined);
            const revertSet: Record<string, unknown> = { config: existingConfig };
            if (prevTopLevelCron) revertSet.cronExpression = prevTopLevelCron;
            if (!rescheduleRestored) revertSet.status = 'error';
            const revertUpdate: Record<string, unknown> = { $set: revertSet };
            if (!prevTopLevelCron) {
              revertUpdate.$unset = { cronExpression: 1 };
            }
            await this.deps.triggerModel.findOneAndUpdate(filter, revertUpdate);
            if (workflowId) {
              await this.deps.workflowModel.findOneAndUpdate(
                { _id: workflowId, tenantId, 'triggers.id': registrationId },
                { $set: { 'triggers.$.config': existingConfig } },
              );
            }
          } catch (revertErr) {
            log.error('Failed to revert trigger config after schedule failure', {
              registrationId,
              error: revertErr instanceof Error ? revertErr.message : String(revertErr),
            });
          }
          const summary = summarizeTriggerError(err);
          this.emitAudit({
            action: 'trigger.update_failed',
            registrationId,
            tenantId,
            projectId: projectId ?? (trigger.projectId as string | undefined),
            workflowId,
            triggerType,
            outcome: 'error',
            metadata: {
              reasonCode: summary.code,
              reason: summary.message,
              rollback: rescheduleRestored ? 'restored' : 'failed',
              cronBacked: true,
            },
          });
          throw err;
        }
      }
    }

    log.info('Trigger updated', { registrationId, triggerType });
    this.emitAudit({
      action: 'trigger.updated',
      registrationId,
      tenantId,
      projectId: projectId ?? (trigger.projectId as string | undefined),
      workflowId,
      triggerType,
      outcome: 'success',
      metadata: shouldNormalizeCron
        ? { cronBacked: true, resolvedCron: resolvedCron ?? null }
        : { connectorBacked: false },
    });
  }

  // Backwards-compatible alias: older callers / tests may still call this name.
  async updateCronTrigger(
    registrationId: string,
    config: Record<string, unknown>,
    tenantId: string,
    projectId?: string,
  ): Promise<void> {
    await this.updateTrigger(registrationId, config, tenantId, projectId);
  }

  /**
   * Soft-delete a trigger registration (sets status to 'deleted').
   * Scoped to tenantId and optionally projectId for isolation.
   */
  async deregister(registrationId: string, tenantId: string, projectId?: string): Promise<void> {
    const filter: Record<string, unknown> = { _id: registrationId, tenantId };
    if (projectId) filter.projectId = projectId;
    const trigger = await this.deps.triggerModel.findOne(filter);
    await this.deps.triggerModel.findOneAndUpdate(filter, {
      $set: { status: 'deleted', deletedAt: new Date() },
    });
    // Sync removal from denormalized workflow.triggers[] array
    if (trigger) {
      await this.deps.workflowModel.findOneAndUpdate(
        { _id: trigger.workflowId as string, tenantId },
        { $pull: { triggers: { id: registrationId } } },
      );

      // Delegate webhook cleanup to the connector engine so AP-style pieces
      // can call their provider's API to delete the webhook subscription.
      const connectorName = trigger.connectorName as string | undefined;
      const triggerName = trigger.triggerName as string | undefined;
      const connectionId = trigger.connectionId as string | undefined;
      const triggerProjectId = (trigger.projectId as string | undefined) ?? projectId;
      if (
        this.deps.connectorTriggerEngine &&
        connectorName &&
        connectorName !== 'manual' &&
        triggerName &&
        connectionId &&
        triggerProjectId
      ) {
        try {
          const cfg = (trigger.config ?? {}) as Record<string, unknown>;
          await this.deps.connectorTriggerEngine.deregisterTrigger(registrationId, 'webhook', {
            connectorName,
            triggerName,
            tenantId,
            projectId: triggerProjectId,
            connectionId,
            triggerParams: cfg.triggerParams as Record<string, unknown> | undefined,
          });
        } catch (err) {
          log.warn('Connector deregisterTrigger failed — continuing', {
            registrationId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    // Unschedule any BullMQ jobs for cron/polling triggers
    if (this.deps.scheduler) {
      await this.deps.scheduler.unschedule(registrationId);
    }
    log.info('Trigger deregistered', { registrationId, tenantId });
  }

  /**
   * Pause an active trigger so it stops firing.
   */
  async pause(registrationId: string, tenantId: string, projectId?: string): Promise<void> {
    const filter: Record<string, unknown> = { _id: registrationId, tenantId };
    if (projectId) filter.projectId = projectId;

    // VERSION_INACTIVE guard: reject pause if owning version is inactive
    const trigger = await this.deps.triggerModel.findOne(filter);
    if (trigger) {
      const versionId = trigger.workflowVersionId as string | undefined;
      if (versionId && this.deps.workflowVersionModel) {
        const version = await this.deps.workflowVersionModel.findOne({ _id: versionId }).lean();
        if (version && (version.state as string) === 'inactive') {
          throw new Error('Cannot pause trigger for inactive version (VERSION_INACTIVE)');
        }
      }
    }

    await this.deps.triggerModel.findOneAndUpdate(filter, {
      $set: { status: 'paused' },
    });
    // Unschedule BullMQ jobs when pausing
    if (this.deps.scheduler) {
      await this.deps.scheduler.unschedule(registrationId);
    }
    log.info('Trigger paused', { registrationId, tenantId });
  }

  /**
   * Resume a paused trigger so it starts firing again.
   */
  async resume(registrationId: string, tenantId: string, projectId?: string): Promise<void> {
    const filter: Record<string, unknown> = { _id: registrationId, tenantId };
    if (projectId) filter.projectId = projectId;

    // Re-read registration to get config for rescheduling
    const trigger = await this.deps.triggerModel.findOne(filter);

    // VERSION_INACTIVE guard: reject resume if owning version is inactive
    if (trigger) {
      const versionId = trigger.workflowVersionId as string | undefined;
      if (versionId && this.deps.workflowVersionModel) {
        const version = await this.deps.workflowVersionModel.findOne({ _id: versionId }).lean();
        if (version && (version.state as string) === 'inactive') {
          throw new Error('Cannot resume trigger for inactive version (VERSION_INACTIVE)');
        }
      }
    }

    await this.deps.triggerModel.findOneAndUpdate(filter, {
      $set: { status: 'active' },
    });

    // Connector-backed triggers (Gmail polling, Slack events, …) were
    // unscheduled via `connectorTriggerEngine.deregisterTrigger()` on pause.
    // Re-register them before the BullMQ branch so a resume actually wires
    // polling/webhook delivery back up — without this the trigger stayed
    // persisted but silently never fired again. Mirrors the connector
    // delegation in `register()`; `config.connectorName` is the real signal
    // regardless of the Studio-facing `triggerType` enum.
    if (trigger) {
      const connectorName = (trigger.config as Record<string, unknown> | undefined)
        ?.connectorName as string | undefined;
      if (connectorName) {
        if (this.deps.connectorTriggerEngine) {
          const config = (trigger.config ?? {}) as Record<string, unknown>;
          await this.deps.connectorTriggerEngine.registerTrigger({
            registrationId,
            tenantId,
            projectId: (trigger.projectId as string) ?? '',
            workflowId: (trigger.workflowId as string) ?? '',
            connectorName,
            triggerName: (config.triggerName as string) ?? '',
            connectionId: (config.connectionId as string) ?? '',
            pollingIntervalMs: config.pollingIntervalMs as number | undefined,
            cronExpression: config.cronExpression as string | undefined,
            triggerParams: config.triggerParams as Record<string, unknown> | undefined,
          });
          log.info('Connector trigger re-registered on resume', {
            registrationId,
            connectorName,
          });
        } else {
          log.warn(
            'Connector trigger resumed but connectorTriggerEngine is unavailable — trigger will not fire until connectors runtime is attached',
            { registrationId, connectorName },
          );
        }
        // Connector triggers do NOT use the BullMQ scheduler — return early
        // so we don't double-register them below.
        log.info('Trigger resumed', { registrationId, tenantId });
        return;
      }
    }

    // Reschedule BullMQ jobs on resume
    if (this.deps.scheduler && trigger) {
      const strategy = trigger.triggerType as string;
      if (strategy === 'cron') {
        const config = (trigger.config ?? {}) as Record<string, unknown>;
        const triggerVersionId = trigger.workflowVersionId as string | undefined;
        const triggerEnvironment = trigger.environment as string | undefined;
        const jobData = {
          registrationId,
          tenantId,
          projectId: (trigger.projectId as string) ?? '',
          workflowId: (trigger.workflowId as string) ?? '',
          type: strategy as 'cron',
          ...(triggerVersionId ? { workflowVersionId: triggerVersionId } : {}),
          ...(triggerEnvironment ? { environment: triggerEnvironment } : {}),
        };
        // Prefer config.cronExpression (canonical since register() now writes
        // it there); fall back to the top-level field for legacy records.
        const cronExpression =
          (config.cronExpression as string | undefined) ??
          (trigger.cronExpression as string | undefined);
        if (cronExpression) {
          const tz = config.timezone as string | undefined;
          await this.deps.scheduler.scheduleCron(registrationId, jobData, cronExpression, tz);
        }
      }
    } else if (!this.deps.scheduler && trigger?.triggerType === 'cron') {
      log.warn(
        'Cron trigger resumed but scheduler is unavailable — trigger will not fire until Redis/BullMQ is configured',
        { registrationId },
      );
    }

    log.info('Trigger resumed', { registrationId, tenantId });
  }

  /**
   * Fire a webhook trigger. Loads the trigger registration and its associated
   * workflow, then starts a new workflow execution via Restate.
   *
   * @returns The execution ID for the newly started workflow run.
   * @throws If the trigger is not found/active or the workflow is missing.
   */
  async fireWebhookTrigger(
    registrationId: string,
    payload: Record<string, unknown>,
    tenantId: string,
    projectId?: string,
  ): Promise<{ executionId: string }> {
    const trigger = await this.deps.triggerModel.findOne({
      _id: registrationId,
      status: 'active',
      tenantId,
      ...(projectId ? { projectId } : {}),
    });
    if (!trigger) {
      throw new Error(`Trigger ${registrationId} not found or not active`);
    }

    // Environment gate (FR-17): skip if event/trigger environments don't match
    if (
      !environmentsMatch(
        payload.environment as string | undefined,
        trigger.environment as string | undefined,
      )
    ) {
      log.warn('Webhook trigger skipped — environment mismatch', {
        registrationId,
        payloadEnvironment: (payload.environment as string) ?? null,
        triggerEnvironment: (trigger.environment as string) ?? null,
      });
      throw new Error(
        `Environment mismatch: trigger expects '${(trigger.environment as string) ?? 'null'}' but received '${(payload.environment as string) ?? 'null'}'`,
      );
    }

    // Load workflow to get name and working copy steps
    const workflow = await this.deps.workflowModel.findOne({
      _id: trigger.workflowId as string,
      tenantId: trigger.tenantId as string,
      projectId: trigger.projectId as string,
    });
    if (!workflow) {
      throw new Error(`Workflow ${trigger.workflowId} not found`);
    }

    // Fire-time version resolution — full 5-tier cascade (see version-resolution.ts)
    const resolved = await resolveWorkflowDefinition(
      {
        workflow: {
          _id: trigger.workflowId as string,
          name: workflow.name,
          steps: workflow.steps,
          nodes: workflow.nodes,
          edges: workflow.edges,
        },
        tenantId: trigger.tenantId as string,
        projectId: trigger.projectId as string,
        pinnedVersionId: trigger.workflowVersionId as string | undefined,
        environment: trigger.environment as string | undefined,
        logContext: { registrationId },
      },
      {
        workflowVersionModel: this.deps.workflowVersionModel,
        deploymentModel: this.deps.deploymentModel,
      },
    );
    const executionId = crypto.randomUUID();
    // Preserve the trigger's actual type so executions are correctly labeled in
    // monitoring (cron-fired runs were previously mislabeled as webhooks because
    // this method was originally webhook-only). Webhook mode metadata is only
    // meaningful for webhooks — omit it otherwise.
    const triggerType = (trigger.triggerType as string | undefined) ?? 'webhook';
    const isWebhookFire = triggerType === 'webhook';
    await this.deps.restateClient.startWorkflow(
      executionId,
      buildWorkflowExecutionPayload({
        workflowId: trigger.workflowId as string,
        workflowName: workflow.name,
        tenantId: trigger.tenantId as string,
        projectId: trigger.projectId as string,
        triggerType: triggerType as import('../lib/execution-payload.js').WorkflowTriggerType,
        triggerPayload: payload,
        triggerMetadata: {
          registrationId,
          firedAt: new Date().toISOString(),
        },
        steps: resolved.steps,
        nameToIdMap: resolved.nameToIdMap,
        outputMappings: resolved.outputMappings,
        outputMappingsByEndNodeId: resolved.outputMappingsByEndNodeId,
        startInputVariables: resolved.startInputVariables,
        inDegreeMap: resolved.inDegreeMap,
        edgeMap: resolved.edgeMap,
        workflowVersion: resolved.workflowVersion,
        workflowVersionId: resolved.workflowVersionId,
        deploymentId: resolved.deploymentId,
        ...(isWebhookFire
          ? { webhookMode: 'async' as const, webhookDelivery: 'poll' as const }
          : {}),
      }),
    );

    log.info('Trigger fired', {
      registrationId,
      executionId,
      triggerType,
      workflowId: trigger.workflowId,
      workflowVersion: resolved.workflowVersion,
      workflowVersionId: resolved.workflowVersionId,
      deploymentId: resolved.deploymentId,
      resolutionTier: resolved.tier,
    });
    return { executionId };
  }

  /**
   * Return the triggerPayload from the most recent execution for a given
   * trigger registration, so the "Fire Now" UI can pre-populate its payload
   * editor with the last real (or last fired) payload.
   *
   * Checks in priority order:
   *   1. `samplePayload` on the registration (set by testSample — connector run())
   *   2. Most recent execution's triggerPayload from the execution model
   *
   * Returns null when no data is available or models are not wired.
   *
   * Scoped to the caller's tenantId+projectId so a caller cannot read
   * payloads from other tenants even by guessing a registration ID.
   */
  async getLastFirePayload(
    registrationId: string,
    tenantId: string,
    projectId?: string,
  ): Promise<Record<string, unknown> | null> {
    const filter: Record<string, unknown> = { _id: registrationId, tenantId };
    if (projectId) filter.projectId = projectId;
    const registration = await this.deps.triggerModel.findOne(filter);
    if (registration?.samplePayload) {
      const raw = registration.samplePayload;
      const expiresAt = registration.samplePayloadExpiresAt as Date | undefined;
      if (!expiresAt || expiresAt > new Date()) {
        if (typeof raw === 'string') {
          const decryptFn = this.deps.decryptSample;
          let plaintext = raw;
          if (decryptFn) {
            try {
              plaintext = await decryptFn(raw, tenantId);
            } catch {
              // decryption failed — treat as missing
              plaintext = '';
            }
          }
          if (plaintext) {
            try {
              const parsed = JSON.parse(plaintext) as unknown;
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
              }
            } catch {
              // not valid JSON — treat as missing
            }
          }
        } else if (typeof raw === 'object' && !Array.isArray(raw)) {
          // Legacy unencrypted object stored before encryption was introduced
          return raw as Record<string, unknown>;
        }
      }
    }

    if (!this.deps.executionModel) return null;
    const execFilter: Record<string, unknown> = {
      tenantId,
      'triggerMetadata.registrationId': registrationId,
    };
    if (projectId) execFilter.projectId = projectId;
    const doc = await this.deps.executionModel
      .findOne(execFilter)
      .sort({ startedAt: -1 })
      .select('input')
      .lean();
    const payload = doc?.input;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      return payload as Record<string, unknown>;
    }
    return null;
  }

  /**
   * Run the connector trigger's test/run function using stored credentials to
   * get sample data. Delegates to `connectorTriggerEngine.testSample()` and
   * persists the result so `getLastFirePayload` can serve it immediately.
   */
  async testSample(
    registrationId: string,
    tenantId: string,
    projectId: string,
  ): Promise<{ sample: Record<string, unknown>; itemCount: number }> {
    if (!this.deps.connectorTriggerEngine?.testSample) {
      throw new Error('testSample not supported — connectorTriggerEngine not wired');
    }
    return this.deps.connectorTriggerEngine.testSample(registrationId, tenantId, projectId);
  }
}

/**
 * Strict environment equality for trigger routing (FR-17).
 * Both-null is equal. One-null-one-set is NOT equal.
 *
 * 5-case matrix:
 * 1. both equal non-null → true
 * 2. both non-null but different → false
 * 3. event null + trigger set → false
 * 4. event set + trigger null → false
 * 5. both null → true
 */
export function environmentsMatch(
  eventEnv: string | null | undefined,
  triggerEnv: string | null | undefined,
): boolean {
  const e = eventEnv ?? null;
  const t = triggerEnv ?? null;
  return e === t;
}
