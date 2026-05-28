import http from 'k6/http';
import { check } from 'k6';
import { config, studioApiPath } from '../lib/config.ts';
import { getAuthToken, makeAuthHeaders } from '../lib/auth.ts';
import { assertStatus, httpWithRetry } from './helpers.ts';

export interface TenantSetupResult {
  accessToken: string;
  userId: string;
  tenantId: string;
  projectId: string;
}

const PROJECT_NAME = 'benchmark-project';
const PROJECT_DESCRIPTION = 'Auto-created by k6 benchmark bootstrap';

export function bootstrapTenant(): TenantSetupResult {
  const studioUrl = config.studioUrl;

  // Step 1: Get auth token (uses AUTH_TOKEN env var, or falls back to dev-login)
  const accessToken = getAuthToken();
  const headers = makeAuthHeaders(accessToken);
  const userId = config.devLoginUserId;

  // Step 2: List projects and resolve which one to use
  const listRes = http.get(`${studioUrl}${studioApiPath('/projects')}`, { headers });
  assertStatus(listRes, [200], 'list-projects');

  const listBody = listRes.json() as {
    success: boolean;
    projects: Array<{ id: string; name: string; slug: string }>;
  };

  // Step 2a: If PROJECT_ID is explicitly configured, verify it exists
  const configuredProjectId = config.projectId;
  if (configuredProjectId && configuredProjectId !== 'benchmark-project') {
    const found = listBody.projects?.find((p) => p.id === configuredProjectId);
    if (found) {
      console.log(`[bootstrap-tenant] Using configured PROJECT_ID: ${found.id} (${found.name})`);
      return { accessToken, userId, tenantId: config.tenantId, projectId: found.id };
    }
    console.warn(
      `[bootstrap-tenant] Configured PROJECT_ID ${configuredProjectId} not found — falling back to name lookup`,
    );
  }

  // Step 2b: Check if benchmark project already exists by name
  const existing = listBody.projects?.find((p) => p.name === PROJECT_NAME);

  if (existing) {
    console.log(`[bootstrap-tenant] Reusing existing project: ${existing.id}`);
    return { accessToken, userId, tenantId: config.tenantId, projectId: existing.id };
  }

  // Step 3: Create new benchmark project
  const createRes = httpWithRetry(
    'POST',
    `${studioUrl}${studioApiPath('/projects')}`,
    JSON.stringify({
      name: PROJECT_NAME,
      slug: 'benchmark-project',
      description: PROJECT_DESCRIPTION,
    }),
    headers,
    { label: 'create-project' },
  );

  const createOk = check(createRes, {
    'create project returns 201': (r) => r.status === 201,
  });

  if (!createOk) {
    throw new Error(`Create project failed: ${createRes.status} ${createRes.body}`);
  }

  const createBody = createRes.json() as {
    success: boolean;
    project: { id: string; tenantId: string; name: string };
  };

  console.log(`[bootstrap-tenant] Created project: ${createBody.project.id}`);

  return {
    accessToken,
    userId,
    tenantId: createBody.project.tenantId,
    projectId: createBody.project.id,
  };
}
