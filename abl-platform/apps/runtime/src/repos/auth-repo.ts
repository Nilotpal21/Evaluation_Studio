/**
 * Auth Repository
 *
 * MongoDB user, tenant membership, API key, and shared audit helpers.
 * Used by: middleware/auth.ts, services/audit-helpers.ts, services/permission-resolution.ts
 */

import { randomUUID } from 'node:crypto';
import { TTLCache } from '../utils/ttl-cache.js';
import { createLogger, type AuditActorType } from '@abl/compiler/platform';
import {
  deriveRetentionClass,
  deriveSharedAuditSource,
  type SharedAuditRetentionClass,
  type SharedAuditSource,
} from '@abl/compiler/platform/stores/shared-audit-codec.js';
import type { AuditEvent } from '@abl/compiler/platform/stores/audit-pipeline.js';
import { expandScopesToPermissions } from '@agent-platform/shared-auth';
import { getRuntimeAuditEnvironment } from '../services/audit-environment.js';
import { writeAuditEvent as writeSharedAuditEvent } from '../services/audit-store-singleton.js';

const log = createLogger('auth-repo');

// ─── Types ────────────────────────────────────────────────────────────────

export interface AuthUserRecord {
  id: string;
  email: string;
  name: string | null;
}

export interface TenantMembershipRecord {
  role: string;
  customRoleId: string | null;
  orgId?: string;
}

export interface ApiKeyRecord {
  tenantId: string;
  apiKeyId: string;
  clientId: string;
  createdBy: string;
  scopes: string[];
  projectIds: string[];
  environments: string[];
}

export interface AuthAuditBufferConfig {
  mode: 'shared-audit-store';
}

export interface AuthAuditBufferStats {
  enqueuedWrites: number;
  failedWrites: number;
  pendingWrites: number;
  shutdownRequested: boolean;
  config: AuthAuditBufferConfig;
}

const AUTH_AUDIT_BUFFER_CONFIG: AuthAuditBufferConfig = {
  mode: 'shared-audit-store',
};
const HOT_PATH_CACHE_TTL_MS = 5_000;
const USER_CACHE_MAX_ENTRIES = 2_000;
const TENANT_MEMBERSHIP_CACHE_MAX_ENTRIES = 5_000;
const DEFAULT_TENANT_CACHE_MAX_ENTRIES = 2_000;
const TENANT_ORG_CACHE_MAX_ENTRIES = 1_000;
const MAX_PENDING_AUDIT_WRITES = 1_000;
const HOT_PATH_CACHE_ENABLED = process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true';

let auditLogShutdownRequested = false;
let pendingAuditWrites = new Set<Promise<void>>();
let auditLogBufferStats = {
  enqueuedWrites: 0,
  failedWrites: 0,
};

export function getAuthAuditBufferConfig(): AuthAuditBufferConfig {
  return AUTH_AUDIT_BUFFER_CONFIG;
}

export function getAuthAuditBufferStats(): AuthAuditBufferStats {
  return {
    ...auditLogBufferStats,
    pendingWrites: pendingAuditWrites.size,
    shutdownRequested: auditLogShutdownRequested,
    config: getAuthAuditBufferConfig(),
  };
}

// Hot auth-path reads happen on every authenticated request. A short pod-local TTL
// avoids repeated Mongo round-trips while still converging quickly after role changes.
const userByIdCache = new TTLCache<AuthUserRecord | null>({
  maxSize: USER_CACHE_MAX_ENTRIES,
  ttlMs: HOT_PATH_CACHE_TTL_MS,
});

const tenantMembershipCache = new TTLCache<TenantMembershipRecord | null>({
  maxSize: TENANT_MEMBERSHIP_CACHE_MAX_ENTRIES,
  ttlMs: HOT_PATH_CACHE_TTL_MS,
});

const defaultTenantCache = new TTLCache<(TenantMembershipRecord & { tenantId: string }) | null>({
  maxSize: DEFAULT_TENANT_CACHE_MAX_ENTRIES,
  ttlMs: HOT_PATH_CACHE_TTL_MS,
});

const tenantOrgCache = new TTLCache<string | null>({
  maxSize: TENANT_ORG_CACHE_MAX_ENTRIES,
  ttlMs: HOT_PATH_CACHE_TTL_MS,
});

function getCachedValue<T>(cache: TTLCache<T>, key: string): T | undefined {
  if (!HOT_PATH_CACHE_ENABLED) {
    return undefined;
  }

  return cache.get(key);
}

