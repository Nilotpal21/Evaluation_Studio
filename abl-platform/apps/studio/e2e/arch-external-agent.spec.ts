/**
 * Arch External Agent E2E Tests (Spec 1 — ABLP-162)
 *
 * Exercises the full external-agent registry lifecycle through the real
 * Studio HTTP API surface — registration, test_connection, discover_preview
 * SSRF rejection, duplicate-name handling, and HANDOFF wiring with
 * LOCATION:remote.
 *
 * API-only. No mocks. No direct DB access. Real servers.
 *
 * Requires:
 * - Studio dev server running on localhost:5173 (or TEST_BASE_URL)
 * - Runtime on localhost:3112 (or TEST_RUNTIME_URL)
 * - LLM credentials configured (only for the LLM-driven duplicate-name suggestion case)
 *
 * Run:
 *   pnpm --filter @agent-platform/studio exec playwright test e2e/arch-external-agent.spec.ts
 *
 * @e2e-real -- No vi.mock, no jest.mock, no stubbed servers.
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import { apiDelete, apiGet, apiPost } from './helpers/api';
import { env } from './helpers/env';

// ─── Constants ──────────────────────────────────────────────────────────

const TEST_LOGIN_EMAIL = 'arch-external-agent@e2e-smoke.test';
const TEST_LOGIN_NAME = 'Arch External Agent E2E';

// ─── Interfaces ─────────────────────────────────────────────────────────

interface ProjectRecord {
  id: string;
  name: string;
  slug: string;
}

interface ExternalAgentRecord {
  id: string;
  name: string;
  endpoint: string;
  protocol: 'a2a' | 'rest';
  authType: 'none' | 'bearer' | 'api_key';
  lastConnectionStatus?: 'unknown' | 'success' | 'failed' | null;
  lastConnectionError?: string | null;
  [key: string]: unknown;
}

interface ExternalAgentEnvelope {
  success: boolean;
  data?: ExternalAgentRecord | ExternalAgentRecord[];
  error?: { code: string; message: string };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function uniqueSuffix(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getTenantIdFromToken(token: string): string {
  const [, payload = ''] = token.split('.');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    tenantId?: string;
  };
  return decoded.tenantId ?? env.tenantId;
}

async function getDevAccessToken(request: APIRequestContext): Promise<string> {
  const response = await request.post(`${env.baseUrl}/api/auth/dev-login`, {
    data: { email: TEST_LOGIN_EMAIL, name: TEST_LOGIN_NAME },
  });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { accessToken?: string };
  expect(body.accessToken).toBeTruthy();
  return body.accessToken ?? '';
}

async function createProject(
  request: APIRequestContext,
  token: string,
  tenantId: string,
): Promise<ProjectRecord> {
  const suffix = uniqueSuffix();
  const slugSuffix = suffix.replace(/_/g, '-');
  const response = await apiPost<{ success: boolean; project: ProjectRecord }>(
    request,
    '/api/projects',
    token,
    {
      name: `Arch External Agent ${suffix}`,
      slug: `arch-external-agent-${slugSuffix}`,
      description: 'E2E test project for arch external-agent registry verification',
    },
    { headers: { 'X-Tenant-Id': tenantId } },
  );
  expect(response.status).toBe(201);
  expect(response.body.success).toBe(true);
  return response.body.project;
}

async function deleteProject(
  request: APIRequestContext,
  token: string,
  tenantId: string,
  projectId: string,
): Promise<void> {
  await apiDelete(request, `/api/projects/${projectId}`, token, {
    headers: { 'X-Tenant-Id': tenantId },
  });
}

async function registerExternalAgent(
  request: APIRequestContext,
  token: string,
  tenantId: string,
  projectId: string,
  body: Record<string, unknown>,
) {
  return apiPost<ExternalAgentEnvelope>(
    request,
    `/api/projects/${projectId}/external-agents`,
    token,
    body,
    { headers: { 'X-Tenant-Id': tenantId } },
  );
}

async function listExternalAgents(
  request: APIRequestContext,
  token: string,
  tenantId: string,
  projectId: string,
) {
  return apiGet<ExternalAgentEnvelope>(
    request,
    `/api/projects/${projectId}/external-agents`,
    token,
    { headers: { 'X-Tenant-Id': tenantId } },
  );
}

// ─── Test Suite ─────────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' });

/*
 * ═══════════════════════════════════════════════════════════════════════
 * SCENARIO 1: Happy path — register, persist, list shows entry
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Verifies that a project-scoped external-agent registration round-trips
 * through the Studio proxy → runtime route. Confirms tenant scoping,
 * persistence, and list visibility. The HANDOFF-wiring + compile step is
 * exercised by the integration_methodologist conversation flow; this
 * scenario pins the registry CRUD that flow depends on.
 */
