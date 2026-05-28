import { randomUUID } from 'node:crypto';
import type {
  AuditActorType,
  AuditEventType,
  AuditLog,
  AuditMetadataEncoding,
  AuditResourceType,
  AuditRetentionClass,
  AuditSource,
  Environment,
} from '../core/types.js';
import type { QueryAuditParams } from './audit-store.js';

const GLOBAL_STATE_KEY = '__abl_shared_audit_test_backend__' as const;
const MAX_IN_MEMORY_AUDIT_TEST_LOGS = 10_000;

interface SharedAuditTestBackendState {
  logs: AuditLog[];
  writeFailureMessage: string | null;
}

function getGlobalState(): SharedAuditTestBackendState {
  const globalState = globalThis as Record<string, unknown>;
  const existing = globalState[GLOBAL_STATE_KEY];

  if (existing && typeof existing === 'object') {
    return existing as SharedAuditTestBackendState;
  }

  const initialState: SharedAuditTestBackendState = {
    logs: [],
    writeFailureMessage: null,
  };
  globalState[GLOBAL_STATE_KEY] = initialState;
  return initialState;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asDate(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }

  if (typeof value === 'string' && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }

  return undefined;
}

function asEnvironment(value: unknown): Environment | undefined {
  return value === 'dev' || value === 'staging' || value === 'production' ? value : undefined;
}

function asSource(value: unknown): AuditSource | undefined {
  return value === 'runtime-store' ||
    value === 'runtime-auth' ||
    value === 'studio' ||
    value === 'admin' ||
    value === 'search-ai' ||
    value === 'mongoose-plugin'
    ? value
    : undefined;
}

function asMetadataEncoding(value: unknown): AuditMetadataEncoding | undefined {
  return value === 'object' || value === 'json-string' ? value : undefined;
}

function asRetentionClass(value: unknown): AuditRetentionClass | undefined {
  return value === 'default' || value === 'auth' || value === 'crud' || value === 'indefinite'
    ? value
    : undefined;
}

function toAuditLog(event: Record<string, unknown>): AuditLog {
  const timestamp = asDate(event.timestamp) ?? new Date();
  const action = asString(event.action) ?? asString(event.eventType) ?? 'audit.event';
  const metadata = asRecord(event.metadata) ?? {};

  return {
    id: asString(event.auditId) ?? randomUUID(),
    tenantId: asString(event.tenantId) ?? 'unscoped',
    projectId: asString(event.projectId),
    timestamp,
    eventType: (asString(event.eventType) ?? action) as AuditEventType,
    actor: asString(event.actorId) ?? 'system',
    actorType: ((asString(event.actorType) ?? 'unknown') as AuditActorType) ?? 'unknown',
    resourceType: ((asString(event.resourceType) ?? 'agent') as AuditResourceType) ?? 'agent',
    resourceId: asString(event.resourceId) ?? '',
    environment: asEnvironment(event.environment) ?? 'dev',
    action,
    oldValue: asRecord(event.oldValue),
    newValue: asRecord(event.newValue),
    metadata,
    ipAddress: asString(event.ipAddress),
    traceId: asString(event.traceId),
    schemaVersion: typeof event.schemaVersion === 'number' ? event.schemaVersion : 2,
    source: asSource(event.source),
    metadataEncoding: asMetadataEncoding(event.metadataEncoding) ?? 'object',
    retentionClass: asRetentionClass(event.retentionClass) ?? 'default',
    expiresAt: event.expiresAt === null ? null : (asDate(event.expiresAt) ?? null),
  };
}

export function isInMemoryAuditTestBackendEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.AUDIT_PIPELINE_TEST_BACKEND === 'memory';
}

export function appendInMemoryAuditTestEvent(event: Record<string, unknown>): void {
  const state = getGlobalState();
  if (state.writeFailureMessage) {
    throw new Error(state.writeFailureMessage);
  }

  state.logs.push(toAuditLog(event));
  if (state.logs.length > MAX_IN_MEMORY_AUDIT_TEST_LOGS) {
    state.logs.splice(0, state.logs.length - MAX_IN_MEMORY_AUDIT_TEST_LOGS);
  }
}

export async function queryInMemoryAuditTestLogs(
  params: QueryAuditParams,
): Promise<{ logs: AuditLog[]; total: number }> {
  const filtered = getGlobalState()
    .logs.filter((log) => {
      if (params.tenantId && log.tenantId !== params.tenantId) {
        return false;
      }
      if (params.projectId && log.projectId !== params.projectId) {
        return false;
      }
      if (
        params.eventTypes &&
        params.eventTypes.length > 0 &&
        !params.eventTypes.includes(log.eventType)
      ) {
        return false;
      }
      if (params.actions && params.actions.length > 0 && !params.actions.includes(log.action)) {
        return false;
      }
      if (params.actor && log.actor !== params.actor) {
        return false;
      }
      if (params.actorType && log.actorType !== params.actorType) {
        return false;
      }
      if (params.resourceType && log.resourceType !== params.resourceType) {
        return false;
      }
      if (params.resourceId && log.resourceId !== params.resourceId) {
        return false;
      }
      if (params.environment && log.environment !== params.environment) {
        return false;
      }

      const timestamp = log.timestamp.getTime();
      if (timestamp < params.startTime.getTime() || timestamp > params.endTime.getTime()) {
        return false;
      }

      return true;
    })
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  const offset = params.offset ?? 0;
  const limit = params.limit ?? 100;

  return {
    logs: filtered.slice(offset, offset + limit),
    total: filtered.length,
  };
}

export function deleteInMemoryAuditTestLogs(params: {
  tenantId?: string;
  resourceType?: string;
  resourceId?: string;
  actor?: string;
  actions?: string[];
  eventTypes?: AuditEventType[];
}): number {
  const state = getGlobalState();
  const initialCount = state.logs.length;

  state.logs = state.logs.filter((log) => {
    if (params.tenantId && log.tenantId !== params.tenantId) {
      return true;
    }
    if (params.resourceType && log.resourceType !== params.resourceType) {
      return true;
    }
    if (params.resourceId && log.resourceId !== params.resourceId) {
      return true;
    }
    if (params.actor && log.actor !== params.actor) {
      return true;
    }
    if (params.actions && params.actions.length > 0 && !params.actions.includes(log.action)) {
      return true;
    }
    if (
      params.eventTypes &&
      params.eventTypes.length > 0 &&
      !params.eventTypes.includes(log.eventType)
    ) {
      return true;
    }

    return false;
  });

  return initialCount - state.logs.length;
}

export function setInMemoryAuditTestWriteFailure(message: string | null): void {
  getGlobalState().writeFailureMessage = message;
}

export function resetInMemoryAuditTestBackend(): void {
  const state = getGlobalState();
  state.logs = [];
  state.writeFailureMessage = null;
}