function setCachedValue<T>(cache: TTLCache<T>, key: string, value: T): void {
  if (!HOT_PATH_CACHE_ENABLED) {
    return;
  }

  cache.set(key, value);
}

async function findTenantOrgId(tenantId: string): Promise<string | undefined> {
  const cachedOrgId = getCachedValue(tenantOrgCache, tenantId);
  if (cachedOrgId !== undefined) {
    return cachedOrgId ?? undefined;
  }

  const { Tenant } = await import('@agent-platform/database/models');
  const tenant = await Tenant.findOne({ _id: tenantId }, { organizationId: 1 }).lean();
  const organizationId =
    tenant && typeof tenant === 'object' && 'organizationId' in tenant
      ? ((tenant.organizationId as string | null | undefined) ?? null)
      : null;
  setCachedValue(tenantOrgCache, tenantId, organizationId);
  return organizationId ?? undefined;
}

async function flushAuditLogs(): Promise<void> {
  if (pendingAuditWrites.size === 0) {
    return;
  }

  await Promise.allSettled([...pendingAuditWrites]);
}

/** Flush pending audit logs — call during graceful shutdown. */
export async function shutdownAuditLogs(): Promise<void> {
  auditLogShutdownRequested = true;
  await flushAuditLogs();
}

export function _resetAuthAuditBufferStateForTests(): void {
  userByIdCache.clear();
  tenantMembershipCache.clear();
  defaultTenantCache.clear();
  tenantOrgCache.clear();
  pendingAuditWrites = new Set<Promise<void>>();
  auditLogShutdownRequested = false;
  auditLogBufferStats = {
    enqueuedWrites: 0,
    failedWrites: 0,
  };
}

// ─── User ─────────────────────────────────────────────────────────────────

export async function findUserById(id: string): Promise<AuthUserRecord | null> {
  const cached = getCachedValue(userByIdCache, id);
  if (cached !== undefined) {
    return cached;
  }

  const { User } = await import('@agent-platform/database/models');
  const doc = await User.findOne({ _id: id }, { email: 1, name: 1 }).lean();
  const result = doc ? { id: doc._id as string, email: doc.email, name: doc.name } : null;
  setCachedValue(userByIdCache, id, result);
  return result;
}

export async function findUserByEmail(email: string): Promise<AuthUserRecord | null> {
  const { User } = await import('@agent-platform/database/models');
  const doc = await User.findOne({ email }).lean();
  return doc ? { id: doc._id as string, email: doc.email, name: doc.name } : null;
}

export async function createUser(data: {
  email: string;
  name: string;
  googleId?: string;
  authProvider?: string;
}): Promise<AuthUserRecord> {
  const { User } = await import('@agent-platform/database/models');
  const doc = await User.create({
    ...data,
    authProvider: data.authProvider || 'google',
  });
  return { id: doc._id as string, email: doc.email, name: doc.name };
}

// ─── Tenant Membership ────────────────────────────────────────────────────