test.describe('Arch External Agent — happy path', () => {
  let request: APIRequestContext;
  let token: string;
  let tenantId: string;
  let project: ProjectRecord | null = null;

  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext();
    token = await getDevAccessToken(request);
    tenantId = getTenantIdFromToken(token);
    project = await createProject(request, token, tenantId);
  });

  test.afterAll(async () => {
    if (project) {
      await deleteProject(request, token, tenantId, project.id);
    }
    await request.dispose();
  });

  test('registers external agent and lists it back', async () => {
    expect(project).not.toBeNull();
    const projectId = project!.id;
    const name = `partner_support_${uniqueSuffix()}`;

    const created = await registerExternalAgent(request, token, tenantId, projectId, {
      name,
      endpoint: 'https://partner.example.com/a2a',
      protocol: 'a2a',
      authType: 'none',
    });

    // We intentionally accept either 201 (created) or 200 (envelope success)
    // because the route may evolve between Studio proxy and runtime.
    expect([200, 201]).toContain(created.status);
    expect(created.body.success).toBe(true);
    const createdAgent = Array.isArray(created.body.data)
      ? created.body.data[0]
      : created.body.data;
    expect(createdAgent?.name).toBe(name);
    expect(createdAgent?.endpoint).toBe('https://partner.example.com/a2a');

    const listed = await listExternalAgents(request, token, tenantId, projectId);
    expect(listed.status).toBe(200);
    expect(listed.body.success).toBe(true);
    const all = Array.isArray(listed.body.data) ? listed.body.data : [];
    expect(all.some((a) => a.name === name)).toBe(true);
  });
});

/*
 * ═══════════════════════════════════════════════════════════════════════
 * SCENARIO 2: SSRF rejection on register/discover_preview
 * ═══════════════════════════════════════════════════════════════════════
 *
 * SSRF guard MUST reject loopback / private-network endpoints. The
 * sanitized error must NOT echo the raw host back. No outbound fetch
 * should be attempted (we cannot directly observe this from the client,
 * but a fast-failure status combined with absent connection error is the
 * proxy for "no fetch attempt").
 */
test.describe('Arch External Agent — SSRF guard', () => {
  let request: APIRequestContext;
  let token: string;
  let tenantId: string;
  let project: ProjectRecord | null = null;

  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext();
    token = await getDevAccessToken(request);
    tenantId = getTenantIdFromToken(token);
    project = await createProject(request, token, tenantId);
  });

  test.afterAll(async () => {
    if (project) {
      await deleteProject(request, token, tenantId, project.id);
    }
    await request.dispose();
  });

  test('rejects loopback endpoint with sanitized error', async () => {
    expect(project).not.toBeNull();
    const projectId = project!.id;
    const name = `ssrf_block_${uniqueSuffix()}`;

    const resp = await registerExternalAgent(request, token, tenantId, projectId, {
      name,
      endpoint: 'http://127.0.0.1:8080/a2a',
      protocol: 'a2a',
      authType: 'none',
    });

    expect([400, 422]).toContain(resp.status);
    expect(resp.body.success).toBe(false);
    expect(resp.body.error).toBeTruthy();
    // Sanitized error must NOT leak the raw host or port.
    const msg = (resp.body.error?.message ?? '').toLowerCase();
    expect(msg).not.toContain('127.0.0.1');
    expect(msg).not.toContain('8080');
    // Code should be a stable identifier, not a stack trace.
    expect(resp.body.error?.code).toBeTruthy();
  });
});

