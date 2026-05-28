/**
 * GET/POST/PUT/DELETE /api/admin/kms — Proxy to runtime KMS API
 *
 * Forwards requests to /api/tenants/:tenantId/kms/* with auth headers
 * and tenant context.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError, requireAdminRole } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('studio-admin-kms-proxy');

interface RuntimeKeysEntry {
  projectId?: string;
  environment?: string;
  status?: 'active' | 'decrypt_only' | 'destroyed';
  expiresAt?: string | null;
  createdAt?: string | null;
}

interface RuntimeKeysPayload {
  success?: boolean;
  data?: {
    entries?: RuntimeKeysEntry[];
    total?: number;
    limit?: number;
    offset?: number;
    hasMore?: boolean;
    summary?: {
      total: number;
      activeCount: number;
      decryptOnlyCount: number;
      destroyedCount: number;
      expiringSoonCount: number;
      latestCreatedAt: string | null;
    };
    filters?: {
      statuses: Array<{ status: 'active' | 'decrypt_only' | 'destroyed'; count: number }>;
      projects: string[];
      environments: string[];
    };
  };
}

interface RuntimeAuditEntry {
  timestamp?: string;
  operation?: string;
  key_id?: string;
  actor_id?: string;
  success?: number | boolean;
  latency_ms?: number;
}

interface RuntimeAuditPayload {
  success?: boolean;
  data?: {
    entries?: RuntimeAuditEntry[];
    total?: number;
    limit?: number;
    offset?: number;
    hasMore?: boolean;
    summary?: {
      total: number;
      successCount: number;
      failureCount: number;
      uniqueKeys: number;
      uniqueActors: number;
      avgLatencyMs: number | null;
      lastEventAt: string | null;
    };
    operations?: Array<{ operation: string; count: number }>;
    message?: string;
  };
}

function buildHeaders(request: NextRequest, tenantId: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;
  headers['X-Tenant-Id'] = tenantId;
  return headers;
}

function buildUrl(tenantId: string, request: NextRequest): string {
  const endpoint = request.nextUrl.searchParams.get('endpoint') || '';
  const forwardParams = new URLSearchParams(request.nextUrl.searchParams);
  forwardParams.delete('endpoint');
  const qs = forwardParams.toString();
  const queryString = qs ? `?${qs}` : '';
  const path = endpoint
    ? `/${endpoint
        .split('/')
        .filter((segment) => segment.length > 0)
        .map((segment) => encodeURIComponent(segment))
        .join('/')}`
    : '';
  return `${getRuntimeUrl()}/api/tenants/${encodeURIComponent(tenantId)}/kms${path}${queryString}`;
}

async function fetchRuntimeJson(
  url: string,
  headers: Record<string, string>,
): Promise<{
  response: Response;
  data: RuntimeKeysPayload | RuntimeAuditPayload | Record<string, unknown> | null;
}> {
  const response = await fetch(url, { headers });
  const data = (await response.json().catch(() => null)) as
    | RuntimeKeysPayload
    | Record<string, unknown>
    | null;
  return { response, data };
}

function appendQuery(url: string, params: Record<string, string>): string {
  const next = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    next.searchParams.set(key, value);
  }
  return next.toString();
}

async function fetchKeysStatusCount(
  url: string,
  headers: Record<string, string>,
  status: 'active' | 'decrypt_only' | 'destroyed',
): Promise<number> {
  const targetUrl = appendQuery(url, {
    status,
    limit: '1',
    offset: '0',
  });
  const { response, data } = await fetchRuntimeJson(targetUrl, headers);
  if (!response.ok || !data || typeof data !== 'object') {
    throw new Error(`Failed to fetch ${status} key count`);
  }
  const payload = data as RuntimeKeysPayload;
  return payload.data?.total ?? 0;
}

async function countExpiringSoonActiveKeys(
  url: string,
  headers: Record<string, string>,
  activeCount: number,
): Promise<number> {
  if (activeCount <= 0) {
    return 0;
  }

  const now = Date.now();
  const expiringBoundary = now + 72 * 60 * 60 * 1000;
  const pageSize = 100;
  let offset = 0;
  let expiringSoonCount = 0;

  while (offset < activeCount) {
    const targetUrl = appendQuery(url, {
      status: 'active',
      limit: String(pageSize),
      offset: String(offset),
    });
    const { response, data } = await fetchRuntimeJson(targetUrl, headers);
    if (!response.ok || !data || typeof data !== 'object') {
      throw new Error('Failed to scan active keys for expiring-soon count');
    }

    const payload = data as RuntimeKeysPayload;
    const entries = payload.data?.entries ?? [];
    if (entries.length === 0) {
      break;
    }

    expiringSoonCount += entries.filter((entry) => {
      if (!entry.expiresAt) {
        return false;
      }
      const expiresAt = new Date(entry.expiresAt).getTime();
      return expiresAt >= now && expiresAt <= expiringBoundary;
    }).length;

    offset += entries.length;
  }

  return expiringSoonCount;
}

async function enrichLegacyKeysPayload(
  url: string,
  headers: Record<string, string>,
  payload: RuntimeKeysPayload,
): Promise<RuntimeKeysPayload> {
  const entries = payload.data?.entries ?? [];
  const total = payload.data?.total ?? entries.length;
  const limit = payload.data?.limit ?? entries.length;
  const offset = payload.data?.offset ?? 0;

  const [activeCount, decryptOnlyCount, destroyedCount] = await Promise.all([
    fetchKeysStatusCount(url, headers, 'active'),
    fetchKeysStatusCount(url, headers, 'decrypt_only'),
    fetchKeysStatusCount(url, headers, 'destroyed'),
  ]);
  const expiringSoonCount = await countExpiringSoonActiveKeys(url, headers, activeCount);

  const latestCreatedAt =
    entries.reduce<string | null>((latest, entry) => {
      if (!entry.createdAt) {
        return latest;
      }
      if (!latest) {
        return entry.createdAt;
      }
      return new Date(entry.createdAt).getTime() > new Date(latest).getTime()
        ? entry.createdAt
        : latest;
    }, null) ?? null;

  const projects = Array.from(
    new Set(
      entries.map((entry) => entry.projectId).filter((value): value is string => Boolean(value)),
    ),
  );
  const environments = Array.from(
    new Set(
      entries.map((entry) => entry.environment).filter((value): value is string => Boolean(value)),
    ),
  );

  return {
    ...payload,
    success: payload.success ?? true,
    data: {
      ...payload.data,
      entries,
      total,
      limit,
      offset,
      hasMore: offset + entries.length < total,
      summary: {
        total,
        activeCount,
        decryptOnlyCount,
        destroyedCount,
        expiringSoonCount,
        latestCreatedAt,
      },
      filters: {
        statuses: [
          { status: 'active', count: activeCount },
          { status: 'decrypt_only', count: decryptOnlyCount },
          { status: 'destroyed', count: destroyedCount },
        ],
        projects,
        environments,
      },
    },
  };
}

function parseAuditSuccess(value: number | boolean | undefined): boolean {
  return value === 1 || value === true;
}

function summarizeAuditEntries(entries: RuntimeAuditEntry[]): {
  total: number;
  successCount: number;
  failureCount: number;
  uniqueKeys: number;
  uniqueActors: number;
  avgLatencyMs: number | null;
  lastEventAt: string | null;
} {
  const successCount = entries.filter((entry) => parseAuditSuccess(entry.success)).length;
  const failureCount = entries.length - successCount;
  const uniqueKeys = new Set(
    entries.map((entry) => entry.key_id).filter((value): value is string => Boolean(value)),
  ).size;
  const uniqueActors = new Set(
    entries.map((entry) => entry.actor_id).filter((value): value is string => Boolean(value)),
  ).size;
  const latencyValues = entries
    .map((entry) => entry.latency_ms)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const avgLatencyMs =
    latencyValues.length > 0
      ? latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length
      : null;
  const lastEventAt = entries.reduce<string | null>((latest, entry) => {
    if (!entry.timestamp) {
      return latest;
    }
    if (!latest) {
      return entry.timestamp;
    }
    return new Date(entry.timestamp).getTime() > new Date(latest).getTime()
      ? entry.timestamp
      : latest;
  }, null);

  return {
    total: entries.length,
    successCount,
    failureCount,
    uniqueKeys,
    uniqueActors,
    avgLatencyMs,
    lastEventAt,
  };
}

function summarizeAuditOperations(
  entries: RuntimeAuditEntry[],
): Array<{ operation: string; count: number }> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.operation) {
      continue;
    }
    counts.set(entry.operation, (counts.get(entry.operation) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([operation, count]) => ({ operation, count }))
    .sort(
      (left, right) => right.count - left.count || left.operation.localeCompare(right.operation),
    );
}

async function fetchAllLegacyAuditEntries(
  url: string,
  headers: Record<string, string>,
): Promise<RuntimeAuditEntry[]> {
  const pageSize = 200;
  const entries: RuntimeAuditEntry[] = [];
  let offset = 0;

  for (let page = 0; page < 100; page += 1) {
    const targetUrl = appendQuery(url, {
      limit: String(pageSize),
      offset: String(offset),
    });
    const { response, data } = await fetchRuntimeJson(targetUrl, headers);
    if (!response.ok || !data || typeof data !== 'object') {
      throw new Error('Failed to fetch legacy audit entries');
    }

    const payload = data as RuntimeAuditPayload;
    const batch = payload.data?.entries ?? [];
    if (batch.length === 0) {
      break;
    }

    entries.push(...batch);
    offset += batch.length;

    if (batch.length < pageSize) {
      break;
    }
  }

  return entries;
}

async function enrichLegacyAuditPayload(
  url: string,
  headers: Record<string, string>,
  payload: RuntimeAuditPayload,
): Promise<RuntimeAuditPayload> {
  const currentEntries = payload.data?.entries ?? [];
  const limit = payload.data?.limit ?? currentEntries.length;
  const offset = payload.data?.offset ?? 0;
  const allEntries = await fetchAllLegacyAuditEntries(url, headers);
  const summary = summarizeAuditEntries(allEntries);
  const operations = summarizeAuditOperations(allEntries);

  return {
    ...payload,
    success: payload.success ?? true,
    data: {
      ...payload.data,
      entries: currentEntries,
      total: summary.total,
      limit,
      offset,
      hasMore: offset + currentEntries.length < summary.total,
      summary,
      operations,
    },
  };
}

export async function GET(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;
  const adminErr = await requireAdminRole(user.id, user.tenantId);
  if (adminErr) return adminErr;

  try {
    const url = buildUrl(user.tenantId, request);
    const headers = buildHeaders(request, user.tenantId);
    const { response, data } = await fetchRuntimeJson(url, headers);
    let responsePayload = data;

    const endpoint = request.nextUrl.searchParams.get('endpoint') || '';
    if (
      endpoint === 'keys' &&
      response.ok &&
      responsePayload &&
      typeof responsePayload === 'object' &&
      'data' in responsePayload &&
      !(responsePayload as RuntimeKeysPayload).data?.summary
    ) {
      try {
        responsePayload = await enrichLegacyKeysPayload(
          url,
          headers,
          responsePayload as RuntimeKeysPayload,
        );
        log.info('Enriched legacy KMS keys payload in Studio proxy', {
          tenantId: user.tenantId,
        });
      } catch (error) {
        log.warn('Failed to enrich legacy KMS keys payload in Studio proxy', {
          tenantId: user.tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (
      endpoint === 'audit' &&
      response.ok &&
      responsePayload &&
      typeof responsePayload === 'object' &&
      'data' in responsePayload &&
      !(responsePayload as RuntimeAuditPayload).data?.summary
    ) {
      try {
        responsePayload = await enrichLegacyAuditPayload(
          url,
          headers,
          responsePayload as RuntimeAuditPayload,
        );
        log.info('Enriched legacy KMS audit payload in Studio proxy', {
          tenantId: user.tenantId,
        });
      } catch (error) {
        log.warn('Failed to enrich legacy KMS audit payload in Studio proxy', {
          tenantId: user.tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!response.ok) {
      log.warn('KMS proxy GET received non-OK response from runtime', {
        tenantId: user.tenantId,
        endpoint,
        status: response.status,
      });
    }
    return NextResponse.json(responsePayload, { status: response.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('KMS proxy GET failed', {
      tenantId: user.tenantId,
      endpoint: request.nextUrl.searchParams.get('endpoint') || '',
      error: message,
    });
    return NextResponse.json(
      { success: false, error: `KMS proxy GET failed: ${message}` },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;
  const adminErr = await requireAdminRole(user.id, user.tenantId);
  if (adminErr) return adminErr;

  try {
    const body = await request.json();
    const url = buildUrl(user.tenantId, request);
    const response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(request, user.tenantId),
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      log.warn('KMS proxy POST received non-OK response from runtime', {
        tenantId: user.tenantId,
        endpoint: request.nextUrl.searchParams.get('endpoint') || '',
        status: response.status,
      });
    }
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('KMS proxy POST failed', {
      tenantId: user.tenantId,
      endpoint: request.nextUrl.searchParams.get('endpoint') || '',
      error: message,
    });
    return NextResponse.json(
      { success: false, error: `KMS proxy POST failed: ${message}` },
      { status: 502 },
    );
  }
}

export async function PUT(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;
  const adminErr = await requireAdminRole(user.id, user.tenantId);
  if (adminErr) return adminErr;

  try {
    const body = await request.json();
    const url = buildUrl(user.tenantId, request);
    const response = await fetch(url, {
      method: 'PUT',
      headers: buildHeaders(request, user.tenantId),
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      log.warn('KMS proxy PUT received non-OK response from runtime', {
        tenantId: user.tenantId,
        endpoint: request.nextUrl.searchParams.get('endpoint') || '',
        status: response.status,
      });
    }
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('KMS proxy PUT failed', {
      tenantId: user.tenantId,
      endpoint: request.nextUrl.searchParams.get('endpoint') || '',
      error: message,
    });
    return NextResponse.json(
      { success: false, error: `KMS proxy PUT failed: ${message}` },
      { status: 502 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;
  const adminErr = await requireAdminRole(user.id, user.tenantId);
  if (adminErr) return adminErr;

  try {
    const url = buildUrl(user.tenantId, request);
    const response = await fetch(url, {
      method: 'DELETE',
      headers: buildHeaders(request, user.tenantId),
    });
    const data = await response.json();
    if (!response.ok) {
      log.warn('KMS proxy DELETE received non-OK response from runtime', {
        tenantId: user.tenantId,
        endpoint: request.nextUrl.searchParams.get('endpoint') || '',
        status: response.status,
      });
    }
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('KMS proxy DELETE failed', {
      tenantId: user.tenantId,
      endpoint: request.nextUrl.searchParams.get('endpoint') || '',
      error: message,
    });
    return NextResponse.json(
      { success: false, error: `KMS proxy DELETE failed: ${message}` },
      { status: 502 },
    );
  }
}