export async function resolveTenantMembership(
  userId: string,
  tenantId: string,
): Promise<TenantMembershipRecord | null> {
  const cacheKey = `${tenantId}:${userId}`;
  const cached = getCachedValue(tenantMembershipCache, cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const { TenantMember } = await import('@agent-platform/database/models');
  const membershipPromise = TenantMember.findOne({ tenantId, userId }).lean();
  const orgIdPromise = findTenantOrgId(tenantId);
  const m = await membershipPromise;
  if (!m) {
    setCachedValue(tenantMembershipCache, cacheKey, null);
    return null;
  }

  const result = {
    role: m.role,
    customRoleId: m.customRoleId,
    orgId: await orgIdPromise,
  };
  setCachedValue(tenantMembershipCache, cacheKey, result);
  return result;
}

export async function resolveDefaultTenant(
  userId: string,
): Promise<(TenantMembershipRecord & { tenantId: string }) | null> {
  const cached = getCachedValue(defaultTenantCache, userId);
  if (cached !== undefined) {
    return cached;
  }

  const { TenantMember } = await import('@agent-platform/database/models');
  const m = await TenantMember.findOne({ userId }).sort({ createdAt: 1 }).lean();
  if (!m) {
    setCachedValue(defaultTenantCache, userId, null);
    return null;
  }

  const result = {
    tenantId: m.tenantId,
    role: m.role,
    customRoleId: m.customRoleId,
    orgId: await findTenantOrgId(m.tenantId),
  };
  setCachedValue(defaultTenantCache, userId, result);
  return result;
}

// ─── API Keys ─────────────────────────────────────────────────────────────

export async function resolveApiKey(keyHash: string, prefix: string): Promise<ApiKeyRecord | null> {
  if (prefix.startsWith('pk_')) {
    return null;
  }

  const { ApiKey } = await import('@agent-platform/database/models');

  // 1. Try the ApiKey collection first (admin-created keys)
  const apiKey = await ApiKey.findOne({ keyHash }).lean();
  if (apiKey) {
    if (apiKey.prefix !== prefix) return null;
    if (apiKey.revokedAt) return null;
    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null;
    return {
      tenantId: apiKey.tenantId,
      apiKeyId: apiKey._id as string,
      clientId: apiKey.clientId,
      createdBy: apiKey.createdBy,
      scopes: expandScopesToPermissions(apiKey.scopes ?? []),
      projectIds: apiKey.projectIds,
      environments: apiKey.environments,
    };
  }

  return null;
}

// ─── Audit ────────────────────────────────────────────────────────────────

function asEnvironment(value: unknown) {
  return value === 'dev' || value === 'staging' || value === 'production' ? value : null;
}

function createSharedAuditEvent(data: {
  action: string;
  userId?: string | null;
  tenantId?: string | null;
  metadata?: Record<string, unknown>;
  eventType?: string | null;
  source?: SharedAuditSource;
  retentionClass?: SharedAuditRetentionClass | null;
}): AuditEvent {
  const metadata = data.metadata ?? null;
  const eventType =
    data.eventType ??
    (typeof metadata?.eventType === 'string' ? metadata.eventType : null) ??
    data.action;
  const source = deriveSharedAuditSource({
    explicitSource: data.source ?? null,
    eventType,
    action: data.action,
  });
  const actorType: AuditActorType =
    source === 'admin' && data.userId ? 'admin' : data.userId ? 'user' : 'system';

  return {
    auditId: randomUUID(),
    stream: 'shared',
    schemaVersion: 2,
    source,
    eventType,
    action: data.action,
    actorId: data.userId ?? null,
    actorType,
    tenantId: data.tenantId ?? null,
    projectId: typeof metadata?.projectId === 'string' ? metadata.projectId : null,
    resourceType: typeof metadata?.resourceType === 'string' ? metadata.resourceType : null,
    resourceId: typeof metadata?.resourceId === 'string' ? metadata.resourceId : null,
    environment: asEnvironment(metadata?.environment) ?? getRuntimeAuditEnvironment(),
    traceId: typeof metadata?.traceId === 'string' ? metadata.traceId : null,
    ipAddress: null,
    userAgent: null,
    metadata,
    metadataEncoding: 'object',
    retentionClass: deriveRetentionClass({
      source,
      eventType,
      action: data.action,
      explicitRetentionClass: data.retentionClass ?? null,
    }),
    expiresAt: null,
    timestamp: new Date(),
    oldValue: null,
    newValue: null,
  };
}

function trackAuditWrite(writePromise: Promise<void>): void {
  if (pendingAuditWrites.size >= MAX_PENDING_AUDIT_WRITES) {
    log.warn('Auth audit pending write set reached soft limit; forcing background flush', {
      pendingWrites: pendingAuditWrites.size,
      maxPendingWrites: MAX_PENDING_AUDIT_WRITES,
    });
    void flushAuditLogs().catch((err: unknown) => {
      log.error('Forced auth audit flush failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  pendingAuditWrites.add(writePromise);
  void writePromise.finally(() => {
    pendingAuditWrites.delete(writePromise);
  });
}

export function writeAuditLog(data: {
  action: string;
  userId?: string | null;
  tenantId?: string | null;
  metadata?: Record<string, unknown>;
  eventType?: string | null;
  source?: SharedAuditSource;
  retentionClass?: SharedAuditRetentionClass | null;
}): void {
  if (auditLogShutdownRequested) {
    return;
  }

  auditLogBufferStats.enqueuedWrites += 1;
  const writePromise = writeSharedAuditEvent(createSharedAuditEvent(data)).catch((err: unknown) => {
    auditLogBufferStats.failedWrites += 1;
    log.warn('Auth audit write failed', {
      action: data.action,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  trackAuditWrite(writePromise);
}
