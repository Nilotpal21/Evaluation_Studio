/**
 * Workflow Version Routes — Integration Tests
 *
 * Tests the WorkflowVersionService against a real MongoMemoryServer.
 * Covers: create from draft, activate, deactivate, PATCH draft vs published,
 * list, get, and atomic workflow+draft creation.
 *
 * No vi.mock() — uses real Mongoose models backed by in-memory MongoDB.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupTestMongo, teardownTestMongo, clearCollections } from './helpers/setup-mongo.js';
import {
  WorkflowVersionService,
  resetWorkflowVersionService,
} from '../services/workflow-version-service.js';

// ─── Constants ────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-test-1';
const PROJECT_ID = 'proj-test-1';
const USER_ID = 'user-test-1';

// Deterministic encryption stub for the webhook-trigger writer; see
// workflow-version-lifecycle.test.ts for the rationale.
const testEncryptSecret = async (plaintext: string): Promise<string> => `cipher:${plaintext}`;

// ─── Setup / Teardown ─────────────────────────────────────────────────────

let svc: WorkflowVersionService;

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

afterEach(async () => {
  await clearCollections();
  resetWorkflowVersionService();
  svc = new WorkflowVersionService({ encryptSecret: testEncryptSecret });
});

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Create a Workflow document directly via model for test seeding. */
async function seedWorkflow(
  overrides: Partial<{
    _id: string;
    name: string;
    tenantId: string;
    projectId: string;
    nodes: unknown[];
    edges: unknown[];
    createdBy: string;
  }> = {},
) {
  const { Workflow } = await import('@agent-platform/database/models');
  const doc = await Workflow.create({
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    name: overrides.name ?? `test-workflow-${Date.now()}`,
    description: null,
    nodes: overrides.nodes ?? [
      { id: 'n1', nodeType: 'start', name: 'Start', position: { x: 0, y: 0 }, config: {} },
      { id: 'n2', nodeType: 'end', name: 'End', position: { x: 200, y: 0 }, config: {} },
    ],
    edges: overrides.edges ?? [{ id: 'e1', source: 'n1', sourceHandle: 'default', target: 'n2' }],
    envVars: {},
    inputSchema: null,
    outputSchema: null,
    status: 'draft',
    createdBy: overrides.createdBy ?? USER_ID,
    ...overrides,
  });
  return doc.toObject();
}

// =============================================================================
// TESTS
// =============================================================================

