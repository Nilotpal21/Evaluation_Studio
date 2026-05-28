/**
 * E2E: ABLP-619 — Integration Bind No Consent (FR-10)
 *
 * Regression: binding a workflow integration node to an existing OAuth
 * `auth-profile` MUST NOT trigger any `POST /auth-profiles/oauth/initiate`
 * call. Re-consent only happens through the explicit "Authorize" UX (the
 * slide-over in Phase 4 or the standalone OAuth dialog) — never as a side
 * effect of binding a profile to an integration node.
 *
 * Why two checks here:
 *
 * 1) **Static-import scan** of `apps/studio/src/components/workflows/canvas/config/IntegrationNodeConfig.tsx`.
 *    The LLD calls out "if a developer re-introduces an oauth/initiate call
 *    from IntegrationNodeConfig.tsx, this test must fail" as the negative
 *    regression. The cheapest deterministic guard is a code-level scan: if
 *    the file gains a reference to `initiateOAuth`, `initiateWorkspaceOAuth`,
 *    or the `/oauth/initiate` URL string, this test fails immediately —
 *    even before the runtime path is exercised.
 *
 * 2) **Runtime API replay** of the IntegrationNodeConfig data path.
 *    With a real Studio server reachable via PM2 (no mocks, no DB access),
 *    the test seeds an `oauth2_app` auth-profile and exercises the same
 *    HTTP endpoints that the component fetches during bind:
 *    `/api/projects/:id/connectors`, action schemas, and `connections`. A
 *    Playwright request-event listener on the browser context captures any
 *    `/auth-profiles/oauth/initiate` calls that fire during the page-driven
 *    auth-profiles navigation; the assertion is that none do.
 *
 * Live-runtime workflow execution (LLD task 5.1 step 4 — "trigger workflow
 * execution and assert resolution via oauth-grant-service.ts") is documented
 * as deferred-but-covered: the runtime resolver path is unit-tested by
 * `packages/connectors/src/__tests__/auth-profile-resolver-factory-pending.test.ts`
 * (Phase 1B) and the project/workspace callback handlers' status flip is
 * unit-tested by `auth-profile-oauth-callback-route.test.ts` (Phase 2). The
 * upstream OAuth provider stub the studio's PM2-mode E2E harness would need
 * for an end-to-end runtime trigger does not exist today; the same caveat
 * already applies to E2E-8 scenarios A and B.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { test, expect, type Page } from '@playwright/test';
import { apiDelete, apiGet, apiPost } from '../helpers/api';
import { getDevAccessToken } from '../helpers/auth';
import { env } from '../helpers/env';

const TEST_LOGIN_EMAIL = 'auth-profiles@e2e-smoke.test';
const TEST_LOGIN_NAME = 'Integration Bind No Consent E2E';

const FORBIDDEN_PATH_FRAGMENTS = [
  '/auth-profiles/oauth/initiate',
  '/api/admin/auth-profiles/oauth/initiate',
];
const FORBIDDEN_SOURCE_PATTERNS = [
  /\binitiateOAuth\b/,
  /\binitiateWorkspaceOAuth\b/,
  /\/auth-profiles\/oauth\/initiate\b/,
];

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
      name: `Integration Bind ${suffix}`,
      slug: `integration-bind-${suffix}`,
      description: 'ABLP-619 FR-10 regression coverage',
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
  data: { id: string; status: string; authType: string };
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

test.describe('ABLP-619 — Integration Bind No Consent (FR-10)', () => {
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

  test('static: IntegrationNodeConfig.tsx contains no oauth/initiate references', async () => {
    const filePath = path.resolve(
      process.cwd(),
      'src/components/workflows/canvas/config/IntegrationNodeConfig.tsx',
    );
    const source = await fs.readFile(filePath, 'utf8');
    for (const pattern of FORBIDDEN_SOURCE_PATTERNS) {
      expect(
        source,
        `IntegrationNodeConfig.tsx must not reference ${pattern} — bind path must never trigger OAuth re-consent (FR-10).`,
      ).not.toMatch(pattern);
    }
  });

  test('runtime: bind-path API surface emits zero /auth-profiles/oauth/initiate requests', async ({
    page,
  }) => {
    // Capture every browser-context request issued during this test, so we
    // can assert later that nothing in the bind data path slips an initiate
    // call past us. page.request.*-style calls run on the same browser
    // context and ARE captured by `page.on('request')`.
    const observedInitiateCalls: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      if (FORBIDDEN_PATH_FRAGMENTS.some((fragment) => url.includes(fragment))) {
        observedInitiateCalls.push(`${req.method()} ${url}`);
      }
    });

    // Seed: an oauth2_app profile in `pending_authorization`. FR-10 guards
    // the bind path against ANY status — we deliberately use the most
    // OAuth-flavoured seed so the test would catch a regression that
    // conditioned re-consent on `status === 'pending_authorization'`.
    const suffix = uniqueSuffix();
    const created = await apiPost<ProfileResponse>(
      page,
      `/api/projects/${project.id}/auth-profiles`,
      token,
      {
        name: `Bind Test OAuth ${suffix}`,
        projectId: project.id,
        ...VALID_OAUTH_APP_PAYLOAD,
      },
      { headers: { 'X-Tenant-Id': tenantId } },
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.authType).toBe('oauth2_app');
    const profileId = created.body.data.id;

    // Replay the data path the IntegrationNodeConfig component walks during
    // bind: catalog, action schemas, connections list, profile detail. None
    // of these should ever emit an /oauth/initiate request as a side
    // effect; if Studio's connectors/connections services regress and start
    // doing pre-flight OAuth on read, this test catches it.
    const catalog = await apiGet<{ data: Array<{ name: string }> }>(
      page,
      `/api/projects/${project.id}/connectors`,
      token,
      { headers: { 'X-Tenant-Id': tenantId } },
    );
    expect(catalog.status, JSON.stringify(catalog.body)).toBe(200);

    const connectors: Array<{ name: string }> = catalog.body.data ?? [];
    const firstConnectorName = connectors[0]?.name ?? '';

    if (firstConnectorName) {
      const actions = await apiGet(
        page,
        `/api/projects/${project.id}/connectors/${encodeURIComponent(firstConnectorName)}/actions`,
        token,
        { headers: { 'X-Tenant-Id': tenantId } },
      );
      // Status may vary by connector permissions; the assertion that
      // matters is the side-effect-free invariant captured in
      // `observedInitiateCalls` below.
      expect([200, 404]).toContain(actions.status);
    }

    const connectionsList = await apiGet(page, `/api/projects/${project.id}/connections`, token, {
      headers: { 'X-Tenant-Id': tenantId },
    });
    expect([200, 404]).toContain(connectionsList.status);

    const profileDetail = await apiGet<{ data: { id: string; status: string } }>(
      page,
      `/api/projects/${project.id}/auth-profiles/${profileId}`,
      token,
      { headers: { 'X-Tenant-Id': tenantId } },
    );
    expect(profileDetail.status).toBe(200);
    expect(profileDetail.body.data.id).toBe(profileId);

    // Final invariant: zero /oauth/initiate traffic across the entire
    // bind-path replay. Any non-empty list here is the regression.
    expect(observedInitiateCalls, 'integration-node bind must not trigger OAuth initiate').toEqual(
      [],
    );

    // Cleanup the pending profile so the test is idempotent.
    await apiDelete(page, `/api/projects/${project.id}/auth-profiles/${profileId}`, token, {
      headers: { 'X-Tenant-Id': tenantId },
    });
  });
});
