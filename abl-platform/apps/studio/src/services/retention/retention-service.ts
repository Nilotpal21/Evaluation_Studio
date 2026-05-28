/**
 * Data Retention Service
 *
 * Enforces data retention policies per tenant:
 * - Session archival and deletion based on plan
 * - PII scrubbing for GDPR compliance
 * - Audit retention policy decisions and rollout gates
 * - Compliance conflict resolution (compliance > plan)
 *
 * Designed to be run as a scheduled job (daily).
 */

import crypto from 'crypto';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('retention-service');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComplianceRequirement = 'soc2' | 'hipaa' | 'gdpr' | 'pci_dss';

export interface RetentionPolicy {
  tenantId: string;
  plan: string;

  sessions: {
    activeRetentionDays: number; // Keep in hot storage
    archiveRetentionDays: number; // Keep in cold storage
    totalRetentionDays: number; // Hard delete after this
  };

  messages: {
    retentionDays: number;
    piiRetentionDays: number; // PII scrubbed earlier
  };

  traces: {
    hotRetentionDays: number;
    analyticsRetentionDays: number;
  };

  auditLogs: {
    retentionDays: number;
    immutable: boolean;
  };

  events?: {
    totalRetentionDays: number;
    piiRetentionDays: number;
  };
}

export interface RetentionPlan {
  tenantId: string;
  sessionsToArchive: string[];
  sessionsToDelete: string[];
  tracesToPurge: string[];
  piiFieldsToScrub: string[];
  auditLogsToArchive: string[];
}

export interface RetentionReport {
  tenantId: string;
  archived: number;
  deleted: number;
  scrubbed: number;
  tracePurged: number;
  errors: string[];
  executedAt: Date;
}

export interface DeletionRequest {
  id: string;
  tenantId: string;
  requestedBy: string;
  subjectId: string;
  scope: 'all_data' | 'sessions_only' | 'pii_only';
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  createdAt: Date;
  completedAt?: Date;
  failureReason?: string;
  slaDeadline: Date; // GDPR: 30 days from request
}

export type AuditRetentionSubsystem =
  | 'sharedMongoAuditLogs'
  | 'sharedClickHouseAuditEvents'
  | 'kmsAudit'
  | 'piiAudit'
  | 'archAiAudit'
  | 'crawlAudit'
  | 'omnichannelBuffer';

export interface AuditRetentionMatrixEntry {
  subsystem: AuditRetentionSubsystem;
  defaultPolicy: string;
  classification: 'shared-audit' | 'dedicated-audit' | 'operational-history';
  ttlMode: 'disabled-by-default' | 'dedicated-ttl' | 'policy-review' | 'not-applicable';
  requiresExplicitApproval: boolean;
  notes: string;
}

// ---------------------------------------------------------------------------
// Plan-based retention defaults
// ---------------------------------------------------------------------------

const PLAN_RETENTION: Record<string, Omit<RetentionPolicy, 'tenantId' | 'plan'>> = {
  FREE: {
    sessions: { activeRetentionDays: 7, archiveRetentionDays: 0, totalRetentionDays: 7 },
    messages: { retentionDays: 30, piiRetentionDays: 7 },
    traces: { hotRetentionDays: 7, analyticsRetentionDays: 30 },
    auditLogs: { retentionDays: 30, immutable: true },
    events: { totalRetentionDays: 30, piiRetentionDays: 7 },
  },
  TEAM: {
    sessions: { activeRetentionDays: 30, archiveRetentionDays: 60, totalRetentionDays: 90 },
    messages: { retentionDays: 30, piiRetentionDays: 30 },
    traces: { hotRetentionDays: 30, analyticsRetentionDays: 90 },
    auditLogs: { retentionDays: 90, immutable: true },
    events: { totalRetentionDays: 90, piiRetentionDays: 30 },
  },
  BUSINESS: {
    sessions: { activeRetentionDays: 90, archiveRetentionDays: 180, totalRetentionDays: 365 },
    messages: { retentionDays: 90, piiRetentionDays: 90 },
    traces: { hotRetentionDays: 90, analyticsRetentionDays: 365 },
    auditLogs: { retentionDays: 365, immutable: true },
    events: { totalRetentionDays: 365, piiRetentionDays: 90 },
  },
  ENTERPRISE: {
    sessions: { activeRetentionDays: 365, archiveRetentionDays: 730, totalRetentionDays: 2555 },
    messages: { retentionDays: 365, piiRetentionDays: 365 },
    traces: { hotRetentionDays: 365, analyticsRetentionDays: 2555 },
    auditLogs: { retentionDays: 2555, immutable: true },
    events: { totalRetentionDays: 2555, piiRetentionDays: 365 },
  },
};