describe('WorkflowVersionService — integration with MongoMemoryServer', () => {
  beforeAll(() => {
    svc = new WorkflowVersionService({ encryptSecret: testEncryptSecret });
  });

  // ─── 1. POST /versions — creates version from draft ──────────────────

  describe('createVersion (POST /versions equivalent)', () => {
    it('creates a published version from draft with state inactive and v-prefix', async () => {
      const wf = await seedWorkflow();

      const result = await svc.createVersion({
        workflowId: wf._id,
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        createdBy: USER_ID,
      });

      expect(result.versionId).toBeDefined();
      expect(result.version).toMatch(/^v\d+\.\d+\.\d+$/);
      expect(result.sourceHash).toBeDefined();
      expect(result.deduplicated).toBeUndefined();

      // Verify the stored document state
      const { WorkflowVersion } = await import('@agent-platform/database/models');
      const stored = await WorkflowVersion.findOne({ _id: result.versionId }).lean();
      expect(stored).not.toBeNull();
      expect((stored as Record<string, unknown>).state).toBe('inactive');
      expect((stored as Record<string, unknown>).version).toMatch(/^v/);
    }, 15_000);

    it('sources definition from the draft version', async () => {
      const wf = await seedWorkflow({
        nodes: [
          { id: 'n1', nodeType: 'start', name: 'Start', position: { x: 0, y: 0 }, config: {} },
          {
            id: 'n2',
            nodeType: 'function',
            name: 'MyFunc',
            position: { x: 100, y: 0 },
            config: { code: 'return 42;' },
          },
          { id: 'n3', nodeType: 'end', name: 'End', position: { x: 200, y: 0 }, config: {} },
        ],
        edges: [
          { id: 'e1', source: 'n1', sourceHandle: 'default', target: 'n2' },
          { id: 'e2', source: 'n2', sourceHandle: 'default', target: 'n3' },
        ],
      });

      const result = await svc.createVersion({
        workflowId: wf._id,
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        createdBy: USER_ID,
      });

      const { WorkflowVersion } = await import('@agent-platform/database/models');
      const stored = await WorkflowVersion.findOne({ _id: result.versionId }).lean();
      const def = (stored as Record<string, unknown>).definition as Record<string, unknown>;
      const nodes = def.nodes as unknown[];
      expect(nodes).toHaveLength(3);
    });

    it('deduplicates when sourceHash matches latest published', async () => {
      const wf = await seedWorkflow();

      const first = await svc.createVersion({
        workflowId: wf._id,
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        createdBy: USER_ID,
      });

      const second = await svc.createVersion({
        workflowId: wf._id,
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        createdBy: USER_ID,
      });

      expect(second.deduplicated).toBe(true);
      expect(second.versionId).toBe(first.versionId);
    });
  });

  // ─── 2. POST /versions/:v/activate ────────────────────────────────────

  describe('activate (POST /versions/:v/activate equivalent)', () => {
    it('sets state to active and creates TriggerRegistrations', async () => {
      const wf = await seedWorkflow();

      // Create a published version
      const created = await svc.createVersion({
        workflowId: wf._id,
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        createdBy: USER_ID,
      });

      // Add a trigger to the version
      const { WorkflowVersion, TriggerRegistration } =
        await import('@agent-platform/database/models');
      await WorkflowVersion.findOneAndUpdate(
        { _id: created.versionId },
        {
          $set: {
            triggers: [{ id: 'trig-1', type: 'webhook', config: { name: 'on-submit' } }],
          },
        },
      );

      const activated = await svc.activate({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        workflowId: wf._id,
        version: created.version,
        activatedBy: USER_ID,
      });

      expect((activated as Record<string, unknown>).state).toBe('active');

      // Verify TriggerRegistration created
      const registrations = await TriggerRegistration.find({
        workflowVersionId: created.versionId,
        tenantId: TENANT_ID,
      }).lean();
      expect(registrations.length).toBeGreaterThanOrEqual(1);
      expect(registrations[0].status).toBe('active');
    });
  });

  // ─── 3. POST /versions/:v/activate with "draft" → 400 ────────────────

  describe('activate draft guard', () => {
    it('throws DRAFT_ALWAYS_ACTIVE when activating draft', async () => {
      const wf = await seedWorkflow();

      // Ensure draft exists
      await svc.getOrCreateDraft(wf._id, TENANT_ID, PROJECT_ID, USER_ID);

      await expect(
        svc.activate({
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          workflowId: wf._id,
          version: 'draft',
          activatedBy: USER_ID,
        }),
      ).rejects.toThrow(/Draft versions are always active/);
    });

    it('thrown error has code DRAFT_ALWAYS_ACTIVE', async () => {
      const wf = await seedWorkflow();
      await svc.getOrCreateDraft(wf._id, TENANT_ID, PROJECT_ID, USER_ID);

      try {
        await svc.activate({
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          workflowId: wf._id,
          version: 'draft',
          activatedBy: USER_ID,
        });
        expect.fail('Should have thrown');
      } catch (err: unknown) {
        expect((err as { code?: string }).code).toBe('DRAFT_ALWAYS_ACTIVE');
      }
    });
  });

  // ─── 4. POST /versions/:v/deactivate ──────────────────────────────────

  describe('deactivate (POST /versions/:v/deactivate equivalent)', () => {
    it('sets state to inactive', async () => {
      const wf = await seedWorkflow();

      const created = await svc.createVersion({
        workflowId: wf._id,
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        createdBy: USER_ID,
      });

      // First activate
      await svc.activate({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        workflowId: wf._id,
        version: created.version,
        activatedBy: USER_ID,
      });

      // Then deactivate
      const deactivated = await svc.deactivate({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        workflowId: wf._id,
        version: created.version,
      });

      expect((deactivated as Record<string, unknown>).state).toBe('inactive');
    });

    it('throws DRAFT_ALWAYS_ACTIVE when deactivating draft', async () => {
      const wf = await seedWorkflow();
      await svc.getOrCreateDraft(wf._id, TENANT_ID, PROJECT_ID, USER_ID);

      await expect(
        svc.deactivate({
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          workflowId: wf._id,
          version: 'draft',
        }),
      ).rejects.toThrow(/Draft versions are always active/);
    });
  });

  // ─── 5. PATCH /versions/:v on draft — allows all field updates ────────

  describe('validateMutableFields (PATCH equivalent)', () => {
    it('allows all fields on draft version', () => {
      const result = WorkflowVersionService.validateMutableFields(
        { version: 'draft' },
        {
          definition: {
            nodes: [{ id: 'n1' }],
            edges: [{ id: 'e1' }],
          },
          triggers: [{ id: 't1', type: 'webhook', config: {} }],
          changelog: 'updated',
        },
      );
      expect(result.allowed).toBe(true);
    });
  });

  // ─── 6. PATCH /versions/:v on published — blocks definition.nodes ─────

  describe('validateMutableFields on published version', () => {
    it('blocks definition.nodes on published version (FIELD_FROZEN)', () => {
      const result = WorkflowVersionService.validateMutableFields(
        { version: 'v0.1.0', state: 'active' },
        {
          definition: {
            nodes: [{ id: 'n1' }],
          },
        },
      );
      expect(result.allowed).toBe(false);
      expect(result.frozenFields).toBeDefined();
      expect(result.frozenFields!.some((f) => f.includes('nodes'))).toBe(true);
    });

    it('allows metadata update on published version', () => {
      const result = WorkflowVersionService.validateMutableFields(
        { version: 'v0.1.0', state: 'active' },
        {
          metadata: { key: 'value' },
        },
      );
      expect(result.allowed).toBe(true);
    });

    it('allows changelog update on published active version', () => {
      const result = WorkflowVersionService.validateMutableFields(
        { version: 'v0.1.0', state: 'active' },
        {
          changelog: 'updated notes',
        },
      );
      expect(result.allowed).toBe(true);
    });
  });

  // ─── 7. GET /versions — lists versions, excludes deleted ──────────────

  describe('listVersions (GET /versions equivalent)', () => {
    it('lists all non-deleted versions', async () => {
      const wf = await seedWorkflow();

      // Create draft
      await svc.getOrCreateDraft(wf._id, TENANT_ID, PROJECT_ID, USER_ID);

      // Create two published versions — modify draft between publishes
      await svc.createVersion({
        workflowId: wf._id,
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        createdBy: USER_ID,
      });

      // Modify draft to avoid dedup
      const { WorkflowVersion } = await import('@agent-platform/database/models');
      await WorkflowVersion.findOneAndUpdate(
        { workflowId: wf._id, version: 'draft', tenantId: TENANT_ID },
        {
          $set: {
            'definition.nodes': [
              {
                id: 'n-mod',
                nodeType: 'start',
                name: 'Modified',
                position: { x: 0, y: 0 },
                config: {},
              },
            ],
            sourceHash: 'modified-hash',
          },
        },
      );

      await svc.createVersion({
        workflowId: wf._id,
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        createdBy: USER_ID,
      });

      const result = await svc.listVersions({
        workflowId: wf._id,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
      });

      // Should have draft + 2 published
      expect(result.versions.length).toBeGreaterThanOrEqual(3);
      expect(result.total).toBeGreaterThanOrEqual(3);
    });

    it('excludes soft-deleted versions', async () => {
      const wf = await seedWorkflow();

      const created = await svc.createVersion({
        workflowId: wf._id,
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        createdBy: USER_ID,
      });

      // Soft-delete the version
      const { WorkflowVersion } = await import('@agent-platform/database/models');
      await WorkflowVersion.findOneAndUpdate(
        { _id: created.versionId },
        { $set: { deleted: true } },
      );

      const result = await svc.listVersions({
        workflowId: wf._id,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
      });

      const versionIds = result.versions.map((v: Record<string, unknown>) => v._id as string);
      expect(versionIds).not.toContain(created.versionId);
    });
  });

  // ─── 8. GET /versions/:v — gets version detail ────────────────────────

  describe('getVersion (GET /versions/:v equivalent)', () => {
    it('returns the requested version', async () => {
      const wf = await seedWorkflow();

      const created = await svc.createVersion({
        workflowId: wf._id,
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        createdBy: USER_ID,
      });

      const detail = await svc.getVersion(wf._id, created.version, TENANT_ID, PROJECT_ID);

      expect(detail).not.toBeNull();
      expect((detail as Record<string, unknown>).version).toBe(created.version);
      expect((detail as Record<string, unknown>).definition).toBeDefined();
    });

    it('returns null for non-existent version', async () => {
      const wf = await seedWorkflow();

      const detail = await svc.getVersion(wf._id, 'v99.99.99', TENANT_ID, PROJECT_ID);

      expect(detail).toBeNull();
    });
  });

  // ─── 9. INT-1: POST /workflows atomically creates workflow + draft ────

  describe('getOrCreateDraft — atomic workflow + draft version', () => {
    it('lazily creates draft from workflow when none exists', async () => {
      const wf = await seedWorkflow();

      const draft = await svc.getOrCreateDraft(wf._id, TENANT_ID, PROJECT_ID, USER_ID);

      expect(draft).not.toBeNull();
      expect((draft as Record<string, unknown>).version).toBe('draft');
      expect((draft as Record<string, unknown>).workflowId).toBe(wf._id);
    });

    it('returns existing draft on subsequent calls (idempotent)', async () => {
      const wf = await seedWorkflow();

      const draft1 = await svc.getOrCreateDraft(wf._id, TENANT_ID, PROJECT_ID, USER_ID);
      const draft2 = await svc.getOrCreateDraft(wf._id, TENANT_ID, PROJECT_ID, USER_ID);

      expect((draft1 as Record<string, unknown>)._id).toBe((draft2 as Record<string, unknown>)._id);
    });

    it('copies workflow nodes/edges into draft definition', async () => {
      const testNodes = [
        {
          id: 'n1',
          nodeType: 'start',
          name: 'Start',
          position: { x: 0, y: 0 },
          config: {},
        },
        {
          id: 'n2',
          nodeType: 'function',
          name: 'Process',
          position: { x: 100, y: 0 },
          config: { code: 'do stuff' },
        },
      ];
      const testEdges = [{ id: 'e1', source: 'n1', sourceHandle: 'default', target: 'n2' }];

      const wf = await seedWorkflow({ nodes: testNodes, edges: testEdges });

      const draft = await svc.getOrCreateDraft(wf._id, TENANT_ID, PROJECT_ID, USER_ID);

      const def = (draft as Record<string, unknown>).definition as Record<string, unknown>;
      expect((def.nodes as unknown[]).length).toBe(2);
      expect((def.edges as unknown[]).length).toBe(1);
    });
  });

  // ─── Additional: resolveDefaultVersion ──────────────────────────────────

  describe('resolveDefaultVersion', () => {
    it('prefers latest active published version', async () => {
      const wf = await seedWorkflow();

      const created = await svc.createVersion({
        workflowId: wf._id,
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        createdBy: USER_ID,
      });

      await svc.activate({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        workflowId: wf._id,
        version: created.version,
        activatedBy: USER_ID,
      });

      const resolved = await svc.resolveDefaultVersion(TENANT_ID, PROJECT_ID, wf._id);

      expect(resolved.resolution).toBe('published');
      expect(resolved.version.version).toBe(created.version);
    });

    it('falls back to draft when no active version exists', async () => {
      const wf = await seedWorkflow();

      const resolved = await svc.resolveDefaultVersion(TENANT_ID, PROJECT_ID, wf._id);

      expect(resolved.resolution).toBe('draft-fallback');
      expect(resolved.version.version).toBe('draft');
    });
  });

  // ─── Additional: softDeleteVersion ───────────────────────────────────────

  describe('softDeleteVersion (DELETE /versions/:v equivalent)', () => {
    it('soft-deletes an inactive non-deployed version', async () => {
      const wf = await seedWorkflow();

      const created = await svc.createVersion({
        workflowId: wf._id,
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        createdBy: USER_ID,
      });

      // Version is inactive by default
      await svc.softDeleteVersion({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        workflowId: wf._id,
        version: created.version,
        userId: USER_ID,
      });

      // Should be excluded from listVersions
      const result = await svc.listVersions({
        workflowId: wf._id,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
      });
      const versionStrings = result.versions.map(
        (v: Record<string, unknown>) => v.version as string,
      );
      expect(versionStrings).not.toContain(created.version);
    });

    it('deactivates active version before deleting', async () => {
      const wf = await seedWorkflow();

      const created = await svc.createVersion({
        workflowId: wf._id,
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        createdBy: USER_ID,
      });

      await svc.activate({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        workflowId: wf._id,
        version: created.version,
        activatedBy: USER_ID,
      });

      await svc.softDeleteVersion({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        workflowId: wf._id,
        version: created.version,
        userId: USER_ID,
      });

      // Verify version is gone from list
      const result = await svc.listVersions({
        workflowId: wf._id,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
      });
      const versionStrings = result.versions.map(
        (v: Record<string, unknown>) => v.version as string,
      );
      expect(versionStrings).not.toContain(created.version);
    });

    it('throws DRAFT_CANNOT_DELETE when deleting draft', async () => {
      const wf = await seedWorkflow();
      await svc.getOrCreateDraft(wf._id, TENANT_ID, PROJECT_ID, USER_ID);

      try {
        await svc.softDeleteVersion({
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          workflowId: wf._id,
          version: 'draft',
          userId: USER_ID,
        });
        expect.fail('Should have thrown');
      } catch (err: unknown) {
        expect((err as { code?: string }).code).toBe('DRAFT_CANNOT_DELETE');
      }
    });

    it('throws VERSION_DEPLOYED when deleting deployed version', async () => {
      const wf = await seedWorkflow();

      const created = await svc.createVersion({
        workflowId: wf._id,
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        createdBy: USER_ID,
      });

      // Simulate deployment
      const { WorkflowVersion } = await import('@agent-platform/database/models');
      await WorkflowVersion.findOneAndUpdate(
        { _id: created.versionId },
        { $set: { deploymentId: 'deploy-test-1' } },
      );

      try {
        await svc.softDeleteVersion({
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          workflowId: wf._id,
          version: created.version,
          userId: USER_ID,
        });
        expect.fail('Should have thrown');
      } catch (err: unknown) {
        expect((err as { code?: string }).code).toBe('VERSION_DEPLOYED');
      }
    });

    it('throws NOT_FOUND for non-existent version', async () => {
      const wf = await seedWorkflow();

      await expect(
        svc.softDeleteVersion({
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          workflowId: wf._id,
          version: 'v99.99.99',
          userId: USER_ID,
        }),
      ).rejects.toThrow(/not found/i);
    });
  });
});
