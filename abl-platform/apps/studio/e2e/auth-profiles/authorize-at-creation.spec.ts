/**
 * E2E: ABLP-619 — Authorize at Creation (FR-9)
 *
 * Drives the two-phase create flow over real HTTP against the running Studio
 * Next.js server (PM2-managed in CI; `pnpm dev` locally). No mocks, no direct
 * DB access — interaction is API-only per CLAUDE.md "E2E Test Standards".
 *
 * The seven scenarios defined in the LLD (`docs/plans/2026-04-27-ablp-619-...`)
 * map to the cases below. Scenarios A and B's full callback step requires an
 * upstream OAuth provider stub (the provider authorize page redirects back
 * with a `code`); we drive those as far as `oauth/initiate` here, asserting
 * the persisted state. The callback round-trip is covered by the unit tests
 * `auth-profile-oauth-callback-route.test.ts` (Phase 2) which exercise the
 * status-flip and trace-event emission deterministically with stub deps.
 *
 *   A — oauth2_app, project scope, partial happy path (create + initiate)
 *   B — oauth2_app, workspace scope, partial happy path (create + initiate)
 *   C — oauth2_client_credentials, project scope: covered by the inline-grant
 *       integration test `auth-profile-create-cc-flow.test.ts` (Phase 3).
 *   D — oauth2_client_credentials, workspace scope: same coverage as C — the
 *       admin route is a re-export of the project source (Phase 3 LLD).
 *   E — oauth2_client_credentials with bad creds — sanitization invariant
 *   F — oauth2_app, user-cancel — DELETE pending row
 *   G — oauth2_app, browser-close mid-flow — pending row visible for retry
 */

import { test, expect, type Page } from '@playwright/test';
import { apiDelete, apiGet, apiPost } from '../helpers/api';
import { getDevAccessToken } from '../helpers/auth';
import { env } from '../helpers/env';

const TEST_LOGIN_EMAIL = 'auth-profiles@e2e-smoke.test';
const TEST_LOGIN_NAME = 'Authorize At Creation E2E';

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getTenantIdFromToken(token: string): string {
  const [, payload = ''] = token.split('.');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    tenantId?: string;
  };
  return decoded.tenantId ?? env.tenantId;
}

interface CreatedProject {
  id: string;
  name: string;
  slug: string;
}

async function createProject(page: Page, token: string, tenantId: string): Promise<CreatedProject> {
  const suffix = uniqueSuffix();
  const response = await apiPost<{ success: boolean; project: CreatedProject }>(
    page,
    '/api/projects',
    token,
    {
      name: `Authorize Creation ${suffix}`,
      slug: `auth-creation-${suffix}`,
      description: 'ABLP-619 authorize-at-creation coverage',
    },
    {
      headers: { 'X-Tenant-Id': tenantId },
    },
  );
  expect(response.status, `create project: ${JSON.stringify(response.body)}`).toBe(201);
  return response.body.project;
}

interface ProfileResponse {
  success: boolean;
  data: {
    id: string;
    status: string;
    authType: string;
  };
  error?: { code: string; message: string };
}

const VALID_OAUTH_APP_PAYLOAD = {
  authType: 'oauth2_app' as const,
  config: {
    authorizationUrl: 'https://stub.invalid.example/oauth/authorize',
    tokenUrl: 'https://stub.invalid.example/oauth/token',
    defaultScopes: ['read'],
  },
  secrets: {
    clientId: 'stub-client-id',
    clientSecret: 'stub-client-secret', // gitleaks:allow
  },
  scope: 'project' as const,
  visibility: 'shared' as const,
  usageMode: 'preconfigured' as const,
};