const AUDIT_RETENTION_MATRIX: AuditRetentionMatrixEntry[] = [
  {
    subsystem: 'sharedMongoAuditLogs',
    defaultPolicy:
      'Approved default: shared Mongo audit remains non-expiring unless a future rollout explicitly enables TTL indexes.',
    classification: 'shared-audit',
    ttlMode: 'disabled-by-default',
    requiresExplicitApproval: false,
    notes:
      'This preserves current archive-first assumptions while keeping TTL rollout behind a separate, explicit change.',
  },
  {
    subsystem: 'sharedClickHouseAuditEvents',
    defaultPolicy:
      'Approved default: hot storage for 90 days, then cold storage until 730-day hard delete.',
    classification: 'shared-audit',
    ttlMode: 'policy-review',
    requiresExplicitApproval: false,
    notes:
      'ClickHouse keeps its own explicit retention contract instead of inheriting shared Mongo semantics.',
  },
  {
    subsystem: 'kmsAudit',
    defaultPolicy: 'Keep the dedicated compliance retention already defined for KMS audit.',
    classification: 'dedicated-audit',
    ttlMode: 'policy-review',
    requiresExplicitApproval: false,
    notes: 'KMS audit is intentionally governed by its own compliance-specific retention contract.',
  },
  {
    subsystem: 'piiAudit',
    defaultPolicy:
      'Keep dedicated short-lived TTL behavior with explicit shutdown flush hardening.',
    classification: 'dedicated-audit',
    ttlMode: 'dedicated-ttl',
    requiresExplicitApproval: false,
    notes:
      'PII audit remains intentionally short-lived and separate from the shared audit retention policy.',
  },
  {
    subsystem: 'archAiAudit',
    defaultPolicy: 'Keep the dedicated Arch AI TTL policy configurable within its own subsystem.',
    classification: 'dedicated-audit',
    ttlMode: 'dedicated-ttl',
    requiresExplicitApproval: false,
    notes: 'Arch AI retains its own schema, access patterns, and retention behavior.',
  },
  {
    subsystem: 'crawlAudit',
    defaultPolicy:
      'Approved classification: crawl audit is operational history, not immutable compliance audit.',
    classification: 'operational-history',
    ttlMode: 'policy-review',
    requiresExplicitApproval: false,
    notes:
      'Crawl history remains explicitly separated so operational cleanup does not masquerade as compliance audit.',
  },
  {
    subsystem: 'omnichannelBuffer',
    defaultPolicy:
      'Operational-only in-memory buffer with no compliance-grade durability guarantees.',
    classification: 'operational-history',
    ttlMode: 'not-applicable',
    requiresExplicitApproval: false,
    notes:
      'This path should remain clearly labeled as operational/debug history, not durable audit.',
  },
];

export function getAuditRetentionMatrix(): AuditRetentionMatrixEntry[] {
  return AUDIT_RETENTION_MATRIX.map((entry) => ({ ...entry }));
}

// ---------------------------------------------------------------------------
// Compliance conflict resolution
// ---------------------------------------------------------------------------

