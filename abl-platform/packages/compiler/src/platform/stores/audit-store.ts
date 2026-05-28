/**
 * Audit Store
 *
 * Immutable audit trail for compliance, debugging, and analytics.
 * All operations are append-only for audit integrity.
 */

import { randomUUID } from 'crypto';
import type {
  AuditActorType,
  AuditLog,
  AuditEventType,
  AuditMetadataEncoding,
  AuditResourceType,
  AuditRetentionClass,
  AuditSource,
  Environment,
} from '../core/types.js';
import { createLogger } from '../logger.js';

const log = createLogger('audit-store');

// =============================================================================
// INTERFACES
// =============================================================================

export interface AuditStoreConfig {
  /** Storage backend type.
   * - 'clickhouse': Shared production backend
   * - 'mongodb': Legacy compatibility alias (unsupported in compiler runtime)
   * - 'memory': Development/testing only
   * Shared audit retention is enforced by the destination backend.
   */
  type: 'clickhouse' | 'memory' | 'mongodb';
  connectionString?: string;
  retentionDays?: number;
}

export interface LogAuditParams {
  /** Tenant ID. Defaults to 'unscoped' for callers without tenant context. */
  tenantId?: string;
  projectId?: string;
  eventType: AuditEventType;
  actor: string;
  actorType: AuditActorType;
  resourceType: AuditResourceType;
  resourceId: string;
  environment: Environment;
  action: string;
  oldValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  traceId?: string;
  schemaVersion?: number;
  source?: AuditSource;
  metadataEncoding?: AuditMetadataEncoding;
  retentionClass?: AuditRetentionClass;
  expiresAt?: Date | null;
}

export interface QueryAuditParams {
  tenantId?: string;
  projectId?: string;
  eventTypes?: AuditEventType[];
  actions?: string[];
  actor?: string;
  actorType?: AuditActorType;
  resourceType?: AuditResourceType;
  resourceId?: string;
  environment?: Environment;
  startTime: Date;
  endTime: Date;
  limit?: number;
  offset?: number;
}

export interface AuditSummary {
  totalEvents: number;
  eventsByType: Record<AuditEventType, number>;
  eventsByActor: Record<string, number>;
  eventsByResource: Record<string, number>;
}

// =============================================================================
// ALERT CONFIGURATION
// =============================================================================

export interface AlertConfig {
  enabled: boolean;
  webhookUrl?: string;
  slackWebhook?: string;
  criticalEvents: AuditEventType[];
}

export interface AlertPayload {
  eventType: AuditEventType;
  severity: 'info' | 'warning' | 'critical';
  summary: string;
  auditLog: AuditLog;
  timestamp: Date;
}

// =============================================================================
// ABSTRACT STORE
// =============================================================================

export abstract class AuditStore {
  protected config: AuditStoreConfig;
  protected alertConfig?: AlertConfig;

  constructor(config: AuditStoreConfig, alertConfig?: AlertConfig) {
    this.config = config;
    this.alertConfig = alertConfig;
  }

  /**
   * Log an audit event (append-only)
   */
  async log(params: LogAuditParams): Promise<AuditLog> {
    const auditLog: AuditLog = {
      id: randomUUID(),
      tenantId: params.tenantId || 'unscoped',
      projectId: params.projectId,
      timestamp: new Date(),
      eventType: params.eventType,
      actor: params.actor,
      actorType: params.actorType,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      environment: params.environment,
      action: params.action,
      oldValue: params.oldValue,
      newValue: params.newValue,
      metadata: params.metadata || {},
      ipAddress: params.ipAddress,
      traceId: params.traceId,
      schemaVersion: params.schemaVersion ?? 2,
      source: params.source ?? 'runtime-store',
      metadataEncoding: params.metadataEncoding ?? 'object',
      retentionClass: params.retentionClass ?? 'default',
      expiresAt: params.expiresAt ?? null,
    };

    // Persist the audit log
    await this.append(auditLog);

    // Check if we need to send alerts
    await this.checkAlerts(auditLog);

    return auditLog;
  }

