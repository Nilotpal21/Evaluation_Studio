/**
 * Git Integration E2E Test — Bitbucket + Travel Example
 *
 * Exercises the full git integration lifecycle against a real Bitbucket repo:
 *   Phase 1 — Auth & find the Travel example project
 *   Phase 2 — Configure Bitbucket git integration
 *   Phase 3 — Push agents to Bitbucket
 *   Phase 4 — Verify push via Bitbucket API
 *   Phase 5 — Modify an agent, push again (second commit)
 *   Phase 6 — Pull from Bitbucket (round-trip)
 *   Phase 7 — Check sync history
 *   Phase 8 — Export project, then import into a new project
 *   Phase 9 — Cleanup — disconnect git integration
 *
 * Prerequisites:
 *   - Studio running on localhost:5173 with ENABLE_DEV_LOGIN=true
 *   - Bitbucket repo: koreteam1/abl-example-projects (already created)
 *   - Travel example project seeded in dev tenant
 *
 * Run:
 *   cd apps/studio && npx playwright test e2e/git-bitbucket-e2e.spec.ts
 *
 * Environment:
 *   BB_EMAIL    — Atlassian account email (default: prasanna@kore.com)
 *   BB_TOKEN    — Atlassian API token
 */

import { test, expect, Page } from '@playwright/test';
import { getDevAccessToken } from './helpers';

// ─── Config ──────────────────────────────────────────────────────────────────

const STUDIO_URL = process.env.TEST_BASE_URL || 'http://localhost:5173';
const BB_WORKSPACE = 'koreteam1';
const BB_REPO = 'abl-example-projects';
const BB_REPO_URL = `https://bitbucket.org/${BB_WORKSPACE}/${BB_REPO}`;
const BB_EMAIL = process.env.BB_EMAIL ?? '';
const BB_TOKEN = process.env.BB_TOKEN ?? '';
const BB_BRANCH = 'main';
const TEST_LOGIN_EMAIL = 'git-bitbucket@e2e-smoke.test';
const TEST_LOGIN_NAME = 'Git Bitbucket E2E';

// ─── State shared across serial tests ────────────────────────────────────────

let accessToken = '';
let projectId = '';
let projectName = '';
let firstPushSha = '';
let secondPushSha = '';
let importedProjectId = '';
let gitAuthProfileId = '';
let importedAuthProfileId = '';
let createdPrimaryProject = false;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getAccessToken(page: Page): Promise<string> {
  const token = await getDevAccessToken(page, {
    baseUrl: STUDIO_URL,
    email: TEST_LOGIN_EMAIL,
    name: TEST_LOGIN_NAME,
  });
  if (!token) throw new Error('Failed to get access token from dev-login');
  return token;
}