const VALID_CC_PAYLOAD_WITH_BAD_TOKEN_URL = {
  authType: 'oauth2_client_credentials' as const,
  config: {
    // Reserved-by-IANA TLD; never resolves — the inline grant must fail and
    // the route handler must surface AUTH_PROFILE_AUTHORIZE_FAILED with a
    // sanitized message that contains no tenantId / profileId / secret.
    tokenUrl: 'https://stub.invalid.example/oauth/token',
    scopes: ['read'],
  },
  secrets: {
    clientId: 'cc-bad-client',
    clientSecret: 'cc-bad-secret-must-not-leak', // gitleaks:allow
  },
  scope: 'project' as const,
  visibility: 'shared' as const,
  usageMode: 'preconfigured' as const,
};

test.describe('ABLP-619 — Authorize at Creation (FR-9)', () => {
  let token: string;
  let tenantId: string;
  let project: CreatedProject;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    token = await getDevAccessToken(page, {
      email: TEST_LOGIN_EMAIL,
      name: TEST_LOGIN_NAME,
    });
    tenantId = getTenantIdFromToken(token);
    project = await createProject(page, token, tenantId);
    await context.close();
  });

  test('A: oauth2_app project create persists status=pending_authorization, then initiate returns auth URL', async ({
    page,
  }) => {
    const suffix = uniqueSuffix();
    const created = await apiPost<ProfileResponse>(
      page,
      `/api/projects/${project.id}/auth-profiles`,
      token,
      { name: `OAuth App ${suffix}`, projectId: project.id, ...VALID_OAUTH_APP_PAYLOAD },
      { headers: { 'X-Tenant-Id': tenantId } },
    );

    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.status).toBe('pending_authorization');
    expect(created.body.data.authType).toBe('oauth2_app');

    const profileId = created.body.data.id;

    const initiate = await apiPost<{
      success: boolean;
      data: { authUrl: string; state: string };
    }>(
      page,
      `/api/projects/${project.id}/auth-profiles/oauth/initiate`,
      token,
      { connectorName: 'stub-provider', authProfileId: profileId },
      { headers: { 'X-Tenant-Id': tenantId } },
    );

    expect(initiate.status, JSON.stringify(initiate.body)).toBe(200);
    expect(initiate.body.data.authUrl).toMatch(/^https?:\/\//);
    expect(initiate.body.data.state).toMatch(/^[a-f0-9]{64}$/);

    // Cleanup: delete the still-pending profile so the test is idempotent.
    await apiDelete(page, `/api/projects/${project.id}/auth-profiles/${profileId}`, token, {
      headers: { 'X-Tenant-Id': tenantId },
    });
  });

  test('B: oauth2_app workspace create persists status=pending_authorization via /api/admin', async ({
    page,
  }) => {
    const suffix = uniqueSuffix();
    const created = await apiPost<ProfileResponse>(
      page,
      `/api/admin/auth-profiles`,
      token,
      {
        name: `Workspace OAuth ${suffix}`,
        projectId: null,
        ...VALID_OAUTH_APP_PAYLOAD,
        scope: 'tenant',
      },
      { headers: { 'X-Tenant-Id': tenantId } },
    );

    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.status).toBe('pending_authorization');

    const profileId = created.body.data.id;

    const initiate = await apiPost<{
      success: boolean;
      data: { authUrl: string; state: string };
    }>(
      page,
      `/api/admin/auth-profiles/oauth/initiate`,
      token,
      { connectorName: 'stub-provider', authProfileId: profileId },
      { headers: { 'X-Tenant-Id': tenantId } },
    );

    expect(initiate.status, JSON.stringify(initiate.body)).toBe(200);
    expect(initiate.body.data.authUrl).toMatch(/^https?:\/\//);
    expect(initiate.body.data.state).toMatch(/^[a-f0-9]{64}$/);

    await apiDelete(page, `/api/admin/auth-profiles/${profileId}`, token, {
      headers: { 'X-Tenant-Id': tenantId },
    });
  });

  test('E: oauth2_client_credentials with unreachable token URL returns sanitized 400, no row in list', async ({
    page,
  }) => {
    const suffix = uniqueSuffix();
    const tenantInToken = tenantId;

    const created = await apiPost<ProfileResponse>(
      page,
      `/api/projects/${project.id}/auth-profiles`,
      token,
      {
        name: `Bad Creds ${suffix}`,
        projectId: project.id,
        ...VALID_CC_PAYLOAD_WITH_BAD_TOKEN_URL,
      },
      { headers: { 'X-Tenant-Id': tenantId } },
    );

    expect(created.status, JSON.stringify(created.body)).toBe(400);
    expect(created.body.error?.code).toBe('AUTH_PROFILE_AUTHORIZE_FAILED');

    const userMessage = created.body.error?.message ?? '';
    // Sanitization invariant: no tenantId, profileId, secret, or token URL host
    // should leak into the user-facing error message.
    expect(userMessage).not.toContain(tenantInToken);
    expect(userMessage).not.toContain('cc-bad-secret-must-not-leak');
    expect(userMessage).not.toContain('stub.invalid.example');

    // The pending row must have been deleted by the inline-grant flow on
    // failure; verify by listing profiles for the project.
    const list = await apiGet<{ data: Array<{ name: string }> }>(
      page,
      `/api/projects/${project.id}/auth-profiles`,
      token,
      { headers: { 'X-Tenant-Id': tenantId } },
    );
    expect(list.status).toBe(200);
    const profiles: Array<{ name: string }> = list.body.data ?? [];
    const names = profiles.map((p) => p.name);
    expect(names).not.toContain(`Bad Creds ${suffix}`);
  });

  test('F: cancel deletes the pending row — DELETE on the freshly-created profile leaves no ghost', async ({
    page,
  }) => {
    const suffix = uniqueSuffix();
    const created = await apiPost<ProfileResponse>(
      page,
      `/api/projects/${project.id}/auth-profiles`,
      token,
      { name: `Cancel ${suffix}`, projectId: project.id, ...VALID_OAUTH_APP_PAYLOAD },
      { headers: { 'X-Tenant-Id': tenantId } },
    );
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('pending_authorization');

    const del = await apiDelete(
      page,
      `/api/projects/${project.id}/auth-profiles/${created.body.data.id}`,
      token,
      { headers: { 'X-Tenant-Id': tenantId } },
    );
    expect(del.status).toBe(200);

    const list = await apiGet<{ data: Array<{ id: string }> }>(
      page,
      `/api/projects/${project.id}/auth-profiles`,
      token,
      { headers: { 'X-Tenant-Id': tenantId } },
    );
    const profiles: Array<{ id: string }> = list.body.data ?? [];
    const ids = profiles.map((p) => p.id);
    expect(ids).not.toContain(created.body.data.id);
  });

  test('G: browser-close leaves the pending row visible — list filter returns it for retry', async ({
    page,
  }) => {
    const suffix = uniqueSuffix();
    const created = await apiPost<ProfileResponse>(
      page,
      `/api/projects/${project.id}/auth-profiles`,
      token,
      { name: `Browser Close ${suffix}`, projectId: project.id, ...VALID_OAUTH_APP_PAYLOAD },
      { headers: { 'X-Tenant-Id': tenantId } },
    );
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('pending_authorization');

    // Simulate the user closing the browser before completing OAuth: the
    // pending row must remain discoverable so they can retry. Filter the
    // list by the new pending_authorization status and assert presence.
    const list = await apiGet<{ data: Array<{ id: string; status: string }> }>(
      page,
      `/api/projects/${project.id}/auth-profiles?status=pending_authorization`,
      token,
      { headers: { 'X-Tenant-Id': tenantId } },
    );
    expect(list.status).toBe(200);
    const profiles: Array<{ id: string; status: string }> = list.body.data ?? [];
    const match = profiles.find((p) => p.id === created.body.data.id);
    expect(match).toBeDefined();
    expect(match?.status).toBe('pending_authorization');

    // Cleanup so the test is idempotent across runs.
    await apiDelete(
      page,
      `/api/projects/${project.id}/auth-profiles/${created.body.data.id}`,
      token,
      {
        headers: { 'X-Tenant-Id': tenantId },
      },
    );
  });
});
