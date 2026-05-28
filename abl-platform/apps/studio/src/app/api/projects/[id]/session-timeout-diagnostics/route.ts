import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { getConfig, isConfigLoaded } from '@/config';
import { getRuntimeUrl } from '@/config/runtime.server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectPermission, isProjectPermissionError } from '@/lib/project-permission';
import {
  BROWSER_IDLE_TIMEOUT_MS,
  BROWSER_IDLE_TIMEOUT_SECONDS,
  parseDurationToSeconds,
  type ResolvedTimeoutValue,
} from '@/lib/session-timeout-config';

const log = createLogger('studio:session-timeout-diagnostics');
const PROXY_TIMEOUT_MS = 15_000;
const DEFAULT_ACCESS_EXPIRY = '15m';
const ENV_FALLBACK_ACCESS_EXPIRY = '30m';

type RouteParams = { params: Promise<{ id: string }> };

interface EffectiveLifecyclePayload {
  success: boolean;
  data?: {
    runtime?: {
      idleSeconds?: ResolvedTimeoutValue;
      maxAgeSeconds?: ResolvedTimeoutValue;
    };
  };
  error?: {
    code?: string;
    message?: string;
  };
}

function resolveAccessExpiry(): string {
  if (isConfigLoaded()) {
    return getConfig().jwt.accessExpiry || DEFAULT_ACCESS_EXPIRY;
  }

  return process.env.JWT_ACCESS_EXPIRY || ENV_FALLBACK_ACCESS_EXPIRY;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectPermission(projectId, user, [
    'project:read',
    'project:update',
  ]);
  if (isProjectPermissionError(access)) return access;

  const runtimeSearchParams = new URLSearchParams({ channel: 'web_debug' });
  const agentName = request.nextUrl.searchParams.get('agentName')?.trim();
  if (agentName) {
    runtimeSearchParams.set('agentName', agentName);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Tenant-Id': user.tenantId,
    };
    const auth = request.headers.get('authorization');
    if (auth) {
      headers.Authorization = auth;
    }

    const response = await fetch(
      `${getRuntimeUrl()}/api/projects/${encodeURIComponent(projectId)}/session-lifecycle/effective?${runtimeSearchParams.toString()}`,
      {
        headers,
        signal: controller.signal,
        cache: 'no-store',
      },
    );

    const payload = (await response.json()) as EffectiveLifecyclePayload;
    if (!response.ok || !payload.success || !payload.data?.runtime) {
      return NextResponse.json(payload, {
        status: response.ok ? 502 : response.status,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const accessExpiry = resolveAccessExpiry();

    return NextResponse.json(
      {
        success: true,
        data: {
          browserIdle: {
            valueMs: BROWSER_IDLE_TIMEOUT_MS,
            valueSeconds: BROWSER_IDLE_TIMEOUT_SECONDS,
            source: 'studio_client_idle',
          },
          authToken: {
            accessExpiry,
            accessTtlSeconds: parseDurationToSeconds(accessExpiry),
            source: 'studio_jwt',
          },
          runtime: {
            idleSeconds: payload.data.runtime.idleSeconds ?? {},
            maxAgeSeconds: payload.data.runtime.maxAgeSeconds ?? {},
          },
        },
      },
      {
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    log.error(
      isTimeout
        ? 'Timed out resolving session timeout diagnostics'
        : 'Failed to resolve session timeout diagnostics',
      {
        projectId,
        agentName,
        error: error instanceof Error ? error.message : String(error),
      },
    );

    return NextResponse.json(
      {
        success: false,
        error: {
          code: isTimeout ? 'PROXY_TIMEOUT' : 'INTERNAL_ERROR',
          message: isTimeout
            ? 'Runtime did not respond while resolving session timeout diagnostics'
            : 'Failed to resolve session timeout diagnostics',
        },
      },
      {
        status: isTimeout ? 504 : 500,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  } finally {
    clearTimeout(timeout);
  }
}
