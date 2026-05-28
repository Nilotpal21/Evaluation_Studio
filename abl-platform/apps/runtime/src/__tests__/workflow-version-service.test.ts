/**
 * WorkflowVersionService — Unit / Integration Tests
 *
 * Uses MongoMemoryServer (in-process MongoDB) for real document CRUD.
 * NO vi.mock of internal modules.
 *
 * Coverage:
 *  1. createVersion() from draft — sources from draft, v-prefixed version, state "inactive"
 *  2. getOrCreateDraft() — creates draft from Workflow when no draft exists
 *  3. getOrCreateDraft() — returns existing draft when one exists
 *  4. activate() — sets state active, creates TriggerRegistrations
 *  5. activate() draft rejection — throws DRAFT_ALWAYS_ACTIVE
 *  6. activate() idempotency — already active returns same doc
 *  7. deactivate() — sets state inactive, updates TriggerRegistrations
 *  8. deactivate() draft rejection — throws DRAFT_ALWAYS_ACTIVE
 *  9. resolveDefaultVersion() — returns active published version
 * 10. resolveDefaultVersion() — falls back to draft when no active version
 * 11. softDeleteCascade() — marks all 3 collections deleted
 * 12. validateMutableFields() — draft allows all, published blocks definition
 * 13. listVersions() — excludes deleted versions
 * 14. nextVersion() — returns v0.1.0 for first, increments patch for subsequent
 * 15. sourceHash dedup — returns existing version when hash matches
 * 16. softDeleteVersion — rejects draft with DRAFT_CANNOT_DELETE
 * 17. softDeleteVersion — rejects deployed version with VERSION_DEPLOYED
 * 18. softDeleteVersion — throws NOT_FOUND for non-existent version
 * 19. softDeleteVersion — deletes inactive non-deployed version
 * 20. softDeleteVersion — deactivates active version then deletes, including triggers
 * 21. listVersions — includes state, deploymentId, environment fields
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupTestMongo, teardownTestMongo, clearCollections } from './helpers/setup-mongo.js';
import { Workflow, WorkflowVersion, TriggerRegistration } from '@agent-platform/database/models';
import {
  WorkflowVersionService,
  getWorkflowVersionService,
  resetWorkflowVersionService,
} from '../services/workflow-version-service.js';

// ─── Test Constants ──────────────────────────────────────────────────────────

const TENANT = 'tenant-wvs-test';
const PROJECT = 'project-wvs-test';
const USER = 'user-wvs-test';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeWorkflowData(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    projectId: PROJECT,
    name: `test-workflow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdBy: USER,
    nodes: [
      {
        id: 'n1',
        nodeType: 'start',
        name: 'Start',
        position: { x: 0, y: 0 },
        config: {},
      },
    ],
    edges: [],
    envVars: {},
    inputSchema: null,
    outputSchema: null,
    triggers: [{ id: 'trig-1', type: 'webhook', config: { name: 'my-hook' }, status: 'active' }],
    ...overrides,
  };
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  await setupTestMongo();
}, 60_000);

afterAll(async () => {
  await teardownTestMongo();
}, 30_000);

afterEach(async () => {
  resetWorkflowVersionService();
  await clearCollections();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

// Deterministic encryption stub for the webhook-trigger writer — tests do
// not boot the DEK facade; `encryptForTenantAuto` would otherwise throw.
const testEncryptSecret = async (plaintext: string): Promise<string> => `cipher:${plaintext}`;

describe('WorkflowVersionService', () => {
  // Helper: get a fresh service instance
  function svc() {
    resetWorkflowVersionService();
    return getWorkflowVersionService({ encryptSecret: testEncryptSecret });
  }

  // ─── 2. getOrCreateDraft — creates from Workflow ──────────────────────────

  it('creates draft from Workflow when no draft exists', async () => {
    const s = svc();
    const wf = await Workflow.create(makeWorkflowData());
    const draft = await s.getOrCreateDraft(wf._id, TENANT, PROJECT, USER);

    expect(draft).toBeDefined();
    expect(draft.version).toBe('draft');
    expect(draft.workflowId).toBe(wf._id);
    expect(draft.tenantId).toBe(TENANT);
    expect(draft.projectId).toBe(PROJECT);
    // Definition is sourced from the workflow
    expect((draft.definition as Record<string, unknown>).nodes).toBeDefined();
    expect(draft.deleted).toBe(false);
  }, 15_000);

  // ─── 3. getOrCreateDraft — returns existing draft ─────────────────────────

  it('returns existing draft when one exists', async () => {
    const s = svc();
    const wf = await Workflow.create(makeWorkflowData());

    const draft1 = await s.getOrCreateDraft(wf._id, TENANT, PROJECT, USER);
    const draft2 = await s.getOrCreateDraft(wf._id, TENANT, PROJECT, USER);

    expect(draft1._id.toString()).toBe(draft2._id.toString());
    expect(draft1.version).toBe('draft');
  });

  // ─── 1. createVersion from draft ──────────────────────────────────────────

  it('createVersion sources from draft, v-prefixed version, state inactive', async () => {
    const s = svc();
    const wf = await Workflow.create(makeWorkflowData());

    const result = await s.createVersion({
      workflowId: wf._id,
      projectId: PROJECT,
      tenantId: TENANT,
      createdBy: USER,
    });

    expect(result.version).toBe('v0.1.0');
    expect(result.sourceHash).toBeDefined();
    expect(result.versionId).toBeDefined();
    expect(result.deduplicated).toBeUndefined();

    // Verify persisted doc
    const doc = await WorkflowVersion.findOne({
      _id: result.versionId,
      tenantId: TENANT,
    }).lean();
    expect(doc).toBeDefined();
    expect((doc as Record<string, unknown>).state).toBe('inactive');
    expect((doc as Record<string, unknown>).version).toBe('v0.1.0');
  });

  // ─── 4. activate — sets state active, creates TriggerRegistrations ────────

  it('activate sets state active and creates TriggerRegistrations', async () => {
    const s = svc();
    const wf = await Workflow.create(makeWorkflowData());

    const created = await s.createVersion({
      workflowId: wf._id,
      projectId: PROJECT,
      tenantId: TENANT,
      createdBy: USER,
    });

    const activated = await s.activate({
      tenantId: TENANT,
      projectId: PROJECT,
      workflowId: wf._id,
      version: created.version,
      activatedBy: USER,
    });

    expect((activated as Record<string, unknown>).state).toBe('active');

    // TriggerRegistrations should exist
    const regs = await TriggerRegistration.find({
      workflowVersionId: created.versionId,
      tenantId: TENANT,
    }).lean();
    expect(regs.length).toBeGreaterThan(0);
    expect(regs[0].status).toBe('active');
  });

  // ─── 5. activate draft rejection ──────────────────────────────────────────

  it('activate rejects draft version with DRAFT_ALWAYS_ACTIVE', async () => {
    const s = svc();
    const wf = await Workflow.create(makeWorkflowData());

    // Ensure draft exists
    await s.getOrCreateDraft(wf._id, TENANT, PROJECT, USER);

    await expect(
      s.activate({
        tenantId: TENANT,
        projectId: PROJECT,
        workflowId: wf._id,
        version: 'draft',
        activatedBy: USER,
      }),
    ).rejects.toThrow(/always active/i);
  });

  // ─── 6. activate idempotency ──────────────────────────────────────────────

  it('activate returns same doc when already active (idempotent)', async () => {
    const s = svc();
    const wf = await Workflow.create(makeWorkflowData());

    const created = await s.createVersion({
      workflowId: wf._id,
      projectId: PROJECT,
      tenantId: TENANT,
      createdBy: USER,
    });

    const first = await s.activate({
      tenantId: TENANT,
      projectId: PROJECT,
      workflowId: wf._id,
      version: created.version,
      activatedBy: USER,
    });

    const second = await s.activate({
      tenantId: TENANT,
      projectId: PROJECT,
      workflowId: wf._id,
      version: created.version,
      activatedBy: USER,
    });

    expect((first as Record<string, unknown>)._id.toString()).toBe(
      (second as Record<string, unknown>)._id.toString(),
    );
    expect((second as Record<string, unknown>).state).toBe('active');
  });

  // ─── 7. deactivate — sets state inactive, updates TriggerRegistrations ────

  it('deactivate sets state inactive and updates TriggerRegistrations', async () => {
    const s = svc();
    const wf = await Workflow.create(makeWorkflowData());

    const created = await s.createVersion({
      workflowId: wf._id,
      projectId: PROJECT,
      tenantId: TENANT,
      createdBy: USER,
    });

    await s.activate({
      tenantId: TENANT,
      projectId: PROJECT,
      workflowId: wf._id,
      version: created.version,
      activatedBy: USER,
    });

    const deactivated = await s.deactivate({
      tenantId: TENANT,
      projectId: PROJECT,
      workflowId: wf._id,
      version: created.version,
    });

    expect((deactivated as Record<string, unknown>).state).toBe('inactive');

    // TriggerRegistrations should be inactive
    const regs = await TriggerRegistration.find({
      workflowVersionId: created.versionId,
      tenantId: TENANT,
    }).lean();
    for (const reg of regs) {
      expect(reg.status).toBe('inactive');
    }
  });

  // ─── 8. deactivate draft rejection ────────────────────────────────────────

  it('deactivate rejects draft version with DRAFT_ALWAYS_ACTIVE', async () => {
    const s = svc();
    const wf = await Workflow.create(makeWorkflowData());

    await s.getOrCreateDraft(wf._id, TENANT, PROJECT, USER);

    await expect(
      s.deactivate({
        tenantId: TENANT,
        projectId: PROJECT,
        workflowId: wf._id,
        version: 'draft',
      }),
    ).rejects.toThrow(/always active/i);
  });

  // ─── 9. resolveDefaultVersion — returns active published ──────────────────

  it('resolveDefaultVersion returns active published version', async () => {
    const s = svc();
    const wf = await Workflow.create(makeWorkflowData());

    const created = await s.createVersion({
      workflowId: wf._id,
      projectId: PROJECT,
      tenantId: TENANT,
      createdBy: USER,
    });

    await s.activate({
      tenantId: TENANT,
      projectId: PROJECT,
      workflowId: wf._id,
      version: created.version,
      activatedBy: USER,
    });

    const resolved = await s.resolveDefaultVersion(TENANT, PROJECT, wf._id);

    expect(resolved.resolution).toBe('published');
    expect(resolved.version.version).toBe(created.version);
  });

  // ─── 10. resolveDefaultVersion — falls back to draft ──────────────────────

  it('resolveDefaultVersion falls back to draft when no active version', async () => {
    const s = svc();
    const wf = await Workflow.create(makeWorkflowData());

    const resolved = await s.resolveDefaultVersion(TENANT, PROJECT, wf._id);

    expect(resolved.resolution).toBe('draft-fallback');
    expect(resolved.version.version).toBe('draft');
  });

  // ─── 11. softDeleteCascade ────────────────────────────────────────────────

  it('softDeleteCascade marks workflow, versions, and triggers as deleted', async () => {
    const s = svc();
    const wf = await Workflow.create(makeWorkflowData());

    const created = await s.createVersion({
      workflowId: wf._id,
      projectId: PROJECT,
      tenantId: TENANT,
      createdBy: USER,
    });

    await s.activate({
      tenantId: TENANT,
      projectId: PROJECT,
      workflowId: wf._id,
      version: created.version,
      activatedBy: USER,
    });

    await s.softDeleteCascade(TENANT, PROJECT, wf._id);

    // Workflow should be marked deleted
    const deletedWf = await Workflow.findOne({ _id: wf._id, tenantId: TENANT }).lean();
    expect((deletedWf as Record<string, unknown>).deleted).toBe(true);

    // All versions should be marked deleted
    const versions = await WorkflowVersion.find({
      workflowId: wf._id,
      tenantId: TENANT,
    }).lean();
    for (const v of versions) {
      expect((v as Record<string, unknown>).deleted).toBe(true);
    }

    // TriggerRegistrations should have status 'deleted'
    const regs = await TriggerRegistration.find({
      workflowId: wf._id,
      tenantId: TENANT,
    }).lean();
    for (const reg of regs) {
      expect(reg.status).toBe('deleted');
    }
  });

  // ─── 12. validateMutableFields ────────────────────────────────────────────

  describe('validateMutableFields', () => {
    it('draft allows all mutations', () => {
      const result = WorkflowVersionService.validateMutableFields(
        { version: 'draft' },
        { 'definition.nodes': [{ id: 'n1' }], 'definition.edges': [] },
      );
      expect(result.allowed).toBe(true);
    });

    it('published version blocks definition fields', () => {
      const result = WorkflowVersionService.validateMutableFields(
        { version: 'v0.1.0', state: 'active' },
        { 'definition.nodes': [{ id: 'n1' }] },
      );
      expect(result.allowed).toBe(false);
      expect(result.frozenFields).toContain('definition.nodes');
    });

    it('published version allows non-definition fields', () => {
      const result = WorkflowVersionService.validateMutableFields(
        { version: 'v0.1.0', state: 'active' },
        { changelog: 'updated notes' },
      );
      expect(result.allowed).toBe(true);
    });
  });

  // ─── 13. listVersions — excludes deleted ──────────────────────────────────

  it('listVersions excludes deleted versions', async () => {
    const s = svc();
    const wf = await Workflow.create(makeWorkflowData());

    // Create two versions
    await s.createVersion({
      workflowId: wf._id,
      projectId: PROJECT,
      tenantId: TENANT,
      createdBy: USER,
    });

    // Modify the draft so the second createVersion produces a new hash
    await WorkflowVersion.findOneAndUpdate(
      { workflowId: wf._id, tenantId: TENANT, version: 'draft' },
      {
        $set: {
          definition: {
            nodes: [
              {
                id: 'n2',
                nodeType: 'end',
                name: 'End',
                position: { x: 100, y: 100 },
                config: {},
              },
            ],
            edges: [],
            envVars: {},
            inputSchema: null,
            outputSchema: null,
          },
          sourceHash: 'modified-hash',
        },
      },
    );

    const second = await s.createVersion({
      workflowId: wf._id,
      projectId: PROJECT,
      tenantId: TENANT,
      createdBy: USER,
    });

    // Soft-delete the second version
    await WorkflowVersion.findOneAndUpdate({ _id: second.versionId }, { $set: { deleted: true } });

    const { versions, total } = await s.listVersions({
      workflowId: wf._id,
      tenantId: TENANT,
      projectId: PROJECT,
    });

    // Should include draft + v0.1.0 but NOT the deleted v0.1.1
    const versionStrings = versions.map((v: Record<string, unknown>) => v.version as string);
    expect(versionStrings).toContain('draft');
    expect(versionStrings).toContain('v0.1.0');
    expect(versionStrings).not.toContain(second.version);
    expect(total).toBe(versions.length);
  });

  // ─── 14. nextVersion ──────────────────────────────────────────────────────

  it('nextVersion returns v0.1.0 for first, increments patch for subsequent', async () => {
    const s = svc();
    const wf = await Workflow.create(makeWorkflowData());

    const first = await s.nextVersion(wf._id, TENANT, PROJECT);
    expect(first).toBe('v0.1.0');

    // Create a version so nextVersion advances
    await s.createVersion({
      workflowId: wf._id,
      projectId: PROJECT,
      tenantId: TENANT,
      createdBy: USER,
    });

    const second = await s.nextVersion(wf._id, TENANT, PROJECT);
    expect(second).toBe('v0.1.1');
  });

  // ─── 15. sourceHash dedup ─────────────────────────────────────────────────

  it('returns existing version when sourceHash matches (dedup)', async () => {
    const s = svc();
    const wf = await Workflow.create(makeWorkflowData());

    const first = await s.createVersion({
      workflowId: wf._id,
      projectId: PROJECT,
      tenantId: TENANT,
      createdBy: USER,
    });

    // Second create with unchanged draft should dedup
    const second = await s.createVersion({
      workflowId: wf._id,
      projectId: PROJECT,
      tenantId: TENANT,
      createdBy: USER,
    });

    expect(second.deduplicated).toBe(true);
    expect(second.versionId).toBe(first.versionId);
    expect(second.sourceHash).toBe(first.sourceHash);
  });

  // ─── 16–20. softDeleteVersion ─────────────────────────────────────────────

  describe('softDeleteVersion', () => {
    // ─── 16. rejects draft ──────────────────────────────────────────────────

    it('softDeleteVersion rejects draft version with DRAFT_CANNOT_DELETE', async () => {
      const s = svc();
      const wf = await Workflow.create(makeWorkflowData());
      await s.getOrCreateDraft(wf._id, TENANT, PROJECT, USER);

      await expect(
        s.softDeleteVersion({
          tenantId: TENANT,
          projectId: PROJECT,
          workflowId: wf._id,
          version: 'draft',
          userId: USER,
        }),
      ).rejects.toThrow(/Cannot delete the draft version/i);

      try {
        await s.softDeleteVersion({
          tenantId: TENANT,
          projectId: PROJECT,
          workflowId: wf._id,
          version: 'draft',
          userId: USER,
        });
        expect.fail('Should have thrown');
      } catch (err: unknown) {
        expect((err as { code?: string }).code).toBe('DRAFT_CANNOT_DELETE');
      }
    });

    // ─── 17. rejects deployed version ───────────────────────────────────────

    it('softDeleteVersion rejects deployed version with VERSION_DEPLOYED', async () => {
      const s = svc();
      const wf = await Workflow.create(makeWorkflowData());

      const created = await s.createVersion({
        workflowId: wf._id,
        projectId: PROJECT,
        tenantId: TENANT,
        createdBy: USER,
      });

      // Simulate a deployment by setting deploymentId
      await WorkflowVersion.findOneAndUpdate(
        { _id: created.versionId },
        { $set: { deploymentId: 'deploy-123' } },
      );

      await expect(
        s.softDeleteVersion({
          tenantId: TENANT,
          projectId: PROJECT,
          workflowId: wf._id,
          version: created.version,
          userId: USER,
        }),
      ).rejects.toThrow(/Cannot delete a deployed version/i);

      try {
        await s.softDeleteVersion({
          tenantId: TENANT,
          projectId: PROJECT,
          workflowId: wf._id,
          version: created.version,
          userId: USER,
        });
        expect.fail('Should have thrown');
      } catch (err: unknown) {
        expect((err as { code?: string }).code).toBe('VERSION_DEPLOYED');
      }
    });

    // ─── 18. NOT_FOUND for non-existent version ────────────────────────────

    it('softDeleteVersion throws NOT_FOUND for non-existent version', async () => {
      const s = svc();
      const wf = await Workflow.create(makeWorkflowData());

      await expect(
        s.softDeleteVersion({
          tenantId: TENANT,
          projectId: PROJECT,
          workflowId: wf._id,
          version: 'v99.99.99',
          userId: USER,
        }),
      ).rejects.toThrow(/not found/i);
    });

    // ─── 19. deletes inactive non-deployed version ─────────────────────────

    it('softDeleteVersion deletes inactive non-deployed version', async () => {
      const s = svc();
      const wf = await Workflow.create(makeWorkflowData());

      const created = await s.createVersion({
        workflowId: wf._id,
        projectId: PROJECT,
        tenantId: TENANT,
        createdBy: USER,
      });

      // Version starts as inactive — delete directly
      await s.softDeleteVersion({
        tenantId: TENANT,
        projectId: PROJECT,
        workflowId: wf._id,
        version: created.version,
        userId: USER,
      });

      // Verify version is soft-deleted
      const doc = await WorkflowVersion.findOne({ _id: created.versionId }).lean();
      expect(doc).not.toBeNull();
      expect((doc as Record<string, unknown>).deleted).toBe(true);
      expect((doc as Record<string, unknown>).deletedAt).toBeDefined();

      // Verify it's excluded from listVersions
      const { versions } = await s.listVersions({
        workflowId: wf._id,
        tenantId: TENANT,
        projectId: PROJECT,
      });
      const versionStrings = versions.map((v: Record<string, unknown>) => v.version as string);
      expect(versionStrings).not.toContain(created.version);
    });

    // ─── 20. deactivates active version before deleting ────────────────────

    it('softDeleteVersion deactivates active version then deletes, including triggers', async () => {
      const s = svc();
      const wf = await Workflow.create(makeWorkflowData());

      const created = await s.createVersion({
        workflowId: wf._id,
        projectId: PROJECT,
        tenantId: TENANT,
        createdBy: USER,
      });

      // Activate version first
      await s.activate({
        tenantId: TENANT,
        projectId: PROJECT,
        workflowId: wf._id,
        version: created.version,
        activatedBy: USER,
      });

      // Verify there are active trigger registrations
      const regsBeforeDelete = await TriggerRegistration.find({
        workflowVersionId: created.versionId,
        tenantId: TENANT,
      }).lean();
      expect(regsBeforeDelete.length).toBeGreaterThan(0);
      expect(regsBeforeDelete[0].status).toBe('active');

      // Now soft-delete the active version
      await s.softDeleteVersion({
        tenantId: TENANT,
        projectId: PROJECT,
        workflowId: wf._id,
        version: created.version,
        userId: USER,
      });

      // Version should be deleted
      const doc = await WorkflowVersion.findOne({ _id: created.versionId }).lean();
      expect((doc as Record<string, unknown>).deleted).toBe(true);

      // Trigger registrations should be inactive (deactivated before delete)
      const regsAfterDelete = await TriggerRegistration.find({
        workflowVersionId: created.versionId,
        tenantId: TENANT,
      }).lean();
      for (const reg of regsAfterDelete) {
        expect(reg.status).toBe('inactive');
      }
    });
  });

  // ─── 21. listVersions response fields ──────────────────────────────────────

  describe('listVersions response fields', () => {
    it('listVersions includes state, deploymentId, environment in response', async () => {
      const s = svc();
      const wf = await Workflow.create(makeWorkflowData());

      const created = await s.createVersion({
        workflowId: wf._id,
        projectId: PROJECT,
        tenantId: TENANT,
        createdBy: USER,
      });

      await s.activate({
        tenantId: TENANT,
        projectId: PROJECT,
        workflowId: wf._id,
        version: created.version,
        activatedBy: USER,
      });

      const { versions } = await s.listVersions({
        workflowId: wf._id,
        tenantId: TENANT,
        projectId: PROJECT,
      });

      const published = versions.find(
        (v: Record<string, unknown>) => v.version === created.version,
      ) as Record<string, unknown>;
      expect(published).toBeDefined();
      expect(published.state).toBe('active');
      expect(published).toHaveProperty('deploymentId');
      expect(published).toHaveProperty('environment');
      expect(published).toHaveProperty('publishedAt');
      expect(published).toHaveProperty('publishedBy');
      expect(published).toHaveProperty('id');
    });
  });
});
