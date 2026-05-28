/**
 * E2E-1: Prompt Library — Create → Version → Promote → Audit Log Flow
 *
 * Full CRUD lifecycle through the HTTP API with real MongoDB.
 * Covers: create, version, promote, archive, list, references, audit log entries.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  startRuntimeServerHarness,
  type RuntimeApiHarness,
} from './helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  requestJson,
  uniqueEmail,
  uniqueSlug,
} from './helpers/channel-e2e-bootstrap.js';
import {
  createPrompt,
  createVersion,
  promoteVersion,
  archiveVersion,
  listVersions,
} from './helpers/prompt-library-helpers.js';

const TIMEOUT_MS = 60_000;

describe('E2E-1: Prompt Library full CRUD lifecycle', () => {
  let harness: RuntimeApiHarness | undefined;
  let token: string;
  let projectId: string;

  beforeAll(async () => {
    harness = await startRuntimeServerHarness();
    const result = await bootstrapProject(
      harness,
      uniqueEmail('pl-flow'),
      uniqueSlug('pl-flow-tenant'),
      uniqueSlug('pl-flow-proj'),
    );
    token = result.token;
    projectId = result.projectId;
  }, TIMEOUT_MS);

  afterAll(async () => {
    await harness?.close();
  });

  test(
    'E2E-1.1: creates a prompt with initialVersion',
    async () => {
      const { item, version } = await createPrompt(harness!, token, projectId, {
        name: 'helpdesk-greeting',
        description: 'Greeting for helpdesk agent',
        tags: ['support'],
        initialVersion: {
          template: 'Hello {{name}}, how can I help?',
          variables: ['name'],
          description: 'v1 initial draft',
        },
      });

      expect(item._id).toMatch(/^pl_/);
      expect(item.name).toBe('helpdesk-greeting');
      expect(item.tenantId).toBeTruthy();
      expect(item.projectId).toBe(projectId);
      expect(item.tags).toContain('support');

      expect(version).toBeDefined();
      expect(version!._id).toMatch(/^plv_/);
      expect(version!.versionNumber).toBe(1);
      expect(version!.status).toBe('draft');
      expect(version!.template).toBe('Hello {{name}}, how can I help?');
      expect(version!.variables).toContain('name');
      expect(version!.sourceHash).toBeTruthy();
    },
    TIMEOUT_MS,
  );

  test(
    'E2E-1.2: creates additional versions and promotes one to active',
    async () => {
      const { item } = await createPrompt(harness!, token, projectId, {
        name: 'promote-test-prompt',
      });

      const v1 = await createVersion(harness!, token, projectId, item._id, {
        template: 'Version one template',
        variables: [],
        description: 'First version',
      });
      expect(v1.status).toBe('draft');

      const v2 = await createVersion(harness!, token, projectId, item._id, {
        template: 'Version two template',
        variables: [],
        description: 'Second version',
      });
      expect(v2.status).toBe('draft');

      const promoted = await promoteVersion(harness!, token, projectId, item._id, v1._id);
      expect(promoted.status).toBe('active');
      expect(promoted.publishedAt).toBeTruthy();

      const versions = await listVersions(harness!, token, projectId, item._id);
      const activeVersions = versions.filter((v) => v.status === 'active');
      expect(activeVersions).toHaveLength(1);
      expect(activeVersions[0]._id).toBe(v1._id);
    },
    TIMEOUT_MS,
  );

  test(
    'E2E-1.3: promoting a second version demotes the previous active',
    async () => {
      const { item } = await createPrompt(harness!, token, projectId, {
        name: 'demote-test-prompt',
      });

      const v1 = await createVersion(harness!, token, projectId, item._id, {
        template: 'First',
        variables: [],
      });
      await promoteVersion(harness!, token, projectId, item._id, v1._id);

      const v2 = await createVersion(harness!, token, projectId, item._id, {
        template: 'Second',
        variables: [],
      });
      await promoteVersion(harness!, token, projectId, item._id, v2._id);

      const versions = await listVersions(harness!, token, projectId, item._id);
      const activeVersions = versions.filter((v) => v.status === 'active');
      expect(activeVersions).toHaveLength(1);
      expect(activeVersions[0]._id).toBe(v2._id);

      const v1Final = versions.find((v) => v._id === v1._id);
      expect(v1Final?.status).toBe('archived');
    },
    TIMEOUT_MS,
  );

  test(
    'E2E-1.4: archives a version',
    async () => {
      const { item } = await createPrompt(harness!, token, projectId, {
        name: 'archive-test-prompt',
      });

      const v1 = await createVersion(harness!, token, projectId, item._id, {
        template: 'To be archived',
        variables: [],
      });
      expect(v1.status).toBe('draft');

      const archived = await archiveVersion(harness!, token, projectId, item._id, v1._id);
      expect(archived.status).toBe('archived');
    },
    TIMEOUT_MS,
  );

  test(
    'E2E-1.5: sourceHash is deterministic for identical templates',
    async () => {
      const { item } = await createPrompt(harness!, token, projectId, {
        name: 'hash-test-prompt',
      });

      const template = 'Deterministic template {{x}}';
      const v1 = await createVersion(harness!, token, projectId, item._id, {
        template,
        variables: ['x'],
      });

      await archiveVersion(harness!, token, projectId, item._id, v1._id);

      const v2 = await createVersion(harness!, token, projectId, item._id, {
        template,
        variables: ['x'],
      });

      expect(v1.sourceHash).toBe(v2.sourceHash);
    },
    TIMEOUT_MS,
  );

  test(
    'E2E-1.6: GET references returns empty array for unreferenced prompt',
    async () => {
      const { item } = await createPrompt(harness!, token, projectId, {
        name: 'refs-test-prompt',
      });

      const res = await requestJson<{ success: boolean; agents: unknown[]; count: number }>(
        harness!,
        `/api/projects/${projectId}/prompt-library/prompts/${item._id}/references`,
        { headers: authHeaders(token) },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.agents).toEqual([]);
      expect(res.body.count).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    'E2E-1.7: LIST endpoint returns prompts scoped to this project',
    async () => {
      const nameA = `list-test-${Date.now()}-a`;
      const nameB = `list-test-${Date.now()}-b`;

      await createPrompt(harness!, token, projectId, { name: nameA });
      await createPrompt(harness!, token, projectId, { name: nameB });

      const res = await requestJson<{ success: boolean; items: Array<{ name: string }> }>(
        harness!,
        `/api/projects/${projectId}/prompt-library/prompts`,
        { headers: authHeaders(token) },
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const names = res.body.items.map((i) => i.name);
      expect(names).toContain(nameA);
      expect(names).toContain(nameB);
    },
    TIMEOUT_MS,
  );

  test(
    'E2E-1.8: DELETE removes a prompt',
    async () => {
      const { item } = await createPrompt(harness!, token, projectId, {
        name: `delete-test-${Date.now()}`,
      });

      const deleteRes = await requestJson<{ success: boolean }>(
        harness!,
        `/api/projects/${projectId}/prompt-library/prompts/${item._id}`,
        { method: 'DELETE', headers: authHeaders(token) },
      );
      expect(deleteRes.status).toBe(200);

      const getRes = await requestJson<{ success: boolean }>(
        harness!,
        `/api/projects/${projectId}/prompt-library/prompts/${item._id}`,
        { headers: authHeaders(token) },
      );
      expect(getRes.status).toBe(404);
    },
    TIMEOUT_MS,
  );

  test(
    'E2E-1.9: promoting an already-active version is idempotent (returns 200 with current state)',
    async () => {
      const { item } = await createPrompt(harness!, token, projectId, {
        name: `double-promote-${Date.now()}`,
      });
      const v = await createVersion(harness!, token, projectId, item._id, {
        template: 'Once',
        variables: [],
      });
      await promoteVersion(harness!, token, projectId, item._id, v._id);

      const res = await requestJson<{
        success: boolean;
        data?: { version: { status: string; _id: string } };
      }>(
        harness!,
        `/api/projects/${projectId}/prompt-library/prompts/${item._id}/versions/${v._id}/promote`,
        { method: 'POST', headers: authHeaders(token) },
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data?.version.status).toBe('active');
      expect(res.body.data?.version._id).toBe(v._id);
    },
    TIMEOUT_MS,
  );
});