  /**
   * Convenience methods for common audit events
   */
  async logAgentCreated(
    agentName: string,
    version: string,
    createdBy: string,
    environment: Environment,
  ): Promise<AuditLog> {
    return this.log({
      eventType: 'agent.created',
      actor: createdBy,
      actorType: 'admin',
      resourceType: 'agent',
      resourceId: agentName,
      environment,
      action: `Created agent ${agentName} version ${version}`,
      newValue: { version },
    });
  }

  async logAgentPromoted(
    agentName: string,
    version: string,
    fromEnv: Environment,
    toEnv: Environment,
    promotedBy: string,
  ): Promise<AuditLog> {
    return this.log({
      eventType: 'agent.promoted',
      actor: promotedBy,
      actorType: 'admin',
      resourceType: 'agent',
      resourceId: agentName,
      environment: toEnv,
      action: `Promoted ${agentName} v${version} from ${fromEnv} to ${toEnv}`,
      oldValue: { environment: fromEnv },
      newValue: { environment: toEnv, version },
    });
  }

  async logAgentRolledBack(
    agentName: string,
    fromVersion: string,
    toVersion: string,
    reason: string,
    rolledBackBy: string,
    environment: Environment,
  ): Promise<AuditLog> {
    return this.log({
      eventType: 'agent.rolled_back',
      actor: rolledBackBy,
      actorType: 'admin',
      resourceType: 'agent',
      resourceId: agentName,
      environment,
      action: `Rolled back ${agentName} from v${fromVersion} to v${toVersion}: ${reason}`,
      oldValue: { version: fromVersion },
      newValue: { version: toVersion, reason },
    });
  }

  async logEscalationTriggered(
    sessionId: string,
    agentName: string,
    reason: string,
    priority: string,
    environment: Environment,
    traceId?: string,
  ): Promise<AuditLog> {
    return this.log({
      eventType: 'escalation.triggered',
      actor: agentName,
      actorType: 'agent',
      resourceType: 'session',
      resourceId: sessionId,
      environment,
      action: `Escalation triggered: ${reason}`,
      metadata: { reason, priority },
      traceId,
    });
  }

  async logHumanIntervention(
    sessionId: string,
    humanAgentId: string,
    action: string,
    environment: Environment,
    traceId?: string,
  ): Promise<AuditLog> {
    return this.log({
      eventType: 'human.intervention',
      actor: humanAgentId,
      actorType: 'admin',
      resourceType: 'session',
      resourceId: sessionId,
      environment,
      action: `Human intervention: ${action}`,
      traceId,
    });
  }

  /**
   * Check if alert should be sent
   */
  protected async checkAlerts(auditLog: AuditLog): Promise<void> {
    if (!this.alertConfig?.enabled) return;

    const isCritical = this.alertConfig.criticalEvents.includes(auditLog.eventType);
    const isError =
      auditLog.eventType.includes('error') || auditLog.eventType === 'agent.rolled_back';

    if (isCritical || isError) {
      const payload: AlertPayload = {
        eventType: auditLog.eventType,
        severity: isCritical ? 'critical' : 'warning',
        summary: `[${auditLog.environment}] ${auditLog.action}`,
        auditLog,
        timestamp: new Date(),
      };

      await this.sendAlert(payload);
    }
  }

