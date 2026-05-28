// @vitest-environment node

/**
 * E2E tests for Platform Keys API (/api/keys)
 *
 * Tests exercise the real system through HTTP API with full middleware chain.
 * No mocks, no direct DB access. Uses startStudioApiHarness() with MongoMemoryServer.
 *
 * Covers E2E-1 through E2E-16 from the test spec.
 */

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { PLATFORM_KEY_SCOPES, PLATFORM_KEY_SCOPE_KEYS } from '@agent-platform/shared-auth';
import { startStudioApiHarness, type StudioApiHarness } from './helpers/studio-api-harness';

const nativeFetch = (globalThis as Record<string, unknown>).__nativeFetch as typeof fetch;
vi.stubGlobal('fetch', nativeFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ApiResponse<T> {
  status: number;
  body: T;
}

interface AuthenticatedUserInfo {
  id: string;
  email: string;
  name: string | null;
}

interface DevLoginResponse {
  user: AuthenticatedUserInfo;
  accessToken: string;
}

interface CreateWorkspaceResponse {
  accessToken: string;
}

interface CreateProjectResponse {
  success: boolean;
  project: { id: string; tenantId: string };
}

interface PlatformKeyResponse {
  id: string;
  prefix: string;
  name: string;
  clientId: string;
  scopes: string[];
  projectIds: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  key?: string; // Only present on POST (creation)
}

interface ListKeysResponse {
  keys: PlatformKeyResponse[];
}

interface PlatformKeyScopeInfo {
  scope: string;
  label: string;
  description: string;
  category: 'execution' | 'management' | 'knowledge_base' | 'analytics' | 'admin';
}

interface PlatformKeyScopesResponse {
  scopes: PlatformKeyScopeInfo[];
}

interface WorkspaceInvitationResponse {
  invitation: {
    id: string;
    email: string;
    role: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'MEMBER' | 'VIEWER';
    status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
    createdAt: string;
    expiresAt: string;
  };
}

interface ProjectMemberResponse {
  success: boolean;
  member: {
    id: string;
    userId: string;
    role: string;
    customRoleId: string | null;
    joinedAt: string | null;
  };
}

interface ProjectAgentResponse {
  id: string;
  name: string;
  agentPath: string;
  description: string | null;
}

interface RuntimeProjectAgentsResponse {
  success: boolean;
  agents: ProjectAgentResponse[];
}

interface RuntimeUpdateAgentDslResponse {
  success: boolean;
  updatedAt?: string;
  error?: {
    code: string;
    message: string;
  };
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function uniqueEmail(prefix: string): string {
  return `${prefix}.${randomSuffix()}@e2e-smoke.test`;
}

function uniqueSlug(prefix: string): string {
  return `${prefix}-${randomSuffix()}`;
}

function authHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function requestJson<T>(
  harness: StudioApiHarness,
  path: string,
  init: RequestInit = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${harness.baseUrl}${path}`, init);
  const text = await response.text();
  return {
    status: response.status,
    body: text.length > 0 ? (JSON.parse(text) as T) : ({} as T),
  };
}

async function devLogin(harness: StudioApiHarness, email: string): Promise<DevLoginResponse> {
  const response = await requestJson<DevLoginResponse>(harness, '/api/auth/dev-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name: email.split('@')[0] }),
  });
  expect(response.status).toBe(200);
  return response.body;
}

async function createWorkspace(
  harness: StudioApiHarness,
  token: string,
  name: string,
): Promise<CreateWorkspaceResponse> {
  const response = await requestJson<CreateWorkspaceResponse>(
    harness,
    '/api/auth/create-workspace',
    {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ name }),
    },
  );
  expect(response.status).toBe(200);
  return response.body;
}

async function createProject(
  harness: StudioApiHarness,
  token: string,
  name: string,
  slug: string,
): Promise<CreateProjectResponse['project']> {
  const response = await requestJson<CreateProjectResponse>(harness, '/api/projects', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ name, slug }),
  });
  expect(response.status).toBe(201);
  expect(response.body.success).toBe(true);
  return response.body.project;
}

async function createPlatformKey(
  harness: StudioApiHarness,
  token: string,
  body: { name: string; scopes: string[]; projectIds: string[]; expiresAt?: string | null },
): Promise<ApiResponse<PlatformKeyResponse>> {
  return requestJson<PlatformKeyResponse>(harness, '/api/keys', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
}

async function listPlatformKeys(
  harness: StudioApiHarness,
  token: string,
  projectId: string,
): Promise<ApiResponse<ListKeysResponse>> {
  return requestJson<ListKeysResponse>(harness, `/api/keys?projectId=${projectId}`, {
    method: 'GET',
    headers: authHeaders(token),
  });
}

async function listPlatformKeyScopes(
  harness: StudioApiHarness,
  token: string,
): Promise<ApiResponse<PlatformKeyScopesResponse>> {
  return requestJson<PlatformKeyScopesResponse>(harness, '/api/keys/scopes', {
    method: 'GET',
    headers: authHeaders(token),
  });
}

async function inviteWorkspaceMember(
  harness: StudioApiHarness,
  token: string,
  tenantId: string,
  email: string,
  role: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'MEMBER' | 'VIEWER',
): Promise<ApiResponse<WorkspaceInvitationResponse>> {
  return requestJson<WorkspaceInvitationResponse>(
    harness,
    `/api/workspaces/${tenantId}/invitations`,
    {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ email, role }),
    },
  );
}

async function addProjectMember(
  harness: StudioApiHarness,
  token: string,
  projectId: string,
  userId: string,
  role: 'admin' | 'developer' | 'viewer',
): Promise<ApiResponse<ProjectMemberResponse>> {
  return requestJson<ProjectMemberResponse>(harness, `/api/projects/${projectId}/members`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ userId, role }),
  });
}

async function createProjectAgent(
  harness: StudioApiHarness,
  token: string,
  projectId: string,
  name: string,
): Promise<ApiResponse<ProjectAgentResponse>> {
  return requestJson<ProjectAgentResponse>(harness, `/api/projects/${projectId}/agents`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      name,
      agentPath: `default/${name}`,
      description: `Agent ${name}`,
    }),
  });
}

async function seedLegacyPlatformKey(
  harness: StudioApiHarness,
  body: {
    tenantId: string;
    createdBy: string;
    name?: string;
    scopes: string[];
    projectIds: string[];
    expiresAt?: string | null;
    rawKey?: string;
  },
): Promise<ApiResponse<PlatformKeyResponse>> {
  return requestJson<PlatformKeyResponse>(harness, '/__test/seed-platform-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function runtimeRequestJson<T>(
  harness: StudioApiHarness,
  path: string,
  init: RequestInit = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${harness.runtimeBaseUrl}${path}`, init);
  const text = await response.text();
  return {
    status: response.status,
    body: text.length > 0 ? (JSON.parse(text) as T) : ({} as T),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.sequential('Platform Keys API E2E', () => {
  let harness!: StudioApiHarness;

  beforeAll(async () => {
    harness = await startStudioApiHarness();
  }, 120_000);

  afterAll(async () => {
    await harness.close();
  }, 120_000);

  // E2E-1: Create key, verify in list (FR-05, FR-06, FR-13)
  test('E2E-1: create key and verify it appears in list', async () => {
    const owner = await devLogin(harness, uniqueEmail('e2e1-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `E2E-1 WS ${randomSuffix()}`);
    const project = await createProject(
      harness,
      ws.accessToken,
      `E2E-1 Proj ${randomSuffix()}`,
      uniqueSlug('e2e1'),
    );

    // Create a key
    const createRes = await createPlatformKey(harness, ws.accessToken, {
      name: 'My E2E Key',
      scopes: ['workflows.execute'],
      projectIds: [project.id],
    });

    expect(createRes.status).toBe(201);
    expect(createRes.body.key).toBeDefined();
    expect(createRes.body.key).toMatch(/^abl_/);
    expect(createRes.body.prefix).toHaveLength(8);
    expect(createRes.body.prefix).toBe(createRes.body.key!.substring(0, 8));
    expect(createRes.body.name).toBe('My E2E Key');
    expect(createRes.body.scopes).toEqual(['workflows.execute']);
    expect(createRes.body.projectIds).toEqual([project.id]);
    expect(createRes.body.clientId).toMatch(/^plt-/);

    // Verify it appears in the list
    const listRes = await listPlatformKeys(harness, ws.accessToken, project.id);
    expect(listRes.status).toBe(200);
    expect(listRes.body.keys).toHaveLength(1);
    expect(listRes.body.keys[0].id).toBe(createRes.body.id);
    // Raw key must NOT appear in list
    expect(listRes.body.keys[0]).not.toHaveProperty('key');
  });

  // E2E-2: Revoke key, verify exclusion (FR-11, FR-03)
  test('E2E-2: revoke key and verify it disappears from list', async () => {
    const owner = await devLogin(harness, uniqueEmail('e2e2-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `E2E-2 WS ${randomSuffix()}`);
    const project = await createProject(
      harness,
      ws.accessToken,
      `E2E-2 Proj ${randomSuffix()}`,
      uniqueSlug('e2e2'),
    );

    const createRes = await createPlatformKey(harness, ws.accessToken, {
      name: 'To Revoke',
      scopes: ['workflows.execute'],
      projectIds: [project.id],
    });
    expect(createRes.status).toBe(201);

    // Revoke
    const revokeRes = await requestJson<{ success: boolean }>(
      harness,
      `/api/keys/${createRes.body.id}?projectId=${project.id}`,
      { method: 'DELETE', headers: authHeaders(ws.accessToken) },
    );
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.success).toBe(true);

    // Verify excluded from list
    const listRes = await listPlatformKeys(harness, ws.accessToken, project.id);
    expect(listRes.status).toBe(200);
    expect(listRes.body.keys).toHaveLength(0);

    // Second DELETE returns 404 (idempotency guard)
    const secondRevoke = await requestJson<{ error: string }>(
      harness,
      `/api/keys/${createRes.body.id}?projectId=${project.id}`,
      { method: 'DELETE', headers: authHeaders(ws.accessToken) },
    );
    expect(secondRevoke.status).toBe(404);
  });

  // E2E-3: Cross-tenant isolation returns 404 (FR-14, invariant #1)
  test('E2E-3: cross-tenant access returns 404', async () => {
    // Tenant A
    const ownerA = await devLogin(harness, uniqueEmail('e2e3-tenantA'));
    const wsA = await createWorkspace(harness, ownerA.accessToken, `E2E-3 WS-A ${randomSuffix()}`);
    const projectA = await createProject(
      harness,
      wsA.accessToken,
      `E2E-3 Proj-A ${randomSuffix()}`,
      uniqueSlug('e2e3a'),
    );

    const createRes = await createPlatformKey(harness, wsA.accessToken, {
      name: 'Tenant A Key',
      scopes: ['workflows.execute'],
      projectIds: [projectA.id],
    });
    expect(createRes.status).toBe(201);

    // Tenant B
    const ownerB = await devLogin(harness, uniqueEmail('e2e3-tenantB'));
    const wsB = await createWorkspace(harness, ownerB.accessToken, `E2E-3 WS-B ${randomSuffix()}`);

    // Tenant B tries to list Tenant A's project keys → 404 (project access check)
    const listRes = await listPlatformKeys(harness, wsB.accessToken, projectA.id);
    expect(listRes.status).toBe(404);

    // Tenant B tries to revoke Tenant A's key → 404
    const revokeRes = await requestJson<{ error: string }>(
      harness,
      `/api/keys/${createRes.body.id}?projectId=${projectA.id}`,
      { method: 'DELETE', headers: authHeaders(wsB.accessToken) },
    );
    expect(revokeRes.status).toBe(404);

    // Tenant B tries to update Tenant A's key → 404
    const patchRes = await requestJson<{ error: string }>(
      harness,
      `/api/keys/${createRes.body.id}`,
      {
        method: 'PATCH',
        headers: authHeaders(wsB.accessToken),
        body: JSON.stringify({ projectId: projectA.id, name: 'Hacked' }),
      },
    );
    expect(patchRes.status).toBe(404);
  });

  // E2E-4: Cross-project isolation (FR-03, FR-14)
  test('E2E-4: key scoped to project A not visible in project B', async () => {
    const owner = await devLogin(harness, uniqueEmail('e2e4-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `E2E-4 WS ${randomSuffix()}`);
    const projectA = await createProject(
      harness,
      ws.accessToken,
      `E2E-4 ProjA ${randomSuffix()}`,
      uniqueSlug('e2e4a'),
    );
    const projectB = await createProject(
      harness,
      ws.accessToken,
      `E2E-4 ProjB ${randomSuffix()}`,
      uniqueSlug('e2e4b'),
    );

    // Create key for project A only
    const createRes = await createPlatformKey(harness, ws.accessToken, {
      name: 'Project A Only',
      scopes: ['workflows.execute'],
      projectIds: [projectA.id],
    });
    expect(createRes.status).toBe(201);

    // Key visible in project A
    const listA = await listPlatformKeys(harness, ws.accessToken, projectA.id);
    expect(listA.status).toBe(200);
    expect(listA.body.keys).toHaveLength(1);

    // Key NOT visible in project B
    const listB = await listPlatformKeys(harness, ws.accessToken, projectB.id);
    expect(listB.status).toBe(200);
    expect(listB.body.keys).toHaveLength(0);
  });

  // E2E-5: Scope validation rejects unknown scopes (FR-07)
  test('E2E-5: creating key with invalid scope is rejected', async () => {
    const owner = await devLogin(harness, uniqueEmail('e2e5-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `E2E-5 WS ${randomSuffix()}`);
    const project = await createProject(
      harness,
      ws.accessToken,
      `E2E-5 Proj ${randomSuffix()}`,
      uniqueSlug('e2e5'),
    );

    // Try creating with an invalid scope
    const res = await createPlatformKey(harness, ws.accessToken, {
      name: 'Bad Scope',
      scopes: ['admin:delete'] as unknown as string[],
      projectIds: [project.id],
    });

    // Zod validation should reject — returns 400 with validation errors
    expect(res.status).toBe(400);
  });

  // E2E-6: Edit name/scopes, projectIds immutable (FR-10)
  test('E2E-6: edit key name and scopes, projectIds rejected', async () => {
    const owner = await devLogin(harness, uniqueEmail('e2e6-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `E2E-6 WS ${randomSuffix()}`);
    const project = await createProject(
      harness,
      ws.accessToken,
      `E2E-6 Proj ${randomSuffix()}`,
      uniqueSlug('e2e6'),
    );

    const createRes = await createPlatformKey(harness, ws.accessToken, {
      name: 'Original Name',
      scopes: ['workflows.execute'],
      projectIds: [project.id],
    });
    expect(createRes.status).toBe(201);

    // Update name and scopes
    const patchRes = await requestJson<PlatformKeyResponse>(
      harness,
      `/api/keys/${createRes.body.id}`,
      {
        method: 'PATCH',
        headers: authHeaders(ws.accessToken),
        body: JSON.stringify({
          projectId: project.id,
          name: 'Updated Name',
          scopes: ['workflows.execute', 'workflows.read'],
        }),
      },
    );

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.name).toBe('Updated Name');
    expect(patchRes.body.scopes).toEqual(
      expect.arrayContaining(['workflows.execute', 'workflows.read']),
    );

    // Attempt to modify projectIds → rejected by .strict() Zod schema
    const badPatch = await requestJson<{
      success: boolean;
      errors: { code: string; msg: string }[];
    }>(harness, `/api/keys/${createRes.body.id}`, {
      method: 'PATCH',
      headers: authHeaders(ws.accessToken),
      body: JSON.stringify({
        projectId: project.id,
        projectIds: ['some-other-project'],
      }),
    });
    expect(badPatch.status).toBe(400);
    // .strict() rejects unrecognized keys with a Zod validation error
    expect(badPatch.body.success).toBe(false);
  });

  // E2E-7: Expired key excluded from list (FR-03, FR-08)
  test('E2E-7: expired key is excluded from GET list', async () => {
    const owner = await devLogin(harness, uniqueEmail('e2e7-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `E2E-7 WS ${randomSuffix()}`);
    const project = await createProject(
      harness,
      ws.accessToken,
      `E2E-7 Proj ${randomSuffix()}`,
      uniqueSlug('e2e7'),
    );

    // Create key with past expiration
    const pastDate = new Date(Date.now() - 86_400_000).toISOString(); // yesterday
    const createRes = await createPlatformKey(harness, ws.accessToken, {
      name: 'Expired Key',
      scopes: ['workflows.execute'],
      projectIds: [project.id],
      expiresAt: pastDate,
    });
    expect(createRes.status).toBe(201);

    // Create a valid key too
    const validRes = await createPlatformKey(harness, ws.accessToken, {
      name: 'Valid Key',
      scopes: ['workflows.execute'],
      projectIds: [project.id],
    });
    expect(validRes.status).toBe(201);

    // List should only return the valid key
    const listRes = await listPlatformKeys(harness, ws.accessToken, project.id);
    expect(listRes.status).toBe(200);
    expect(listRes.body.keys).toHaveLength(1);
    expect(listRes.body.keys[0].name).toBe('Valid Key');
  });

  // E2E-8: Unauthenticated request returns 401 (FR-14)
  test('E2E-8: unauthenticated requests return 401', async () => {
    // No auth header
    const listRes = await requestJson<{ error: string }>(
      harness,
      '/api/keys?projectId=some-project',
      { method: 'GET' },
    );
    expect(listRes.status).toBe(401);

    const createRes = await requestJson<{ error: string }>(harness, '/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Unauthed',
        scopes: ['workflows.execute'],
        projectIds: ['some-project'],
      }),
    });
    expect(createRes.status).toBe(401);
  });

  // E2E-9: Workflow trigger key creation contract (FR-15, FR-16)
  test('E2E-9: key with workflows.execute scope matches trigger creation contract', async () => {
    const owner = await devLogin(harness, uniqueEmail('e2e9-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `E2E-9 WS ${randomSuffix()}`);
    const project = await createProject(
      harness,
      ws.accessToken,
      `E2E-9 Proj ${randomSuffix()}`,
      uniqueSlug('e2e9'),
    );

    // Simulate what WebhookKeyCreationModal does
    const createRes = await createPlatformKey(harness, ws.accessToken, {
      name: `Webhook Key for Workflow ${randomSuffix()}`,
      scopes: ['workflows.execute'],
      projectIds: [project.id],
    });

    expect(createRes.status).toBe(201);
    expect(createRes.body.key).toMatch(/^abl_/);
    expect(createRes.body.scopes).toContain('workflows.execute');
    expect(createRes.body.prefix).toHaveLength(8);

    // Verify the key shows up in the project list (which is what WorkflowTriggersTab fetches)
    const listRes = await listPlatformKeys(harness, ws.accessToken, project.id);
    expect(listRes.status).toBe(200);
    expect(listRes.body.keys.some((k) => k.id === createRes.body.id)).toBe(true);
  });

  // E2E-10: Multi-project key visible in both projects (FR-09)
  test('E2E-10: multi-project key visible in both projects', async () => {
    const owner = await devLogin(harness, uniqueEmail('e2e10-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `E2E-10 WS ${randomSuffix()}`);
    const projectA = await createProject(
      harness,
      ws.accessToken,
      `E2E-10 ProjA ${randomSuffix()}`,
      uniqueSlug('e2e10a'),
    );
    const projectB = await createProject(
      harness,
      ws.accessToken,
      `E2E-10 ProjB ${randomSuffix()}`,
      uniqueSlug('e2e10b'),
    );

    // Create key for both projects
    const createRes = await createPlatformKey(harness, ws.accessToken, {
      name: 'Multi-project Key',
      scopes: ['workflows.execute', 'workflows.read'],
      projectIds: [projectA.id, projectB.id],
    });
    expect(createRes.status).toBe(201);
    expect(createRes.body.projectIds).toEqual(expect.arrayContaining([projectA.id, projectB.id]));

    // Visible in project A
    const listA = await listPlatformKeys(harness, ws.accessToken, projectA.id);
    expect(listA.status).toBe(200);
    expect(listA.body.keys).toHaveLength(1);
    expect(listA.body.keys[0].id).toBe(createRes.body.id);

    // Visible in project B
    const listB = await listPlatformKeys(harness, ws.accessToken, projectB.id);
    expect(listB.status).toBe(200);
    expect(listB.body.keys).toHaveLength(1);
    expect(listB.body.keys[0].id).toBe(createRes.body.id);
  });

  // E2E-11: VIEWER ceiling enforcement (FR-20)
  test('E2E-11: VIEWER cannot create agents.write key but can create workflows.read key', async () => {
    const owner = await devLogin(harness, uniqueEmail('e2e11-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `E2E-11 WS ${randomSuffix()}`);
    const project = await createProject(
      harness,
      ws.accessToken,
      `E2E-11 Proj ${randomSuffix()}`,
      uniqueSlug('e2e11'),
    );

    const viewerEmail = uniqueEmail('e2e11-viewer');
    const inviteRes = await inviteWorkspaceMember(
      harness,
      ws.accessToken,
      project.tenantId,
      viewerEmail,
      'VIEWER',
    );
    expect(inviteRes.status).toBe(201);

    const viewer = await devLogin(harness, viewerEmail);
    const membershipRes = await addProjectMember(
      harness,
      ws.accessToken,
      project.id,
      viewer.user.id,
      'developer',
    );
    expect(membershipRes.status).toBe(201);

    const deniedRes = await createPlatformKey(harness, viewer.accessToken, {
      name: 'Viewer Agents Write',
      scopes: ['agents.write'],
      projectIds: [project.id],
    });
    expect(deniedRes.status).toBe(403);
    expect(deniedRes.body).toEqual({
      error: 'Scope ceiling exceeded',
      code: 'SCOPE_CEILING_EXCEEDED',
      denied: ['agents.write'],
    });

    const allowedRes = await createPlatformKey(harness, viewer.accessToken, {
      name: 'Viewer Workflows Read',
      scopes: ['workflows.read'],
      projectIds: [project.id],
    });
    expect(allowedRes.status).toBe(201);
    expect(allowedRes.body.scopes).toEqual(['workflows.read']);
  });

  // E2E-12: ADMIN ceiling enforcement (FR-20)
  test('E2E-12: ADMIN can create management keys but is still blocked from analytics.read', async () => {
    const owner = await devLogin(harness, uniqueEmail('e2e12-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `E2E-12 WS ${randomSuffix()}`);
    const project = await createProject(
      harness,
      ws.accessToken,
      `E2E-12 Proj ${randomSuffix()}`,
      uniqueSlug('e2e12'),
    );

    const adminEmail = uniqueEmail('e2e12-admin');
    const inviteRes = await inviteWorkspaceMember(
      harness,
      ws.accessToken,
      project.tenantId,
      adminEmail,
      'ADMIN',
    );
    expect(inviteRes.status).toBe(201);

    const admin = await devLogin(harness, adminEmail);

    const allowedRes = await createPlatformKey(harness, admin.accessToken, {
      name: 'Admin Management Key',
      scopes: ['agents.write', 'deployments.write', 'workflows.execute'],
      projectIds: [project.id],
    });
    expect(allowedRes.status).toBe(201);
    expect(allowedRes.body.scopes).toEqual([
      'agents.write',
      'deployments.write',
      'workflows.execute',
    ]);

    const deniedRes = await createPlatformKey(harness, admin.accessToken, {
      name: 'Admin Analytics Denied',
      scopes: ['analytics.read'],
      projectIds: [project.id],
    });
    expect(deniedRes.status).toBe(403);
    expect(deniedRes.body).toEqual({
      error: 'Scope ceiling exceeded',
      code: 'SCOPE_CEILING_EXCEEDED',
      denied: ['analytics.read'],
    });
  });

  // E2E-13: PATCH ceiling enforcement (FR-20)
  test('E2E-13: PATCH scope escalation is denied and stored scopes remain unchanged', async () => {
    const owner = await devLogin(harness, uniqueEmail('e2e13-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `E2E-13 WS ${randomSuffix()}`);
    const project = await createProject(
      harness,
      ws.accessToken,
      `E2E-13 Proj ${randomSuffix()}`,
      uniqueSlug('e2e13'),
    );

    const operatorEmail = uniqueEmail('e2e13-operator');
    const inviteRes = await inviteWorkspaceMember(
      harness,
      ws.accessToken,
      project.tenantId,
      operatorEmail,
      'OPERATOR',
    );
    expect(inviteRes.status).toBe(201);

    const operator = await devLogin(harness, operatorEmail);
    const membershipRes = await addProjectMember(
      harness,
      ws.accessToken,
      project.id,
      operator.user.id,
      'developer',
    );
    expect(membershipRes.status).toBe(201);

    const createRes = await createPlatformKey(harness, operator.accessToken, {
      name: 'Operator Patch Key',
      scopes: ['workflows.execute'],
      projectIds: [project.id],
    });
    expect(createRes.status).toBe(201);

    const deniedPatch = await requestJson<{
      error: string;
      code: string;
      denied: string[];
    }>(harness, `/api/keys/${createRes.body.id}`, {
      method: 'PATCH',
      headers: authHeaders(operator.accessToken),
      body: JSON.stringify({
        projectId: project.id,
        scopes: ['workflows.execute', 'agents.write'],
      }),
    });
    expect(deniedPatch.status).toBe(403);
    expect(deniedPatch.body).toEqual({
      error: 'Scope ceiling exceeded',
      code: 'SCOPE_CEILING_EXCEEDED',
      denied: ['agents.write'],
    });

    const listRes = await listPlatformKeys(harness, operator.accessToken, project.id);
    expect(listRes.status).toBe(200);
    const key = listRes.body.keys.find((entry) => entry.id === createRes.body.id);
    expect(key).toBeDefined();
    expect(key!.scopes).toEqual(['workflows.execute']);
  });

  // E2E-14: Runtime resolves dot scopes to RBAC permissions (FR-22, FR-24)
  test('E2E-14: runtime enforces agent read/write permissions from dot scopes', async () => {
    const owner = await devLogin(harness, uniqueEmail('e2e14-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `E2E-14 WS ${randomSuffix()}`);
    const project = await createProject(
      harness,
      ws.accessToken,
      `E2E-14 Proj ${randomSuffix()}`,
      uniqueSlug('e2e14'),
    );

    const agentName = uniqueSlug('platform-key-agent').replace(/-/g, '_');
    const agentRes = await createProjectAgent(harness, ws.accessToken, project.id, agentName);
    expect(agentRes.status).toBe(201);

    const readKeyRes = await createPlatformKey(harness, ws.accessToken, {
      name: 'Agents Read Key',
      scopes: ['agents.read'],
      projectIds: [project.id],
    });
    expect(readKeyRes.status).toBe(201);

    const readAgentsRes = await runtimeRequestJson<RuntimeProjectAgentsResponse>(
      harness,
      `/api/projects/${project.id}/agents`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${readKeyRes.body.key!}` },
      },
    );
    expect(readAgentsRes.status).toBe(200);
    expect(readAgentsRes.body.success).toBe(true);
    expect(readAgentsRes.body.agents.some((agent) => agent.name === agentName)).toBe(true);

    const deniedWriteRes = await runtimeRequestJson<RuntimeUpdateAgentDslResponse>(
      harness,
      `/api/projects/${project.id}/agents/${agentName}/dsl`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${readKeyRes.body.key!}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ dslContent: 'AGENT test_agent\nGOAL: Help' }),
      },
    );
    expect(deniedWriteRes.status).toBe(403);
    expect(deniedWriteRes.body.success).toBe(false);

    const writeKeyRes = await createPlatformKey(harness, ws.accessToken, {
      name: 'Agents Write Key',
      scopes: ['agents.write'],
      projectIds: [project.id],
    });
    expect(writeKeyRes.status).toBe(201);

    const allowedWriteRes = await runtimeRequestJson<RuntimeUpdateAgentDslResponse>(
      harness,
      `/api/projects/${project.id}/agents/${agentName}/dsl`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${writeKeyRes.body.key!}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ dslContent: 'AGENT test_agent\nGOAL: Help' }),
      },
    );
    expect(allowedWriteRes.status).toBe(200);
    expect(allowedWriteRes.body.success).toBe(true);
  });

  // E2E-15: Backwards compatibility for legacy colon scopes (FR-22, FR-24)
  test('E2E-15: legacy colon scopes and new dot scopes both authenticate at runtime', async () => {
    const owner = await devLogin(harness, uniqueEmail('e2e15-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `E2E-15 WS ${randomSuffix()}`);
    const project = await createProject(
      harness,
      ws.accessToken,
      `E2E-15 Proj ${randomSuffix()}`,
      uniqueSlug('e2e15'),
    );

    const agentName = uniqueSlug('legacy-agent').replace(/-/g, '_');
    const agentRes = await createProjectAgent(harness, ws.accessToken, project.id, agentName);
    expect(agentRes.status).toBe(201);

    const legacyKeyRes = await seedLegacyPlatformKey(harness, {
      tenantId: project.tenantId,
      createdBy: owner.user.id,
      name: 'Legacy Agents Read Key',
      scopes: ['agent:read'],
      projectIds: [project.id],
    });
    expect(legacyKeyRes.status).toBe(201);
    expect(legacyKeyRes.body.scopes).toEqual(['agent:read']);

    const newKeyRes = await createPlatformKey(harness, ws.accessToken, {
      name: 'New Agents Read Key',
      scopes: ['agents.read'],
      projectIds: [project.id],
    });
    expect(newKeyRes.status).toBe(201);
    expect(newKeyRes.body.scopes).toEqual(['agents.read']);

    const listRes = await listPlatformKeys(harness, ws.accessToken, project.id);
    expect(listRes.status).toBe(200);
    expect(listRes.body.keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: legacyKeyRes.body.id,
          scopes: ['agent:read'],
        }),
        expect.objectContaining({
          id: newKeyRes.body.id,
          scopes: ['agents.read'],
        }),
      ]),
    );

    const legacyRuntimeRes = await runtimeRequestJson<RuntimeProjectAgentsResponse>(
      harness,
      `/api/projects/${project.id}/agents`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${legacyKeyRes.body.key!}` },
      },
    );
    expect(legacyRuntimeRes.status).toBe(200);
    expect(legacyRuntimeRes.body.success).toBe(true);

    const newRuntimeRes = await runtimeRequestJson<RuntimeProjectAgentsResponse>(
      harness,
      `/api/projects/${project.id}/agents`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${newKeyRes.body.key!}` },
      },
    );
    expect(newRuntimeRes.status).toBe(200);
    expect(newRuntimeRes.body.success).toBe(true);
  });

  // E2E-16: Scope registry endpoint (FR-23, SEC-9)
  test('E2E-16: scopes endpoint returns grouped registry metadata without permission mappings', async () => {
    const owner = await devLogin(harness, uniqueEmail('e2e16-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `E2E-16 WS ${randomSuffix()}`);
    void ws;

    const scopesRes = await listPlatformKeyScopes(harness, owner.accessToken);
    expect(scopesRes.status).toBe(200);
    expect(scopesRes.body.scopes).toHaveLength(PLATFORM_KEY_SCOPE_KEYS.length);
    expect(scopesRes.body.scopes.map((scope) => scope.scope)).toEqual(PLATFORM_KEY_SCOPE_KEYS);
    expect(scopesRes.body.scopes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'workflows.execute',
          label: expect.any(String),
          description: expect.any(String),
          category: 'execution',
        }),
      ]),
    );
    const categories = new Set(scopesRes.body.scopes.map((scope) => scope.category));
    expect(categories).toEqual(
      new Set(Object.values(PLATFORM_KEY_SCOPES).map((scope) => scope.category)),
    );
    for (const scope of scopesRes.body.scopes) {
      expect(scope).not.toHaveProperty('requiredPermissions');
      expect(Object.keys(scope).sort()).toEqual(['category', 'description', 'label', 'scope']);
    }

    const noAuthRes = await requestJson<Record<string, unknown>>(harness, '/api/keys/scopes', {
      method: 'GET',
    });
    expect(noAuthRes.status).toBe(401);
  });
});
