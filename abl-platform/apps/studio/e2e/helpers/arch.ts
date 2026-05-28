import type { APIRequestContext } from '@playwright/test';
import { env } from './env';

const ARCH_E2E_SMOKE_DOMAIN = '@e2e-smoke.test';
const ARCH_STUDIO_BASE_URL = process.env.STUDIO_URL ?? env.baseUrl;
const ARCH_RUNTIME_BASE_URL = process.env.RUNTIME_URL ?? env.runtimeUrl;

export interface ArchE2EPrerequisites {
  ok: boolean;
  reason: string;
}

interface DevLoginResponse {
  accessToken?: string;
}

interface ArchStatusResponse {
  success?: boolean;
  data?: {
    configured?: boolean;
    error?: string | null;
    model?: string | null;
    provider?: string | null;
  };
  error?: {
    message?: string;
  };
}

interface CreateSessionResponse {
  sessionId?: string;
  error?: {
    message?: string;
  };
}

function buildProbeIdentity(prefix: string): { email: string; name: string } {
  const safePrefix = prefix
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    email: `${safePrefix}-${nonce}${ARCH_E2E_SMOKE_DOMAIN}`,
    name: 'Arch E2E Probe',
  };
}

function buildAuthHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'X-Tenant-Id': env.tenantId,
  };
}

async function resolveProbeToken(
  request: APIRequestContext,
): Promise<{ token?: string; reason?: string }> {
  const identity = buildProbeIdentity('arch-e2e');
  const loginResponse = await request
    .post(`${ARCH_STUDIO_BASE_URL}/api/auth/dev-login`, {
      data: identity,
    })
    .catch(() => null);

  if (!loginResponse) {
    return {
      reason: `Arch E2E auth probe could not reach ${ARCH_STUDIO_BASE_URL}.`,
    };
  }

  if (!loginResponse.ok()) {
    return {
      reason: `Arch E2E auth probe failed with status ${loginResponse.status()}.`,
    };
  }

  const loginBody = (await loginResponse.json().catch(() => ({}))) as DevLoginResponse;
  if (!loginBody.accessToken) {
    return {
      reason: 'Arch E2E auth probe did not return an access token.',
    };
  }

  return { token: loginBody.accessToken };
}

export async function checkArchConversationPrerequisites(
  request: APIRequestContext,
): Promise<ArchE2EPrerequisites> {
  const auth = await resolveProbeToken(request);
  if (!auth.token) {
    return {
      ok: false,
      reason: auth.reason ?? 'Arch E2E auth probe failed.',
    };
  }

  const runtimeHealth = await request
    .get(`${ARCH_RUNTIME_BASE_URL}/health`, {
      timeout: 10_000,
    })
    .catch(() => null);

  if (!runtimeHealth?.ok()) {
    return {
      ok: false,
      reason: `Runtime is unavailable at ${ARCH_RUNTIME_BASE_URL}.`,
    };
  }

  const archStatusResponse = await request
    .get(`${ARCH_STUDIO_BASE_URL}/api/arch/status`, {
      headers: buildAuthHeaders(auth.token),
      timeout: 10_000,
    })
    .catch(() => null);

  if (!archStatusResponse?.ok()) {
    return {
      ok: false,
      reason: `Arch status probe failed with status ${archStatusResponse?.status() ?? 'no response'}.`,
    };
  }

  const archStatusBody = (await archStatusResponse.json().catch(() => ({}))) as ArchStatusResponse;
  const archStatus = archStatusBody.data;

  if (archStatusBody.success !== true || !archStatus) {
    return {
      ok: false,
      reason: archStatusBody.error?.message ?? 'Arch status probe returned an unexpected payload.',
    };
  }

  if (archStatus.configured !== true) {
    return {
      ok: false,
      reason: archStatus.error?.trim() || 'Arch does not have an active model configured.',
    };
  }

  if (archStatus.error) {
    return {
      ok: false,
      reason: `Arch model configuration is unhealthy: ${archStatus.error}`,
    };
  }

  const createSessionResponse = await request
    .post(`${ARCH_STUDIO_BASE_URL}/api/arch-ai/sessions`, {
      headers: {
        ...buildAuthHeaders(auth.token),
        'Content-Type': 'application/json',
      },
      data: { mode: 'ONBOARDING' },
      timeout: 10_000,
    })
    .catch(() => null);

  if (!createSessionResponse?.ok()) {
    return {
      ok: false,
      reason: `Arch session bootstrap failed with status ${createSessionResponse?.status() ?? 'no response'}.`,
    };
  }

  const createSessionBody = (await createSessionResponse
    .json()
    .catch(() => ({}))) as CreateSessionResponse;
  if (!createSessionBody.sessionId) {
    return {
      ok: false,
      reason:
        createSessionBody.error?.message ?? 'Arch session bootstrap did not return a session id.',
    };
  }

  const eventsResponse = await request
    .get(
      `${ARCH_STUDIO_BASE_URL}/api/arch-ai/sessions/${encodeURIComponent(
        createSessionBody.sessionId,
      )}/events?lastSeenSeq=-1`,
      {
        headers: buildAuthHeaders(auth.token),
        timeout: 10_000,
      },
    )
    .catch(() => null);

  if (!eventsResponse?.ok()) {
    return {
      ok: false,
      reason: `Arch session events probe failed with status ${eventsResponse?.status() ?? 'no response'}.`,
    };
  }

  const eventsBody = await eventsResponse.text().catch(() => '');
  if (eventsBody.includes('redis_unavailable')) {
    return {
      ok: false,
      reason: 'Arch Redis-backed session events are unavailable for E2E.',
    };
  }

  return {
    ok: true,
    reason: 'ready',
  };
}