  protected async sendAlert(payload: AlertPayload): Promise<void> {
    if (!this.alertConfig) return;

    // Send to webhook
    if (this.alertConfig.webhookUrl) {
      try {
        await fetch(this.alertConfig.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (error) {
        log.error('Failed to send webhook alert', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Send to Slack
    if (this.alertConfig.slackWebhook) {
      const slackPayload = {
        text: `*${payload.severity.toUpperCase()}* - ${payload.summary}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${payload.eventType}*\n${payload.summary}`,
            },
          },
          {
            type: 'context',
            elements: [
              { type: 'mrkdwn', text: `Environment: ${payload.auditLog.environment}` },
              { type: 'mrkdwn', text: `Actor: ${payload.auditLog.actor}` },
            ],
          },
        ],
      };

      try {
        await fetch(this.alertConfig.slackWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(slackPayload),
        });
      } catch (error) {
        log.error('Failed to send Slack alert', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async close(): Promise<void> {}

  // Abstract methods
  protected abstract append(log: AuditLog): Promise<void>;
  abstract query(params: QueryAuditParams): Promise<{ logs: AuditLog[]; total: number }>;
  abstract getSummary(
    scope: string,
    environment: Environment,
    startTime: Date,
    endTime: Date,
  ): Promise<AuditSummary>;
  abstract getByTraceId(scope: string, traceId: string): Promise<AuditLog[]>;
}

// =============================================================================
// IN-MEMORY IMPLEMENTATION
// =============================================================================

export class InMemoryAuditStore extends AuditStore {
  private logs: AuditLog[] = [];

  protected async append(log: AuditLog): Promise<void> {
    this.logs.push(log);
  }

  async query(params: QueryAuditParams): Promise<{ logs: AuditLog[]; total: number }> {
    let logs = [...this.logs];

    // Filter by time range
    logs = logs.filter((l) => l.timestamp >= params.startTime && l.timestamp <= params.endTime);

    if (params.eventTypes) {
      logs = logs.filter((l) => params.eventTypes!.includes(l.eventType));
    }
    if (params.tenantId) {
      logs = logs.filter((l) => l.tenantId === params.tenantId);
    }
    if (params.projectId) {
      logs = logs.filter((l) => l.projectId === params.projectId);
    }
    if (params.actor) {
      logs = logs.filter((l) => l.actor === params.actor);
    }
    if (params.actorType) {
      logs = logs.filter((l) => l.actorType === params.actorType);
    }
    if (params.resourceType) {
      logs = logs.filter((l) => l.resourceType === params.resourceType);
    }
    if (params.resourceId) {
      logs = logs.filter((l) => l.resourceId === params.resourceId);
    }
    if (params.environment) {
      logs = logs.filter((l) => l.environment === params.environment);
    }

    // Sort by timestamp descending
    logs.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    const total = logs.length;
    const offset = params.offset || 0;
    const limit = params.limit || 100;

    return {
      logs: logs.slice(offset, offset + limit),
      total,
    };
  }

  async getSummary(
    _scope: string,
    environment: Environment,
    startTime: Date,
    endTime: Date,
  ): Promise<AuditSummary> {
    const logs = this.logs.filter(
      (l) => l.environment === environment && l.timestamp >= startTime && l.timestamp <= endTime,
    );

    const eventsByType: Record<string, number> = {};
    const eventsByActor: Record<string, number> = {};
    const eventsByResource: Record<string, number> = {};

    for (const log of logs) {
      eventsByType[log.eventType] = (eventsByType[log.eventType] || 0) + 1;
      eventsByActor[log.actor] = (eventsByActor[log.actor] || 0) + 1;
      const resourceKey = `${log.resourceType}:${log.resourceId}`;
      eventsByResource[resourceKey] = (eventsByResource[resourceKey] || 0) + 1;
    }

    return {
      totalEvents: logs.length,
      eventsByType: eventsByType as Record<AuditEventType, number>,
      eventsByActor,
      eventsByResource,
    };
  }

  async getByTraceId(_scope: string, traceId: string): Promise<AuditLog[]> {
    return this.logs.filter((l) => l.traceId === traceId);
  }
}

// =============================================================================
// FACTORY
// =============================================================================

export function createAuditStore(config: AuditStoreConfig, alertConfig?: AlertConfig): AuditStore {
  switch (config.type) {
    case 'memory':
      return new InMemoryAuditStore(config, alertConfig);
    case 'mongodb':
      throw new Error(
        'MongoDB audit store is no longer supported in @abl/compiler; use the shared Kafka -> ClickHouse audit pipeline instead',
      );
    default:
      throw new Error(`Unknown audit store type: ${config.type}`);
  }
}