export function resolveRetention(
  policy: RetentionPolicy,
  requirements: ComplianceRequirement[],
): RetentionPolicy {
  const resolved = JSON.parse(JSON.stringify(policy)) as RetentionPolicy;

  for (const req of requirements) {
    switch (req) {
      case 'soc2':
        // SOC 2: Minimum 365 days for audit logs
        resolved.auditLogs.retentionDays = Math.max(resolved.auditLogs.retentionDays, 365);
        break;

      case 'hipaa':
        // HIPAA: 6 years retention for health data
        resolved.sessions.totalRetentionDays = Math.max(resolved.sessions.totalRetentionDays, 2190);
        resolved.auditLogs.retentionDays = Math.max(resolved.auditLogs.retentionDays, 2190);
        break;

      case 'gdpr':
        // GDPR: PII must not outlive general retention
        resolved.messages.piiRetentionDays = Math.min(
          resolved.messages.piiRetentionDays,
          resolved.messages.retentionDays,
        );
        if (resolved.events) {
          resolved.events.piiRetentionDays = Math.min(
            resolved.events.piiRetentionDays,
            resolved.events.totalRetentionDays,
          );
        }
        break;

      case 'pci_dss':
        // PCI DSS: No raw card data; scrub immediately
        resolved.messages.piiRetentionDays = 0;
        if (resolved.events) {
          resolved.events.piiRetentionDays = 0;
        }
        break;
    }
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Retention Service
// ---------------------------------------------------------------------------

/** Minimal database interface for retention operations */
export interface RetentionStore {
  findSessionsOlderThan(tenantId: string, date: Date): Promise<string[]>;
  findArchivedSessionsOlderThan(tenantId: string, date: Date): Promise<string[]>;
  findTracesOlderThan(tenantId: string, date: Date): Promise<string[]>;
  findMessagesWithPIIOlderThan(tenantId: string, date: Date): Promise<string[]>;
  archiveSessions(sessionIds: string[], tenantId: string): Promise<void>;
  deleteSession(sessionId: string, tenantId: string): Promise<void>;
  deleteTraces(traceIds: string[]): Promise<void>;
  scrubPIIBatch(messageIds: string[], tenantId: string): Promise<void>;
}

export class RetentionService {
  constructor(private store: RetentionStore) {}

  /** Get retention policy for a tenant */
  getPolicy(
    tenantId: string,
    plan: string,
    compliance: ComplianceRequirement[] = [],
  ): RetentionPolicy {
    const defaults = PLAN_RETENTION[plan] || PLAN_RETENTION.FREE;
    const policy: RetentionPolicy = {
      tenantId,
      plan,
      ...JSON.parse(JSON.stringify(defaults)),
    };

    if (compliance.length > 0) {
      return resolveRetention(policy, compliance);
    }

    return policy;
  }

  /** Plan what needs to be retained/deleted */
  async planRetention(tenantId: string, policy: RetentionPolicy): Promise<RetentionPlan> {
    const now = new Date();

    const [sessionsToArchive, sessionsToDelete, tracesToPurge, piiFieldsToScrub] =
      await Promise.all([
        this.store.findSessionsOlderThan(
          tenantId,
          subDays(now, policy.sessions.activeRetentionDays),
        ),
        this.store.findArchivedSessionsOlderThan(
          tenantId,
          subDays(now, policy.sessions.totalRetentionDays),
        ),
        this.store.findTracesOlderThan(tenantId, subDays(now, policy.traces.hotRetentionDays)),
        this.store.findMessagesWithPIIOlderThan(
          tenantId,
          subDays(now, policy.messages.piiRetentionDays),
        ),
      ]);

    return {
      tenantId,
      sessionsToArchive,
      sessionsToDelete,
      tracesToPurge,
      piiFieldsToScrub,
      auditLogsToArchive: [], // Shared audit remains indefinite by default; TTL rollout is gated separately.
    };
  }

  /** Execute retention plan */
  async executeRetention(plan: RetentionPlan): Promise<RetentionReport> {
    const report: RetentionReport = {
      tenantId: plan.tenantId,
      archived: 0,
      deleted: 0,
      scrubbed: 0,
      tracePurged: 0,
      errors: [],
      executedAt: new Date(),
    };

    // Archive sessions before deletion (batch)
    if (plan.sessionsToArchive.length > 0) {
      try {
        await this.store.archiveSessions(plan.sessionsToArchive, plan.tenantId);
        report.archived = plan.sessionsToArchive.length;
      } catch (error) {
        report.errors.push(`Archive failed for sessions: ${error}`);
      }
    }

    // Hard delete expired archived sessions
    for (const sessionId of plan.sessionsToDelete) {
      try {
        await this.store.deleteSession(sessionId, plan.tenantId);
        report.deleted++;
      } catch (error) {
        report.errors.push(`Delete failed for session ${sessionId}: ${error}`);
      }
    }

    // Purge traces
    if (plan.tracesToPurge.length > 0) {
      try {
        await this.store.deleteTraces(plan.tracesToPurge);
        report.tracePurged = plan.tracesToPurge.length;
      } catch (error) {
        report.errors.push(`Trace purge failed: ${error}`);
      }
    }

    // Scrub PII from messages (batch)
    if (plan.piiFieldsToScrub.length > 0) {
      try {
        await this.store.scrubPIIBatch(plan.piiFieldsToScrub, plan.tenantId);
        report.scrubbed = plan.piiFieldsToScrub.length;
      } catch (error) {
        report.errors.push(`PII scrub failed: ${error}`);
      }
    }

    return report;
  }
}

// ---------------------------------------------------------------------------
// GDPR Deletion Service
// ---------------------------------------------------------------------------

export interface GDPRStore {
  findSubjectSessions(subjectId: string, tenantId: string): Promise<string[]>;
  findSubjectMessages(subjectId: string, tenantId: string): Promise<string[]>;
  findSubjectTraces(subjectId: string, tenantId: string): Promise<string[]>;
  findSubjectContacts(subjectId: string, tenantId: string): Promise<string[]>;
  findSubjectAttachments(subjectId: string, tenantId: string): Promise<string[]>;
  deleteSession(sessionId: string, tenantId: string): Promise<void>;
  deleteMessages(messageIds: string[], tenantId?: string): Promise<void>;
  anonymizeTraces(traceIds: string[], tenantId: string): Promise<void>;
  anonymizeAuditEntries(subjectId: string, tenantId: string): Promise<void>;
  anonymizeContacts(contactIds: string[], tenantId?: string): Promise<void>;
  anonymizeAttachments(attachmentIds: string[], tenantId: string): Promise<void>;
  anonymizeUser(subjectId: string, tenantId: string): Promise<void>;
  deletePersonalAuthProfiles(subjectId: string, tenantId: string): Promise<void>;
  reassignSharedAuthProfiles(subjectId: string, tenantId: string): Promise<void>;
}

export class GDPRDeletionService {
  constructor(private store: GDPRStore) {}

  /** Process a right-to-be-forgotten request */
  async processDeletionRequest(request: DeletionRequest): Promise<DeletionRequest> {
    const updated: DeletionRequest = { ...request, status: 'in_progress' };

    try {
      const [sessions, messages, traces] = await Promise.all([
        this.store.findSubjectSessions(request.subjectId, request.tenantId),
        this.store.findSubjectMessages(request.subjectId, request.tenantId),
        this.store.findSubjectTraces(request.subjectId, request.tenantId),
      ]);

      if (request.scope === 'all_data' || request.scope === 'sessions_only') {
        // Delete sessions and associated messages
        for (const sessionId of sessions) {
          await this.store.deleteSession(sessionId, request.tenantId);
        }
        if (messages.length > 0) {
          await this.store.deleteMessages(messages, request.tenantId);
        }
      }

      if (request.scope === 'all_data' || request.scope === 'pii_only') {
        // Anonymize traces (cannot fully delete — keep structure)
        if (traces.length > 0) {
          await this.store.anonymizeTraces(traces, request.tenantId);
        }
        // Anonymize audit entries (cannot delete — compliance)
        await this.store.anonymizeAuditEntries(request.subjectId, request.tenantId);

        // Anonymize contacts linked to the subject
        const contactIds = await this.store.findSubjectContacts(
          request.subjectId,
          request.tenantId,
        );
        if (contactIds.length > 0) {
          await this.store.anonymizeContacts(contactIds, request.tenantId);
        }

        // Anonymize attachment PII (filenames, processed content, descriptions)
        const attachmentIds = await this.store.findSubjectAttachments(
          request.subjectId,
          request.tenantId,
        );
        if (attachmentIds.length > 0) {
          await this.store.anonymizeAttachments(attachmentIds, request.tenantId);
        }

        // Anonymize the User record itself (email, name, OAuth IDs, credentials)
        await this.store.anonymizeUser(request.subjectId, request.tenantId);
      }

      updated.status = 'completed';
      updated.completedAt = new Date();
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error('GDPR deletion failed', {
        requestId: request.id,
        tenantId: request.tenantId,
        subjectId: request.subjectId,
        error: errorMessage,
      });
      updated.status = 'failed';
      updated.failureReason = errorMessage;
    }

    return updated;
  }

  /** Check if a deletion request is within SLA */
  isWithinSLA(request: DeletionRequest): boolean {
    return new Date() < request.slaDeadline;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function subDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() - days);
  return result;
}