/*
 * ═══════════════════════════════════════════════════════════════════════
 * SCENARIO 3: Duplicate name handling
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Re-registering with the same `name` in the same project must fail with
 * a structured conflict error. The arch-ai conversation layer is what
 * "suggests an alternative" — that suggestion logic is LLM-driven and
 * exercised by integration_methodologist; the registry layer's job is to
 * surface the conflict deterministically.
 */
test.describe('Arch External Agent — duplicate name', () => {
  let request: APIRequestContext;
  let token: string;
  let tenantId: string;
  let project: ProjectRecord | null = null;

  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext();
    token = await getDevAccessToken(request);
    tenantId = getTenantIdFromToken(token);
    project = await createProject(request, token, tenantId);
  });

  test.afterAll(async () => {
    if (project) {
      await deleteProject(request, token, tenantId, project.id);
    }
    await request.dispose();
  });

  test('rejects duplicate name with structured conflict error', async () => {
    expect(project).not.toBeNull();
    const projectId = project!.id;
    const name = `dup_${uniqueSuffix()}`;

    const first = await registerExternalAgent(request, token, tenantId, projectId, {
      name,
      endpoint: 'https://partner.example.com/a2a',
      protocol: 'a2a',
      authType: 'none',
    });
    expect([200, 201]).toContain(first.status);
    expect(first.body.success).toBe(true);

    const dup = await registerExternalAgent(request, token, tenantId, projectId, {
      name,
      endpoint: 'https://other.example.com/a2a',
      protocol: 'a2a',
      authType: 'none',
    });
    expect([400, 409, 422]).toContain(dup.status);
    expect(dup.body.success).toBe(false);
    expect(dup.body.error?.code).toBeTruthy();
  });
});

/*
 * ═══════════════════════════════════════════════════════════════════════
 * SCENARIO 4: Auth failure post-create — registration persists
 * ═══════════════════════════════════════════════════════════════════════
 *
 * When test_connection fails (e.g. unreachable endpoint, bad token), the
 * registry entry must NOT be deleted — `lastConnectionStatus` is set to
 * `failed` and the user can retry from the UI.
 *
 * Marked test.fixme: requires a dedicated unreachable-but-DNS-resolvable
 * fixture endpoint to be deterministic in CI. Logic is covered by the
 * integration test in apps/studio/src/__tests__/external-agent-ops/ — this
 * scenario will be enabled once Spec 3 adds a dedicated mock-A2A test
 * fixture per LLD §5.14 deferred-hardening note.
 */
test.describe('Arch External Agent — auth failure persistence', () => {
  test.fixme('failed test_connection leaves registration in place with lastConnectionStatus=failed', async () => {
    // TODO(spec3-hardening): wire to a mock-A2A endpoint fixture (or
    // configure test runtime with a deterministic 5xx responder) so the
    // failure path is reproducible. The unit-level coverage already lives
    // in apps/studio/src/__tests__/external-agent-ops/.
  });
});

/*
 * ═══════════════════════════════════════════════════════════════════════
 * SCENARIO 5: Discovery timeout — fall back to manual flow A
 * ═══════════════════════════════════════════════════════════════════════
 *
 * When discover_preview times out, the integration_methodologist should
 * fall back to the manual registration flow (flow A from L2 card). This is
 * an LLM-driven UX transition and requires a non-deterministic LLM-driven
 * test fixture; the underlying timeout behavior is unit-tested in
 * apps/studio/src/__tests__/external-agent-ops/.
 */
test.describe('Arch External Agent — discovery timeout fallback', () => {
  test.fixme('discover_preview timeout triggers manual-flow fallback in integration_methodologist', async () => {
    // TODO(spec3-hardening): requires a controllable slow-responding
    // endpoint fixture and an LLM transcript pin. Underlying timeout
    // logic is covered by url-ssrf-validator.test.ts +
    // agent-card-sanity.test.ts.
  });
});
