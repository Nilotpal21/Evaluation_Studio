// @vitest-environment node

/**
 * Integration tests for Platform Keys API (/api/keys)
 *
 * Tests exercise real HTTP requests against startStudioApiHarness() with
 * MongoMemoryServer. Validates database-level behavior: field storage,
 * hash integrity, filter correctness, safety caps.
 *
 * Covers INT-1 through INT-16 from the test spec.
 */

import crypto from 'node:crypto';
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
  key?: string;
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

const ALL_PLATFORM_KEY_SCOPES = PLATFORM_KEY_SCOPE_KEYS;

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.sequential('Platform Keys API Integration', () => {
  let harness!: StudioApiHarness;

  beforeAll(async () => {
    harness = await startStudioApiHarness();
  }, 120_000);

  afterAll(async () => {
    await harness.close();
  }, 120_000);

  // INT-1: POST creates ApiKey document with correct fields
  test('INT-1: POST creates key with abl_ prefix, plt- clientId, correct fields', async () => {
    const owner = await devLogin(harness, uniqueEmail('int1-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `INT-1 WS ${randomSuffix()}`);
    const project = await createProject(
      harness,
      ws.accessToken,
      `INT-1 Proj ${randomSuffix()}`,
      uniqueSlug('int1'),
    );

    const res = await createPlatformKey(harness, ws.accessToken, {
      name: 'INT-1 Key',
      scopes: ['workflows.execute'],
      projectIds: [project.id],
    });

    expect(res.status).toBe(201);
    // Raw key format
    expect(res.body.key).toMatch(/^abl_[a-f0-9]{48}$/);
    // Prefix is first 8 chars of raw key
    expect(res.body.prefix).toBe(res.body.key!.substring(0, 8));
    expect(res.body.prefix).toHaveLength(8);
    // ClientId format
    expect(res.body.clientId).toMatch(/^plt-/);
    // Fields
    expect(res.body.name).toBe('INT-1 Key');
    expect(res.body.scopes).toEqual(['workflows.execute']);
    expect(res.body.projectIds).toEqual([project.id]);
    expect(res.body.expiresAt).toBeNull();
    expect(res.body.lastUsedAt).toBeNull();
    expect(res.body.createdAt).toBeDefined();
    expect(res.body.id).toBeDefined();
  });

  // INT-2: GET filters by projectId, revokedAt, expiresAt
  test('INT-2: GET filters correctly by projectId, excludes revoked and expired', async () => {
    const owner = await devLogin(harness, uniqueEmail('int2-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `INT-2 WS ${randomSuffix()}`);
    const project = await createProject(
      harness,
      ws.accessToken,
      `INT-2 Proj ${randomSuffix()}`,
      uniqueSlug('int2'),
    );

    // Create active key
    const activeRes = await createPlatformKey(harness, ws.accessToken, {
      name: 'Active',
      scopes: ['workflows.execute'],
      projectIds: [project.id],
    });
    expect(activeRes.status).toBe(201);

    // Create expired key
    const pastDate = new Date(Date.now() - 86_400_000).toISOString();
    const expiredRes = await createPlatformKey(harness, ws.accessToken, {
      name: 'Expired',
      scopes: ['workflows.execute'],
      projectIds: [project.id],
      expiresAt: pastDate,
    });
    expect(expiredRes.status).toBe(201);

    // Create and revoke a key
    const toRevokeRes = await createPlatformKey(harness, ws.accessToken, {
      name: 'To Revoke',
      scopes: ['workflows.execute'],
      projectIds: [project.id],
    });
    expect(toRevokeRes.status).toBe(201);
    const revokeRes = await requestJson<{ success: boolean }>(
      harness,
      `/api/keys/${toRevokeRes.body.id}?projectId=${project.id}`,
      { method: 'DELETE', headers: authHeaders(ws.accessToken) },
    );
    expect(revokeRes.status).toBe(200);

    // List should only show the active key
    const listRes = await listPlatformKeys(harness, ws.accessToken, project.id);
    expect(listRes.status).toBe(200);
    expect(listRes.body.keys).toHaveLength(1);
    expect(listRes.body.keys[0].name).toBe('Active');
  });

  // INT-3: keyHash matches SHA-256 of raw key (direct DB verification)
  test('INT-3: stored keyHash matches SHA-256 of raw key', async () => {
    const owner = await devLogin(harness, uniqueEmail('int3-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `INT-3 WS ${randomSuffix()}`);
    const project = await createProject(
      harness,
      ws.accessToken,
      `INT-3 Proj ${randomSuffix()}`,
      uniqueSlug('int3'),
    );

    const res = await createPlatformKey(harness, ws.accessToken, {
      name: 'Hash Verify',
      scopes: ['workflows.execute'],
      projectIds: [project.id],
    });
    expect(res.status).toBe(201);

    const rawKey = res.body.key!;
    const expectedHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    // Direct DB verification: query the stored document and compare keyHash
    const { ApiKey } = await import('@agent-platform/database/models');
    const doc = await ApiKey.findOne({ _id: res.body.id }).lean();
    expect(doc).not.toBeNull();
    expect(doc!.keyHash).toBe(expectedHash);
    expect(doc!.prefix).toBe(rawKey.substring(0, 8));
    expect(doc!.prefix).toHaveLength(8);
  });

  // INT-4: DELETE soft-revokes, second DELETE returns 404
  test('INT-4: DELETE is idempotent via revokedAt guard', async () => {
    const owner = await devLogin(harness, uniqueEmail('int4-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `INT-4 WS ${randomSuffix()}`);
    const project = await createProject(
      harness,
      ws.accessToken,
      `INT-4 Proj ${randomSuffix()}`,
      uniqueSlug('int4'),
    );

    const createRes = await createPlatformKey(harness, ws.accessToken, {
      name: 'Idempotent Delete',
      scopes: ['workflows.execute'],
      projectIds: [project.id],
    });
    expect(createRes.status).toBe(201);

    // First DELETE succeeds
    const del1 = await requestJson<{ success: boolean }>(
      harness,
      `/api/keys/${createRes.body.id}?projectId=${project.id}`,
      { method: 'DELETE', headers: authHeaders(ws.accessToken) },
    );
    expect(del1.status).toBe(200);
    expect(del1.body.success).toBe(true);

    // Second DELETE returns 404 (revokedAt: null guard in query)
    const del2 = await requestJson<{ error: string }>(
      harness,
      `/api/keys/${createRes.body.id}?projectId=${project.id}`,
      { method: 'DELETE', headers: authHeaders(ws.accessToken) },
    );
    expect(del2.status).toBe(404);
  });

  // INT-5: Auth middleware rejects unauthenticated/unauthorized
  test('INT-5: auth middleware rejects missing and invalid tokens', async () => {
    // No auth header
    const noAuth = await requestJson<{ error: string }>(harness, '/api/keys?projectId=fake', {
      method: 'GET',
    });
    expect(noAuth.status).toBe(401);

    // Invalid token
    const badAuth = await requestJson<{ error: string }>(harness, '/api/keys?projectId=fake', {
      method: 'GET',
      headers: { Authorization: 'Bearer invalid-token-here' },
    });
    expect(badAuth.status).toBe(401);
  });

  // INT-6: Zod validation rejects malformed bodies
  test('INT-6: Zod validation rejects malformed request bodies', async () => {
    const owner = await devLogin(harness, uniqueEmail('int6-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `INT-6 WS ${randomSuffix()}`);
    const project = await createProject(
      harness,
      ws.accessToken,
      `INT-6 Proj ${randomSuffix()}`,
      uniqueSlug('int6'),
    );

    // Missing required fields
    const missingName = await requestJson<Record<string, unknown>>(harness, '/api/keys', {
      method: 'POST',
      headers: authHeaders(ws.accessToken),
      body: JSON.stringify({
        scopes: ['workflows.execute'],
        projectIds: [project.id],
      }),
    });
    expect(missingName.status).toBe(400);

    // Empty scopes array
    const emptyScopes = await requestJson<Record<string, unknown>>(harness, '/api/keys', {
      method: 'POST',
      headers: authHeaders(ws.accessToken),
      body: JSON.stringify({
        name: 'Bad Key',
        scopes: [],
        projectIds: [project.id],
      }),
    });
    expect(emptyScopes.status).toBe(400);

    // Empty projectIds array
    const emptyProjects = await requestJson<Record<string, unknown>>(harness, '/api/keys', {
      method: 'POST',
      headers: authHeaders(ws.accessToken),
      body: JSON.stringify({
        name: 'Bad Key',
        scopes: ['workflows.execute'],
        projectIds: [],
      }),
    });
    expect(emptyProjects.status).toBe(400);

    // Missing projectId on GET
    const missingProjectId = await requestJson<{ error: string }>(harness, '/api/keys', {
      method: 'GET',
      headers: authHeaders(ws.accessToken),
    });
    expect(missingProjectId.status).toBe(400);
    expect(missingProjectId.body.error).toBe('projectId is required');
  });

  // INT-7: tenantId scoping enforced at query level
  test('INT-7: tenant isolation enforced at query level', async () => {
    // Tenant A creates a key
    const ownerA = await devLogin(harness, uniqueEmail('int7-tenantA'));
    const wsA = await createWorkspace(harness, ownerA.accessToken, `INT-7 WS-A ${randomSuffix()}`);
    const projectA = await createProject(
      harness,
      wsA.accessToken,
      `INT-7 Proj-A ${randomSuffix()}`,
      uniqueSlug('int7a'),
    );

    const createRes = await createPlatformKey(harness, wsA.accessToken, {
      name: 'Tenant A Key',
      scopes: ['workflows.execute'],
      projectIds: [projectA.id],
    });
    expect(createRes.status).toBe(201);

    // Tenant B cannot see Tenant A's keys
    const ownerB = await devLogin(harness, uniqueEmail('int7-tenantB'));
    const wsB = await createWorkspace(harness, ownerB.accessToken, `INT-7 WS-B ${randomSuffix()}`);

    // Try to access via Tenant A's project — should be rejected by project access check
    const listRes = await listPlatformKeys(harness, wsB.accessToken, projectA.id);
    expect(listRes.status).toBe(404);

    // Tenant A can see their own key
    const listA = await listPlatformKeys(harness, wsA.accessToken, projectA.id);
    expect(listA.status).toBe(200);
    expect(listA.body.keys).toHaveLength(1);
  });

  // INT-8: 100-item safety cap enforced (direct DB insertMany)
  test('INT-8: GET list is capped at 100 keys', async () => {
    const owner = await devLogin(harness, uniqueEmail('int8-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `INT-8 WS ${randomSuffix()}`);
    const project = await createProject(
      harness,
      ws.accessToken,
      `INT-8 Proj ${randomSuffix()}`,
      uniqueSlug('int8'),
    );

    // Create one key via API to get the tenantId from the stored doc
    const seedRes = await createPlatformKey(harness, ws.accessToken, {
      name: 'Seed Key',
      scopes: ['workflows.execute'],
      projectIds: [project.id],
    });
    expect(seedRes.status).toBe(201);

    const { ApiKey } = await import('@agent-platform/database/models');
    const seedDoc = await ApiKey.findOne({ _id: seedRes.body.id }).lean();
    expect(seedDoc).not.toBeNull();
    const tenantId = seedDoc!.tenantId;

    // Bulk-insert 104 more keys directly in DB (total 105 with seed)
    const bulkKeys = Array.from({ length: 104 }, (_, i) => ({
      tenantId,
      name: `Bulk Key ${i}`,
      clientId: `plt-bulk-${crypto.randomUUID()}`,
      keyHash: crypto.randomBytes(32).toString('hex'),
      prefix: `abl_${crypto.randomBytes(2).toString('hex')}`,
      scopes: ['workflows.execute'],
      projectIds: [project.id],
      environments: [],
      expiresAt: null,
      createdBy: 'bulk-insert',
    }));
    await ApiKey.insertMany(bulkKeys);

    // API should cap at 100
    const listRes = await listPlatformKeys(harness, ws.accessToken, project.id);
    expect(listRes.status).toBe(200);
    expect(listRes.body.keys).toHaveLength(100);

    // Verify descending order by createdAt
    const dates = listRes.body.keys.map((k) => new Date(k.createdAt).getTime());
    for (let i = 0; i < dates.length - 1; i++) {
      expect(dates[i]).toBeGreaterThanOrEqual(dates[i + 1]);
    }
  });

  // INT-9: PATCH updates name/scopes, rejects projectIds change
  test('INT-9: PATCH updates allowed fields, rejects projectIds', async () => {
    const owner = await devLogin(harness, uniqueEmail('int9-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `INT-9 WS ${randomSuffix()}`);
    const project = await createProject(
      harness,
      ws.accessToken,
      `INT-9 Proj ${randomSuffix()}`,
      uniqueSlug('int9'),
    );

    const createRes = await createPlatformKey(harness, ws.accessToken, {
      name: 'Before Update',
      scopes: ['workflows.execute'],
      projectIds: [project.id],
    });
    expect(createRes.status).toBe(201);

    // Update name only
    const nameUpdate = await requestJson<PlatformKeyResponse>(
      harness,
      `/api/keys/${createRes.body.id}`,
      {
        method: 'PATCH',
        headers: authHeaders(ws.accessToken),
        body: JSON.stringify({ projectId: project.id, name: 'After Update' }),
      },
    );
    expect(nameUpdate.status).toBe(200);
    expect(nameUpdate.body.name).toBe('After Update');
    expect(nameUpdate.body.scopes).toEqual(['workflows.execute']); // unchanged

    // Update scopes only
    const scopeUpdate = await requestJson<PlatformKeyResponse>(
      harness,
      `/api/keys/${createRes.body.id}`,
      {
        method: 'PATCH',
        headers: authHeaders(ws.accessToken),
        body: JSON.stringify({
          projectId: project.id,
          scopes: ['workflows.execute', 'workflows.read'],
        }),
      },
    );
    expect(scopeUpdate.status).toBe(200);
    expect(scopeUpdate.body.scopes).toEqual(
      expect.arrayContaining(['workflows.execute', 'workflows.read']),
    );

    // PATCH with no update fields → 400
    const emptyUpdate = await requestJson<{ error: string }>(
      harness,
      `/api/keys/${createRes.body.id}`,
      {
        method: 'PATCH',
        headers: authHeaders(ws.accessToken),
        body: JSON.stringify({ projectId: project.id }),
      },
    );
    expect(emptyUpdate.status).toBe(400);
    expect(emptyUpdate.body.error).toBe('No fields to update');

    // Additional: non-existent key returns 404 for PATCH and DELETE
    const fakeKeyId = '000000000000000000000000';
    const patchGhost = await requestJson<{ error: string }>(harness, `/api/keys/${fakeKeyId}`, {
      method: 'PATCH',
      headers: authHeaders(ws.accessToken),
      body: JSON.stringify({ projectId: project.id, name: 'Ghost' }),
    });
    expect(patchGhost.status).toBe(404);
    expect(patchGhost.body.error).toBe('API key not found');

    const deleteGhost = await requestJson<{ error: string }>(
      harness,
      `/api/keys/${fakeKeyId}?projectId=${project.id}`,
      { method: 'DELETE', headers: authHeaders(ws.accessToken) },
    );
    expect(deleteGhost.status).toBe(404);
    expect(deleteGhost.body.error).toBe('API key not found');
  });

  // INT-10: Multi-project key stored with correct projectIds array
  test('INT-10: multi-project key stored and accessible from both projects', async () => {
    const owner = await devLogin(harness, uniqueEmail('int10-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `INT-10 WS ${randomSuffix()}`);
    const projectA = await createProject(
      harness,
      ws.accessToken,
      `INT-10 ProjA ${randomSuffix()}`,
      uniqueSlug('int10a'),
    );
    const projectB = await createProject(
      harness,
      ws.accessToken,
      `INT-10 ProjB ${randomSuffix()}`,
      uniqueSlug('int10b'),
    );

    const createRes = await createPlatformKey(harness, ws.accessToken, {
      name: 'Multi-Project',
      scopes: ['workflows.execute'],
      projectIds: [projectA.id, projectB.id],
    });
    expect(createRes.status).toBe(201);
    expect(createRes.body.projectIds).toHaveLength(2);
    expect(createRes.body.projectIds).toContain(projectA.id);
    expect(createRes.body.projectIds).toContain(projectB.id);

    // Accessible via project A
    const listA = await listPlatformKeys(harness, ws.accessToken, projectA.id);
    expect(listA.body.keys).toHaveLength(1);
    expect(listA.body.keys[0].projectIds).toContain(projectA.id);
    expect(listA.body.keys[0].projectIds).toContain(projectB.id);

    // Accessible via project B
    const listB = await listPlatformKeys(harness, ws.accessToken, projectB.id);
    expect(listB.body.keys).toHaveLength(1);
    expect(listB.body.keys[0].id).toBe(createRes.body.id);

    // Can be revoked from project A
    const revokeRes = await requestJson<{ success: boolean }>(
      harness,
      `/api/keys/${createRes.body.id}?projectId=${projectA.id}`,
      { method: 'DELETE', headers: authHeaders(ws.accessToken) },
    );
    expect(revokeRes.status).toBe(200);

    // No longer visible in either project
    const listAfterA = await listPlatformKeys(harness, ws.accessToken, projectA.id);
    expect(listAfterA.body.keys).toHaveLength(0);
    const listAfterB = await listPlatformKeys(harness, ws.accessToken, projectB.id);
    expect(listAfterB.body.keys).toHaveLength(0);
  });

  test('INT-11: scope registry validation accepts only registry-defined scopes', async () => {
    const owner = await devLogin(harness, uniqueEmail('int11-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `INT-11 WS ${randomSuffix()}`);
    const project = await createProject(
      harness,
      ws.accessToken,
      `INT-11 Proj ${randomSuffix()}`,
      uniqueSlug('int11'),
    );

    const validRes = await createPlatformKey(harness, ws.accessToken, {
      name: 'Registry Key',
      scopes: ['workflows.execute'],
      projectIds: [project.id],
    });
    expect(validRes.status).toBe(201);
    expect(validRes.body.scopes).toEqual(['workflows.execute']);

    const multiScopeRes = await createPlatformKey(harness, ws.accessToken, {
      name: 'Multi Scope',
      scopes: ['agents.read', 'sessions.read'],
      projectIds: [project.id],
    });
    expect(multiScopeRes.status).toBe(201);
    expect(multiScopeRes.body.scopes).toEqual(['agents.read', 'sessions.read']);

    const invalidRes = await createPlatformKey(harness, ws.accessToken, {
      name: 'Invalid',
      scopes: ['invalid.scope'],
      projectIds: [project.id],
    });
    expect(invalidRes.status).toBe(400);

    const mixedRes = await createPlatformKey(harness, ws.accessToken, {
      name: 'Mixed',
      scopes: ['workflows.execute', 'not.real'],
      projectIds: [project.id],
    });
    expect(mixedRes.status).toBe(400);

    const { ApiKey } = await import('@agent-platform/database/models');
    const doc = await ApiKey.findOne({ _id: validRes.body.id }).lean();
    expect(doc).not.toBeNull();
    expect(doc!.scopes).toEqual(['workflows.execute']);
  });

  test('INT-12: VIEWER scope ceiling is enforced before DB write', async () => {
    const owner = await devLogin(harness, uniqueEmail('int12-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `INT-12 WS ${randomSuffix()}`);
    const project = await createProject(
      harness,
      ws.accessToken,
      `INT-12 Proj ${randomSuffix()}`,
      uniqueSlug('int12'),
    );

    const viewerEmail = uniqueEmail('int12-viewer');
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
      name: 'Viewer Key',
      scopes: ['agents.write'],
      projectIds: [project.id],
    });
    expect(deniedRes.status).toBe(403);
    expect(deniedRes.body).toEqual({
      error: 'Scope ceiling exceeded',
      code: 'SCOPE_CEILING_EXCEEDED',
      denied: ['agents.write'],
    });

    const { ApiKey } = await import('@agent-platform/database/models');
    const deniedDoc = await ApiKey.findOne({ name: 'Viewer Key' }).lean();
    expect(deniedDoc).toBeNull();

    const ownerAllowedRes = await createPlatformKey(harness, ws.accessToken, {
      name: 'Owner Agents Write Key',
      scopes: ['agents.write'],
      projectIds: [project.id],
    });
    expect(ownerAllowedRes.status).toBe(201);
  });

  test('INT-13: ceiling check covers viewer, member, operator, admin, and owner roles', async () => {
    const owner = await devLogin(harness, uniqueEmail('int13-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `INT-13 WS ${randomSuffix()}`);
    const project = await createProject(
      harness,
      ws.accessToken,
      `INT-13 Proj ${randomSuffix()}`,
      uniqueSlug('int13'),
    );

    const viewerEmail = uniqueEmail('int13-viewer');
    const memberEmail = uniqueEmail('int13-member');
    const operatorEmail = uniqueEmail('int13-operator');
    const adminEmail = uniqueEmail('int13-admin');

    expect(
      (
        await inviteWorkspaceMember(
          harness,
          ws.accessToken,
          project.tenantId,
          viewerEmail,
          'VIEWER',
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await inviteWorkspaceMember(
          harness,
          ws.accessToken,
          project.tenantId,
          memberEmail,
          'MEMBER',
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await inviteWorkspaceMember(
          harness,
          ws.accessToken,
          project.tenantId,
          operatorEmail,
          'OPERATOR',
        )
      ).status,
    ).toBe(201);
    expect(
      (await inviteWorkspaceMember(harness, ws.accessToken, project.tenantId, adminEmail, 'ADMIN'))
        .status,
    ).toBe(201);

    const viewer = await devLogin(harness, viewerEmail);
    const member = await devLogin(harness, memberEmail);
    const operator = await devLogin(harness, operatorEmail);
    const admin = await devLogin(harness, adminEmail);

    expect(
      (await addProjectMember(harness, ws.accessToken, project.id, viewer.user.id, 'developer'))
        .status,
    ).toBe(201);
    expect(
      (await addProjectMember(harness, ws.accessToken, project.id, member.user.id, 'developer'))
        .status,
    ).toBe(201);
    expect(
      (await addProjectMember(harness, ws.accessToken, project.id, operator.user.id, 'developer'))
        .status,
    ).toBe(201);

    expect(
      (
        await createPlatformKey(harness, viewer.accessToken, {
          name: 'Viewer Denied',
          scopes: ['agents.write'],
          projectIds: [project.id],
        })
      ).status,
    ).toBe(403);

    expect(
      (
        await createPlatformKey(harness, operator.accessToken, {
          name: 'Operator Allowed',
          scopes: ['workflows.execute'],
          projectIds: [project.id],
        })
      ).status,
    ).toBe(201);

    expect(
      (
        await createPlatformKey(harness, member.accessToken, {
          name: 'Member Denied',
          scopes: ['workflows.execute'],
          projectIds: [project.id],
        })
      ).status,
    ).toBe(403);

    const adminDenied = await createPlatformKey(harness, admin.accessToken, {
      name: 'Admin Analytics Denied',
      scopes: ['analytics.read'],
      projectIds: [project.id],
    });
    expect(adminDenied.status).toBe(403);
    expect(adminDenied.body).toEqual({
      error: 'Scope ceiling exceeded',
      code: 'SCOPE_CEILING_EXCEEDED',
      denied: ['analytics.read'],
    });

    const ownerAllScopes = await createPlatformKey(harness, ws.accessToken, {
      name: 'Owner All Scopes',
      scopes: [...ALL_PLATFORM_KEY_SCOPES],
      projectIds: [project.id],
    });
    expect(ownerAllScopes.status).toBe(201);
    expect(ownerAllScopes.body.scopes).toEqual([...ALL_PLATFORM_KEY_SCOPES]);
  });

  test('INT-14: PATCH ceiling check prevents scope escalation and preserves stored scopes', async () => {
    const owner = await devLogin(harness, uniqueEmail('int14-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `INT-14 WS ${randomSuffix()}`);
    const project = await createProject(
      harness,
      ws.accessToken,
      `INT-14 Proj ${randomSuffix()}`,
      uniqueSlug('int14'),
    );

    const operatorEmail = uniqueEmail('int14-operator');
    expect(
      (
        await inviteWorkspaceMember(
          harness,
          ws.accessToken,
          project.tenantId,
          operatorEmail,
          'OPERATOR',
        )
      ).status,
    ).toBe(201);

    const operator = await devLogin(harness, operatorEmail);
    expect(
      (await addProjectMember(harness, ws.accessToken, project.id, operator.user.id, 'developer'))
        .status,
    ).toBe(201);

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

    const { ApiKey } = await import('@agent-platform/database/models');
    const unchangedDoc = await ApiKey.findOne({ _id: createRes.body.id }).lean();
    expect(unchangedDoc!.scopes).toEqual(['workflows.execute']);

    const allowedPatch = await requestJson<PlatformKeyResponse>(
      harness,
      `/api/keys/${createRes.body.id}`,
      {
        method: 'PATCH',
        headers: authHeaders(operator.accessToken),
        body: JSON.stringify({
          projectId: project.id,
          scopes: ['workflows.execute', 'workflows.read'],
        }),
      },
    );
    expect(allowedPatch.status).toBe(200);
    expect(allowedPatch.body.scopes).toEqual(['workflows.execute', 'workflows.read']);

    const updatedDoc = await ApiKey.findOne({ _id: createRes.body.id }).lean();
    expect(updatedDoc!.scopes).toEqual(['workflows.execute', 'workflows.read']);
  });

  test('INT-16: scopes endpoint returns the registry without internal permission mappings', async () => {
    const owner = await devLogin(harness, uniqueEmail('int16-owner'));
    const ws = await createWorkspace(harness, owner.accessToken, `INT-16 WS ${randomSuffix()}`);
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
    expect(new Set(scopesRes.body.scopes.map((scope) => scope.category))).toEqual(
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
