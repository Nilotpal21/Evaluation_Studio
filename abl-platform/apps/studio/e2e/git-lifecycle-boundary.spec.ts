/**
 * Thin Git integration E2E boundary sentinels for ABLP-976.
 *
 * These tests intentionally stay API-only and avoid direct database access.
 * The broad lifecycle truth table lives in focused Vitest suites; this file
 * proves the real Studio transport and middleware path for the highest-risk
 * Git setup boundaries.
 *
 * Run against an existing Studio server:
 *   ABLP976_GIT_E2E=1 npx playwright test -c e2e/playwright-git.config.ts e2e/git-lifecycle-boundary.spec.ts
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import { env, getDevAccessToken } from './helpers';

interface ProjectListItem {
  id: string;
  name: string;
}

interface ProjectResponseBody {
  project?: ProjectListItem;
}

interface ProjectListResponseBody {
  projects?: ProjectListItem[];
}

interface GitResponseBody {
  error?: string;
  code?: string;
  integration?: {
    id?: string;
    provider?: string;
    repositoryUrl?: string;
    authProfileId?: string | null;
  } | null;
}

const RUN_STATEFUL_GIT_E2E = process.env.ABLP976_GIT_E2E === '1';
const HAS_STUDIO_DATABASE = Boolean(process.env.DATABASE_URL);
const TEST_USER_EMAIL = 'ablp-976-git-boundary@e2e-smoke.test';
const TEST_USER_NAME = 'ABLP-976 Git Boundary';

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'X-Tenant-Id': env.tenantId,
  };
}

async function responseBody<T>(response: { json: () => Promise<unknown> }): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

async function createProject(request: APIRequestContext, token: string): Promise<ProjectListItem> {
  const suffix = Date.now().toString(36);
  const response = await request.post(`${env.baseUrl}/api/projects`, {
    headers: {
      ...authHeaders(token),
      'Content-Type': 'application/json',
    },
    data: {
      name: `ABLP 976 Git Boundary ${suffix}`,
      slug: `ablp-976-git-boundary-${suffix}`,
      description: 'E2E boundary sentinel for Git integration setup.',
    },
  });

  expect(response.status()).toBe(201);
  const body = await responseBody<ProjectResponseBody>(response);
  expect(body.project?.id).toBeTruthy();
  return body.project as ProjectListItem;
}

async function findOrCreateProject(
  request: APIRequestContext,
  token: string,
): Promise<{ project: ProjectListItem; created: boolean }> {
  const list = await request.get(`${env.baseUrl}/api/projects`, {
    headers: authHeaders(token),
  });
  expect(list.status()).toBe(200);

  const body = await responseBody<ProjectListResponseBody>(list);
  const existing = body.projects?.find((project) =>
    project.name.startsWith('ABLP 976 Git Boundary'),
  );
  if (existing) {
    return { project: existing, created: false };
  }

  return { project: await createProject(request, token), created: true };
}

test.describe('Git Integration ABLP-976 boundary E2E', () => {
  let accessToken = '';
  let projectId = '';
  let createdProject = false;

  test('requires authentication before Git integration reads reach project lookup', async ({
    request,
  }) => {
    const response = await request.get(`${env.baseUrl}/api/projects/project-does-not-matter/git`);
    expect(response.status()).toBe(401);
  });

  test('returns non-leaky 404 for webhooks targeting unknown projects', async ({ request }) => {
    test.skip(!HAS_STUDIO_DATABASE, 'Requires DATABASE_URL for real webhook project lookup.');

    const response = await request.post(`${env.baseUrl}/api/webhooks/git/project-does-not-exist`, {
      headers: {
        'Content-Type': 'application/json',
        Origin: env.baseUrl,
        'x-github-event': 'push',
        'x-github-delivery': 'ablp-976-boundary-delivery',
      },
      data: {
        ref: 'refs/heads/main',
        after: 'abc123',
        commits: [{ modified: ['agents/support.agent.abl'] }],
      },
    });

    expect(response.status()).toBe(404);
    const body = await responseBody<GitResponseBody>(response);
    expect(JSON.stringify(body)).not.toContain('tenant');
    expect(JSON.stringify(body)).not.toContain('project-does-not-exist');
  });

  test.describe('stateful authenticated Git setup sentinels', () => {
    test.skip(
      !RUN_STATEFUL_GIT_E2E,
      'Set ABLP976_GIT_E2E=1 to run authenticated Git setup boundary checks.',
    );

    test.beforeAll(async ({ browser, request }) => {
      const page = await browser.newPage();
      accessToken = await getDevAccessToken(page, {
        baseUrl: env.baseUrl,
        email: TEST_USER_EMAIL,
        name: TEST_USER_NAME,
      });
      await page.close();

      expect(accessToken).toBeTruthy();
      const result = await findOrCreateProject(request, accessToken);
      projectId = result.project.id;
      createdProject = result.created;
    });

    test.afterAll(async ({ request }) => {
      if (!accessToken || !createdProject || !projectId) {
        return;
      }

      await request.delete(`${env.baseUrl}/api/projects/${projectId}`, {
        headers: authHeaders(accessToken),
      });
    });

    test('rejects credential-bearing repository URLs before persistence', async ({ request }) => {
      const response = await request.post(`${env.baseUrl}/api/projects/${projectId}/git`, {
        headers: {
          ...authHeaders(accessToken),
          'Content-Type': 'application/json',
        },
        data: {
          provider: 'github',
          repositoryUrl: 'https://token-secret@github.com/acme/support-agents',
          defaultBranch: 'main',
          syncPath: '/agents',
          authProfileId: 'e2e-auth-profile-id',
          syncConfig: { autoSync: false, conflictStrategy: 'ours' },
        },
      });

      expect(response.status()).toBe(400);
      const body = await responseBody<GitResponseBody>(response);
      expect(body.error).toBe('Invalid repository URL');
      expect(JSON.stringify(body)).not.toContain('token-secret');

      const readBack = await request.get(`${env.baseUrl}/api/projects/${projectId}/git`, {
        headers: authHeaders(accessToken),
      });
      expect(readBack.status()).toBe(200);
      const readBackBody = await responseBody<GitResponseBody>(readBack);
      expect(readBackBody.integration).toBeNull();
    });

    test('rejects unsafe syncPath values before provider validation', async ({ request }) => {
      const response = await request.post(`${env.baseUrl}/api/projects/${projectId}/git`, {
        headers: {
          ...authHeaders(accessToken),
          'Content-Type': 'application/json',
        },
        data: {
          provider: 'github',
          repositoryUrl: 'https://github.com/acme/support-agents',
          defaultBranch: 'main',
          syncPath: '/../agents',
          authProfileId: 'e2e-auth-profile-id',
          syncConfig: { autoSync: false, conflictStrategy: 'theirs' },
        },
      });

      expect(response.status()).toBe(400);
      const body = await responseBody<GitResponseBody>(response);
      expect(body.error).toBe('Invalid syncPath');

      const readBack = await request.get(`${env.baseUrl}/api/projects/${projectId}/git`, {
        headers: authHeaders(accessToken),
      });
      expect(readBack.status()).toBe(200);
      const readBackBody = await responseBody<GitResponseBody>(readBack);
      expect(readBackBody.integration).toBeNull();
    });
  });
});