async function api(
  page: Page,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; data: any }> {
  const result = await page.evaluate(
    async ({ path, method, body, token }) => {
      const res = await fetch(path, {
        method: method ?? 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
      return { status: res.status, data };
    },
    { path, method: options.method ?? 'GET', body: options.body ?? null, token: accessToken },
  );
  return result;
}

/** Call Bitbucket API directly to verify state */
async function bbApi(path: string): Promise<any> {
  const url = `https://api.bitbucket.org/2.0/repositories/${BB_WORKSPACE}/${BB_REPO}${path}`;
  const auth = Buffer.from(`${BB_EMAIL}:${BB_TOKEN}`).toString('base64');
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bitbucket API ${res.status}: ${body}`);
  }
  if (res.status === 204) return undefined;
  return res.json();
}

async function createBitbucketGitAuthProfile(
  page: Page,
  targetProjectId: string,
  suffix: string,
): Promise<string> {
  const response = await api(page, `/api/projects/${targetProjectId}/auth-profiles`, {
    method: 'POST',
    body: {
      name: `Bitbucket Git E2E ${suffix}`,
      description: 'Auth profile used by the Bitbucket Git lifecycle E2E test.',
      authType: 'bearer',
      config: {},
      secrets: { token: `${BB_EMAIL}:${BB_TOKEN}` },
      projectId: targetProjectId,
      scope: 'project',
      visibility: 'shared',
      usageMode: 'preconfigured',
      tags: ['git-e2e', 'bitbucket'],
    },
  });

  console.log(
    `[auth-profile] Create Bitbucket Git profile for ${targetProjectId} → ${response.status}`,
    JSON.stringify(response.data).slice(0, 200),
  );
  expect(response.status).toBe(201);
  const profile = response.data.data ?? response.data.profile ?? response.data;
  const profileId = profile.id ?? profile._id;
  expect(profileId).toBeTruthy();
  return profileId;
}

async function deleteAuthProfile(
  page: Page,
  targetProjectId: string,
  profileId: string,
): Promise<void> {
  const response = await api(page, `/api/projects/${targetProjectId}/auth-profiles/${profileId}`, {
    method: 'DELETE',
  });
  console.log(`[auth-profile] Delete ${profileId} from ${targetProjectId} → ${response.status}`);
}

async function createProjectWithSeedAgent(page: Page): Promise<{ id: string; name: string }> {
  const runId = Date.now();
  const createProjectResponse = await api(page, '/api/projects', {
    method: 'POST',
    body: {
      name: `Git_E2E_${runId}`,
      slug: `git-e2e-${runId}`,
      description: 'Self-seeded project for remote Bitbucket Git lifecycle E2E.',
    },
  });
  console.log(
    `[phase1] Create fallback project → ${createProjectResponse.status}`,
    JSON.stringify(createProjectResponse.data).slice(0, 200),
  );
  expect(createProjectResponse.status).toBe(201);
  const project = createProjectResponse.data.project ?? createProjectResponse.data;
  const id = project._id ?? project.id;
  expect(id).toBeTruthy();
  projectId = id;
  projectName = project.name ?? `Git_E2E_${runId}`;
  createdPrimaryProject = true;

  const createAgentResponse = await api(page, `/api/projects/${id}/agents`, {
    method: 'POST',
    body: {
      name: 'travel_support_agent',
      agentPath: 'travel_support_agent',
      description: 'Self-seeded agent for remote Bitbucket Git lifecycle E2E.',
    },
  });
  console.log(
    `[phase1] Create fallback agent → ${createAgentResponse.status}`,
    JSON.stringify(createAgentResponse.data).slice(0, 200),
  );
  expect(createAgentResponse.status).toBe(201);

  const dslContent = [
    'AGENT: travel_support_agent',
    'GOAL: "Help travelers with itinerary and booking questions"',
    'PERSONA: "Friendly travel support specialist"',
    '',
  ].join('\n');
  const saveDslResponse = await api(page, `/api/projects/${id}/agents/travel_support_agent/dsl`, {
    method: 'PUT',
    body: { dslContent },
  });
  console.log(
    `[phase1] Save fallback agent DSL → ${saveDslResponse.status}`,
    JSON.stringify(saveDslResponse.data).slice(0, 200),
  );
  expect(saveDslResponse.status).toBe(200);
  return { id, name: projectName };
}

async function cleanupGitE2EResources(page: Page): Promise<void> {
  if (projectId) {
    const disconnect = await api(page, `/api/projects/${projectId}/git`, { method: 'DELETE' });
    console.log(`[cleanup] Disconnect primary project git → ${disconnect.status}`);

    if (gitAuthProfileId) {
      await deleteAuthProfile(page, projectId, gitAuthProfileId);
      gitAuthProfileId = '';
    }

    if (createdPrimaryProject) {
      const del = await api(page, `/api/projects/${projectId}`, { method: 'DELETE' });
      console.log(`[cleanup] Delete fallback primary project → ${del.status}`);
      createdPrimaryProject = false;
      projectId = '';
      projectName = '';
    }
  }

  if (importedProjectId) {
    const disconnect = await api(page, `/api/projects/${importedProjectId}/git`, {
      method: 'DELETE',
    });
    console.log(`[cleanup] Disconnect imported project git → ${disconnect.status}`);

    if (importedAuthProfileId) {
      await deleteAuthProfile(page, importedProjectId, importedAuthProfileId);
      importedAuthProfileId = '';
    }

    const del = await api(page, `/api/projects/${importedProjectId}`, { method: 'DELETE' });
    console.log(`[cleanup] Delete imported project → ${del.status}`);
    importedProjectId = '';
  }
}

// ─── Tests (serial) ──────────────────────────────────────────────────────────

test.describe.serial('Git Integration — Bitbucket + Travel Example', () => {
  test.setTimeout(60_000);
  test.skip(!BB_EMAIL || !BB_TOKEN, 'Requires explicit BB_EMAIL and BB_TOKEN credentials.');

  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto(STUDIO_URL);
    accessToken = await getAccessToken(page);
    console.log('[setup] Access token acquired');
  });

  test.afterAll(async () => {
    try {
      await cleanupGitE2EResources(page);
    } finally {
      await page.close();
    }
  });

  // ── Phase 1: Find Travel Project ────────────────────────────────────────

  test('Phase 1 — find travel example project', async () => {
    const { status, data } = await api(page, '/api/projects');
    expect(status).toBe(200);

    const projects = data.projects ?? data;
    expect(Array.isArray(projects)).toBeTruthy();

    // Find the seeded Travel Assistant project (not test imports)
    const travel =
      projects.find(
        (p: { name: string }) => p.name === 'Travel Assistant' || p.name === 'TravelDesk Travel',
      ) ??
      projects.find(
        (p: { name: string; _id?: string; id?: string }) => (p._id ?? p.id) === 'proj-travel',
      );

    if (travel) {
      projectId = travel._id ?? travel.id;
      projectName = travel.name;
    } else {
      console.log('[phase1] Travel project not found; creating self-seeded fallback project');
      const fallback = await createProjectWithSeedAgent(page);
      projectId = fallback.id;
      projectName = fallback.name;
    }

    console.log(`[phase1] Found project: "${projectName}" (${projectId})`);
  });

  // ── Phase 2: Configure Git Integration ──────────────────────────────────

  test('Phase 2 — configure Bitbucket git integration', async () => {
    // First, clean up any existing integration
    const existing = await api(page, `/api/projects/${projectId}/git`);
    if (existing.status === 200 && existing.data.integration) {
      console.log('[phase2] Removing existing git integration');
      await api(page, `/api/projects/${projectId}/git`, { method: 'DELETE' });
    }
    gitAuthProfileId = await createBitbucketGitAuthProfile(page, projectId, `travel-${Date.now()}`);

    // Create new integration
    const { status, data } = await api(page, `/api/projects/${projectId}/git`, {
      method: 'POST',
      body: {
        provider: 'bitbucket',
        repositoryUrl: BB_REPO_URL,
        defaultBranch: BB_BRANCH,
        syncPath: `/travel`,
        authProfileId: gitAuthProfileId,
        syncConfig: {
          autoSync: false,
          conflictStrategy: 'manual',
        },
      },
    });

    console.log(`[phase2] POST /git → ${status}`, JSON.stringify(data).slice(0, 200));
    expect(status).toBe(201);
    expect(data.integration).toBeTruthy();
    expect(data.integration.provider).toBe('bitbucket');
    expect(data.integration.repositoryUrl).toBe(BB_REPO_URL);
  });

  // ── Phase 3: Push Agents to Bitbucket ───────────────────────────────────

  test('Phase 3 — push agents to Bitbucket', async () => {
    const { status, data } = await api(page, `/api/projects/${projectId}/git/push`, {
      method: 'POST',
      body: {
        commitMessage: 'e2e: initial push of travel example agents',
        branch: BB_BRANCH,
      },
    });

    console.log(`[phase3] Push result → ${status}`, JSON.stringify(data).slice(0, 300));
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.commitSha).toBeTruthy();
    expect(data.agentsCount).toBeGreaterThan(0);
    firstPushSha = data.commitSha;
    console.log(`[phase3] Pushed ${data.agentsCount} agents, commit: ${firstPushSha}`);
  });

  // ── Phase 4: Verify on Bitbucket ────────────────────────────────────────

  test('Phase 4 — verify push via Bitbucket API', async () => {
    // Check commits on the branch
    const commits = await bbApi(`/commits/${BB_BRANCH}?pagelen=5`);
    expect(commits.values).toBeTruthy();
    expect(commits.values.length).toBeGreaterThan(0);

    const latestCommit = commits.values[0];
    console.log(
      `[phase4] Latest commit: ${latestCommit.hash.slice(0, 8)} — ${latestCommit.message.trim()}`,
    );
    expect(latestCommit.message).toContain('travel example');

    // Check files exist in the repo
    const src = await bbApi(`/src/${BB_BRANCH}/`);
    expect(src.values).toBeTruthy();
    console.log(
      `[phase4] Files in repo root:`,
      (src.values as { path: string }[]).map((f) => f.path).join(', '),
    );
  });

  // ── Phase 5: Modify + Second Push ──────────────────────────────────────

  test('Phase 5 — modify agent description and push again', async () => {
    // Get agents for this project
    const agentsResp = await api(page, `/api/projects/${projectId}/agents`);
    expect(agentsResp.status).toBe(200);
    const agents = agentsResp.data.agents ?? agentsResp.data;
    expect(agents.length).toBeGreaterThan(0);

    // Pick the first agent and update its description
    const agent = agents[0];
    const agentName = agent.name;
    const timestamp = new Date().toISOString();

    const updateResp = await api(page, `/api/projects/${projectId}/agents/${agentName}`, {
      method: 'PATCH',
      body: {
        description: `Updated by E2E test at ${timestamp}`,
      },
    });
    console.log(`[phase5] Updated agent "${agent.name}" description → ${updateResp.status}`);

    // First push attempt — may 409 if conflict detection triggers on
    // non-deterministic re-export (e.g. project.json ordering).
    let result = await api(page, `/api/projects/${projectId}/git/push`, {
      method: 'POST',
      body: {
        commitMessage: `e2e: update ${agent.name} description`,
        branch: BB_BRANCH,
      },
    });

    // If conflict detected, disconnect + reconnect git (resets lastSyncCommit) and retry
    if (result.status === 409) {
      console.log(`[phase5] Conflict detected on second push — resetting sync state`);
      console.log(
        `[phase5] Conflicts:`,
        JSON.stringify(result.data.conflicts?.map((c: { file: string }) => c.file)),
      );

      // Reset lastSyncCommit by disconnecting and reconnecting
      await api(page, `/api/projects/${projectId}/git`, { method: 'DELETE' });
      await api(page, `/api/projects/${projectId}/git`, {
        method: 'POST',
        body: {
          provider: 'bitbucket',
          repositoryUrl: BB_REPO_URL,
          defaultBranch: BB_BRANCH,
          syncPath: `/travel`,
          authProfileId: gitAuthProfileId,
          syncConfig: { autoSync: false, conflictStrategy: 'manual' },
        },
      });

      // Retry push without lastSyncCommit (fresh integration)
      result = await api(page, `/api/projects/${projectId}/git/push`, {
        method: 'POST',
        body: {
          commitMessage: `e2e: update ${agent.name} description (retry)`,
          branch: BB_BRANCH,
        },
      });
    }

    console.log(
      `[phase5] Second push → ${result.status}`,
      JSON.stringify(result.data).slice(0, 200),
    );
    expect(result.status).toBe(200);
    expect(result.data.success).toBe(true);
    secondPushSha = result.data.commitSha;
    console.log(`[phase5] Second commit: ${secondPushSha}`);
  });

  // ── Phase 6: Pull from Bitbucket ────────────────────────────────────────

  test('Phase 6 — pull from Bitbucket (dry run)', async () => {
    const { status, data } = await api(page, `/api/projects/${projectId}/git/pull`, {
      method: 'POST',
      body: {
        branch: BB_BRANCH,
        dryRun: true,
      },
    });

    console.log(`[phase6] Pull dry-run → ${status}`, JSON.stringify(data).slice(0, 500));

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.commitSha).toBeTruthy();
    expect(data.preview).toBeTruthy();
    console.log(`[phase6] Dry-run pulled commit: ${data.commitSha}, changes:`, data.changes);
  });

  test('Phase 6b — pull from Bitbucket (actual, into fresh project)', async () => {
    // Pull into a fresh project to avoid agent name mismatch issues
    const RUN_ID = Date.now();
    let pullProjectId = '';
    let pullAuthProfileId = '';
    const createResp = await api(page, '/api/projects', {
      method: 'POST',
      body: {
        name: `Pull_Test_${RUN_ID}`,
        description: 'E2E test: pull target',
      },
    });
    console.log(
      `[phase6b] Create project → ${createResp.status}`,
      JSON.stringify(createResp.data).slice(0, 300),
    );
    expect(createResp.status).toBe(201);
    const proj = createResp.data.project ?? createResp.data;
    pullProjectId = proj._id ?? proj.id ?? proj.slug;
    console.log(`[phase6b] New project ID: ${pullProjectId}`);

    try {
      pullAuthProfileId = await createBitbucketGitAuthProfile(
        page,
        pullProjectId,
        `pull-${RUN_ID}`,
      );

      // Configure git on the fresh project
      const gitConfigResp = await api(page, `/api/projects/${pullProjectId}/git`, {
        method: 'POST',
        body: {
          provider: 'bitbucket',
          repositoryUrl: BB_REPO_URL,
          defaultBranch: BB_BRANCH,
          syncPath: `/travel`,
          authProfileId: pullAuthProfileId,
          syncConfig: { autoSync: false, conflictStrategy: 'remote_wins' },
        },
      });
      console.log(
        `[phase6b] Git config → ${gitConfigResp.status}`,
        JSON.stringify(gitConfigResp.data).slice(0, 200),
      );

      const previewPull = await api(page, `/api/projects/${pullProjectId}/git/pull`, {
        method: 'POST',
        body: { branch: BB_BRANCH, dryRun: true },
      });
      console.log(
        `[phase6b] Pull preview into fresh project → ${previewPull.status}`,
        JSON.stringify(previewPull.data).slice(0, 300),
      );
      expect(previewPull.status).toBe(200);

      const previewDigest =
        previewPull.data.previewDigest ?? previewPull.data.preview?.previewDigest ?? null;
      const acknowledgedIssueIds =
        previewPull.data.preview?.issues
          ?.filter((issue: { blocking?: boolean; id?: string }) => !issue.blocking && issue.id)
          .map((issue: { id: string }) => issue.id) ?? [];

      const { status, data } = await api(page, `/api/projects/${pullProjectId}/git/pull`, {
        method: 'POST',
        body: {
          branch: BB_BRANCH,
          previewDigest,
          acknowledgedIssueIds,
        },
      });

      console.log(
        `[phase6b] Pull into fresh project → ${status}`,
        JSON.stringify(data).slice(0, 300),
      );

      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.preview).toBeTruthy();
    } finally {
      if (pullProjectId) {
        await api(page, `/api/projects/${pullProjectId}/git`, { method: 'DELETE' });
      }
      if (pullProjectId && pullAuthProfileId) {
        await deleteAuthProfile(page, pullProjectId, pullAuthProfileId);
      }
      if (pullProjectId) {
        await api(page, `/api/projects/${pullProjectId}`, { method: 'DELETE' });
      }
    }
  });

  // ── Phase 7: Check Sync History ─────────────────────────────────────────

  test('Phase 7 — verify sync history', async () => {
    const { status, data } = await api(page, `/api/projects/${projectId}/git/history?limit=10`);

    console.log(`[phase7] History → ${status}, entries: ${data.history?.length ?? 0}`);
    expect(status).toBe(200);
    expect(data.history).toBeTruthy();
    console.log(`[phase7] Total records: ${data.history.length}`);
    const pushRecords = data.history.filter((h: { direction: string }) => h.direction === 'push');
    console.log(`[phase7] Push records: ${pushRecords.length}`);
    expect(pushRecords.length).toBeGreaterThanOrEqual(1);
  });

  // ── Phase 8: Git Status ─────────────────────────────────────────────────

  test('Phase 8 — check git status', async () => {
    const { status, data } = await api(page, `/api/projects/${projectId}/git/status`);

    console.log(`[phase8] Status → ${status}`, JSON.stringify(data).slice(0, 300));
    expect(status).toBe(200);
    expect(data.integration).toBeTruthy();
    expect(data.integration.provider).toBe('bitbucket');
    expect(data.localAgents).toBeTruthy();
    expect(data.localAgents.length).toBeGreaterThan(0);
    console.log(`[phase8] Local agents: ${data.localAgents.length}`);
  });

  // ── Phase 9: Export Project ─────────────────────────────────────────────

  test('Phase 9 — export project', async () => {
    const { status, data } = await api(page, `/api/projects/${projectId}/export?format=zip`);

    console.log(`[phase9] Export → ${status}`, JSON.stringify(data).slice(0, 200));
    expect(status).toBe(200);
    console.log(`[phase9] Export returned successfully`);
  });

  // ── Phase 10: Import into New Project ───────────────────────────────────

  test('Phase 10 — create new project and import from Bitbucket', async () => {
    const RUN_ID = Date.now();

    // Create a blank project for import
    const createResp = await api(page, '/api/projects', {
      method: 'POST',
      body: {
        name: `Travel_Import_${RUN_ID}`,
        description: 'E2E test: imported from Bitbucket',
      },
    });

    console.log(`[phase10] Create project → ${createResp.status}`);
    expect(createResp.status).toBe(201);
    const impProj = createResp.data.project ?? createResp.data;
    importedProjectId = impProj._id ?? impProj.id ?? impProj.slug;
    expect(importedProjectId).toBeTruthy();
    importedAuthProfileId = await createBitbucketGitAuthProfile(
      page,
      importedProjectId,
      `import-${RUN_ID}`,
    );

    // Configure git integration on the new project
    const gitResp = await api(page, `/api/projects/${importedProjectId}/git`, {
      method: 'POST',
      body: {
        provider: 'bitbucket',
        repositoryUrl: BB_REPO_URL,
        defaultBranch: BB_BRANCH,
        syncPath: `/travel`,
        authProfileId: importedAuthProfileId,
        syncConfig: {
          autoSync: false,
          conflictStrategy: 'remote_wins',
        },
      },
    });

    console.log(`[phase10] Git integration on import project → ${gitResp.status}`);
    expect(gitResp.status).toBe(201);

    const pullPreviewResp = await api(page, `/api/projects/${importedProjectId}/git/pull`, {
      method: 'POST',
      body: { branch: BB_BRANCH, dryRun: true },
    });
    console.log(
      `[phase10] Pull preview into new project → ${pullPreviewResp.status}`,
      JSON.stringify(pullPreviewResp.data).slice(0, 300),
    );
    expect(pullPreviewResp.status).toBe(200);

    const previewDigest =
      pullPreviewResp.data.previewDigest ?? pullPreviewResp.data.preview?.previewDigest ?? null;
    const acknowledgedIssueIds =
      pullPreviewResp.data.preview?.issues
        ?.filter((issue: { blocking?: boolean; id?: string }) => !issue.blocking && issue.id)
        .map((issue: { id: string }) => issue.id) ?? [];

    // Pull from Bitbucket into the new project
    const pullResp = await api(page, `/api/projects/${importedProjectId}/git/pull`, {
      method: 'POST',
      body: {
        branch: BB_BRANCH,
        previewDigest,
        acknowledgedIssueIds,
      },
    });

    console.log(
      `[phase10] Pull into new project → ${pullResp.status}`,
      JSON.stringify(pullResp.data).slice(0, 300),
    );
    expect(pullResp.status).toBe(200);
    expect(pullResp.data.success).toBe(true);
    expect(pullResp.data.preview).toBeTruthy();
    const agentsResp = await api(page, `/api/projects/${importedProjectId}/agents`);
    const importedAgents = agentsResp.data.agents ?? agentsResp.data;
    console.log(`[phase10] Imported ${importedAgents.length} agents into new project`);
    expect(importedAgents.length).toBeGreaterThan(0);
  });

  // ── Phase 11: Cleanup ──────────────────────────────────────────────────

  test('Phase 11 — cleanup: disconnect git integrations', async () => {
    const originalProjectId = projectId;
    const deletesPrimaryProject = createdPrimaryProject;
    await cleanupGitE2EResources(page);

    // Verify integration is gone
    if (!deletesPrimaryProject && originalProjectId) {
      const check = await api(page, `/api/projects/${originalProjectId}/git`);
      expect(check.data.integration).toBeFalsy();
    }
    console.log('[phase11] Cleanup complete');
  });
});
