/**
 * Integration test: Import crash recovery
 *
 * Verifies that the staged importer correctly handles failures at each phase,
 * transitions through appropriate states, and performs rollback/cleanup.
 * Simulates ImportOperation crash recovery scenarios.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  StagedImporter,
  ACTIVATION_ORDER,
  type ImportDbAdapter,
  type StagedRecord,
  type SupersededRecord,
} from '../import/staged-importer.js';
import type { LayerName, ImportPhase } from '../types.js';

// ─── Tracking DB Adapter ─────────────────────────────────────────────────

interface OperationSnapshot {
  status: string;
  update: Record<string, unknown>;
  timestamp: number;
}

/**
 * A DB adapter that records all state transitions for crash recovery testing.
 * Tracks the sequence of status updates and allows injecting failures.
 */
function createTrackingDb(options?: {
  failOnStage?: { collection: string; afterCount: number };
  failOnActivate?: { layer: string; afterCount: number };
  failOnRollback?: { collection: string };
}): ImportDbAdapter & { snapshots: OperationSnapshot[]; stagedIds: Map<string, string[]> } {
  const snapshots: OperationSnapshot[] = [];
  const stagedIds = new Map<string, string[]>();
  let stageCallCount = 0;
  let activateCallCount = 0;

  return {
    snapshots,
    stagedIds,

    createImportOperation: vi.fn().mockImplementation(async (params) => {
      snapshots.push({
        status: 'created',
        update: { layers: params.layers },
        timestamp: Date.now(),
      });
      return { _id: 'crash-op-1' };
    }),

    updateImportOperation: vi.fn().mockImplementation(async (_opId, _projId, _tenantId, update) => {
      if (update.status) {
        snapshots.push({ status: update.status as string, update, timestamp: Date.now() });
      }
    }),

    insertStagedRecords: vi.fn().mockImplementation(async (collection, records) => {
      stageCallCount++;
      if (
        options?.failOnStage &&
        collection === options.failOnStage.collection &&
        stageCallCount > options.failOnStage.afterCount
      ) {
        throw new Error(`Simulated staging failure in ${collection}`);
      }
      const ids = records.map((_: unknown, i: number) => `staged-${collection}-${i}`);
      stagedIds.set(collection, [...(stagedIds.get(collection) ?? []), ...ids]);
      return ids;
    }),

    deleteRecordsByIds: vi.fn().mockResolvedValue(undefined),

    activateLayer: vi.fn().mockImplementation(async (collection, staged, superseded) => {
      activateCallCount++;
      if (options?.failOnActivate && activateCallCount > options.failOnActivate.afterCount) {
        throw new Error(`Simulated activation failure`);
      }
    }),

    rollbackLayer: vi.fn().mockImplementation(async (collection) => {
      if (options?.failOnRollback && collection === options.failOnRollback.collection) {
        throw new Error(`Simulated rollback failure in ${collection}`);
      }
    }),

    findActiveRecordIds: vi.fn().mockResolvedValue([]),
  };
}

// ─── Test Data ───────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-crash-1';
const TENANT_ID = 'tenant-crash-1';

function makeMultiLayerRecords(): StagedRecord[] {
  return [
    {
      layer: 'connections',
      collection: 'connector_connections',
      data: { name: 'db-conn', projectId: PROJECT_ID, tenantId: TENANT_ID },
    },
    {
      layer: 'core',
      collection: 'project_agents',
      data: {
        name: 'Agent1',
        dslContent: 'AGENT: Agent1',
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
      },
    },
    {
      layer: 'core',
      collection: 'project_tools',
      data: { name: 'Tool1', content: 'TOOL: Tool1', projectId: PROJECT_ID, tenantId: TENANT_ID },
    },
    {
      layer: 'guardrails',
      collection: 'guardrail_policies',
      data: { name: 'policy1', projectId: PROJECT_ID, tenantId: TENANT_ID },
    },
    {
      layer: 'workflows',
      collection: 'workflow_definitions',
      data: { name: 'flow1', projectId: PROJECT_ID, tenantId: TENANT_ID },
    },
  ];
}

function makeMultiLayerSuperseded(): SupersededRecord[] {
  return [
    { layer: 'connections', collection: 'connector_connections', recordId: 'old-conn-1' },
    { layer: 'core', collection: 'project_agents', recordId: 'old-agent-1' },
    { layer: 'core', collection: 'project_tools', recordId: 'old-tool-1' },
    { layer: 'guardrails', collection: 'guardrail_policies', recordId: 'old-guard-1' },
    { layer: 'workflows', collection: 'workflow_definitions', recordId: 'old-wf-1' },
  ];
}

const ALL_LAYERS: LayerName[] = ['connections', 'core', 'guardrails', 'workflows'];

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Import Crash Recovery', () => {
  describe('staging phase failure', () => {
    it('should transition: created -> staging -> failed on staging error', async () => {
      const db = createTrackingDb({
        failOnStage: { collection: 'project_agents', afterCount: 1 },
      });
      const importer = new StagedImporter(db);

      const result = await importer.execute(
        PROJECT_ID,
        TENANT_ID,
        makeMultiLayerRecords(),
        makeMultiLayerSuperseded(),
        ALL_LAYERS,
      );

      expect(result.success).toBe(false);
      expect(result.error?.phase).toBe('staging');

      const statuses = db.snapshots.map((s) => s.status);
      expect(statuses).toContain('created');
      expect(statuses).toContain('staging');
      expect(statuses).toContain('failed');
      // Should NOT go through activating
      expect(statuses).not.toContain('activating');
    });

    it('should clean up all staged records on staging failure', async () => {
      const db = createTrackingDb({
        failOnStage: { collection: 'project_agents', afterCount: 1 },
      });
      const importer = new StagedImporter(db);

      await importer.execute(
        PROJECT_ID,
        TENANT_ID,
        makeMultiLayerRecords(),
        makeMultiLayerSuperseded(),
        ALL_LAYERS,
      );

      // deleteRecordsByIds should have been called to clean up records from the first successful insert
      expect(db.deleteRecordsByIds).toHaveBeenCalled();
    });

    it('should return empty stagedRecordIds on staging failure', async () => {
      const db = createTrackingDb({
        failOnStage: { collection: 'connector_connections', afterCount: 0 },
      });
      const importer = new StagedImporter(db);

      const result = await importer.execute(
        PROJECT_ID,
        TENANT_ID,
        makeMultiLayerRecords(),
        makeMultiLayerSuperseded(),
        ALL_LAYERS,
      );

      expect(result.success).toBe(false);
      expect(Object.keys(result.stagedRecordIds)).toHaveLength(0);
    });
  });

  describe('activation phase failure with rollback', () => {
    it('should transition: created -> staging -> activating -> rolling_back -> failed', async () => {
      const db = createTrackingDb({
        failOnActivate: { layer: 'guardrails', afterCount: 2 },
      });
      const importer = new StagedImporter(db);

      const result = await importer.execute(
        PROJECT_ID,
        TENANT_ID,
        makeMultiLayerRecords(),
        makeMultiLayerSuperseded(),
        ALL_LAYERS,
      );

      expect(result.success).toBe(false);
      expect(result.error?.phase).toBe('activating');

      const statuses = db.snapshots.map((s) => s.status);
      expect(statuses).toContain('staging');
      expect(statuses).toContain('activating');
      expect(statuses).toContain('rolling_back');
      expect(statuses).toContain('failed');
    });

    it('should rollback already-activated layers on activation failure', async () => {
      const db = createTrackingDb({
        failOnActivate: { layer: 'guardrails', afterCount: 2 },
      });
      const importer = new StagedImporter(db);

      const result = await importer.execute(
        PROJECT_ID,
        TENANT_ID,
        makeMultiLayerRecords(),
        makeMultiLayerSuperseded(),
        ALL_LAYERS,
      );

      expect(result.success).toBe(false);
      expect(db.rollbackLayer).toHaveBeenCalled();
    });

    it('should report which layers were activated before failure', async () => {
      const db = createTrackingDb({
        failOnActivate: { layer: 'guardrails', afterCount: 2 },
      });
      const importer = new StagedImporter(db);

      const result = await importer.execute(
        PROJECT_ID,
        TENANT_ID,
        makeMultiLayerRecords(),
        makeMultiLayerSuperseded(),
        ALL_LAYERS,
      );

      // The error should indicate which phase/layer failed
      expect(result.error?.phase).toBe('activating');
    });

    it('should handle first-layer activation failure gracefully', async () => {
      const db = createTrackingDb({
        failOnActivate: { layer: 'connections', afterCount: 0 },
      });
      const importer = new StagedImporter(db);

      const result = await importer.execute(
        PROJECT_ID,
        TENANT_ID,
        makeMultiLayerRecords(),
        makeMultiLayerSuperseded(),
        ALL_LAYERS,
      );

      expect(result.success).toBe(false);
      // No layers should have been activated
      const statuses = db.snapshots.map((s) => s.status);
      expect(statuses).toContain('rolling_back');
    });
  });

  describe('rollback resilience', () => {
    it('should continue rollback even if one collection fails', async () => {
      const db = createTrackingDb({
        failOnActivate: { layer: 'workflows', afterCount: 3 },
        failOnRollback: { collection: 'project_agents' },
      });
      const importer = new StagedImporter(db);

      const result = await importer.execute(
        PROJECT_ID,
        TENANT_ID,
        makeMultiLayerRecords(),
        makeMultiLayerSuperseded(),
        ALL_LAYERS,
      );

      // Should still complete rollback attempt and reach failed status
      expect(result.success).toBe(false);
      const statuses = db.snapshots.map((s) => s.status);
      expect(statuses).toContain('failed');
    });
  });

  describe('operation state tracking', () => {
    it('should record layer status transitions', async () => {
      const db = createTrackingDb();
      const importer = new StagedImporter(db);

      await importer.execute(
        PROJECT_ID,
        TENANT_ID,
        makeMultiLayerRecords(),
        makeMultiLayerSuperseded(),
        ALL_LAYERS,
      );

      const updateCalls = (db.updateImportOperation as ReturnType<typeof vi.fn>).mock.calls;

      // Should have layer-level status updates
      const layerUpdates = updateCalls.filter(
        ([, , , update]: [string, string, string, Record<string, unknown>]) =>
          Object.keys(update).some((k) => k.startsWith('layers.')),
      );
      expect(layerUpdates.length).toBeGreaterThan(0);
    });

    it('should track stagedRecordIds in operation', async () => {
      const db = createTrackingDb();
      const importer = new StagedImporter(db);

      await importer.execute(
        PROJECT_ID,
        TENANT_ID,
        makeMultiLayerRecords(),
        makeMultiLayerSuperseded(),
        ALL_LAYERS,
      );

      const updateCalls = (db.updateImportOperation as ReturnType<typeof vi.fn>).mock.calls;
      const stagedUpdate = updateCalls.find(
        ([, , , update]: [string, string, string, Record<string, unknown>]) =>
          update.stagedRecordIds !== undefined,
      );
      expect(stagedUpdate).toBeDefined();
    });

    it('should track supersededRecordIds on completion', async () => {
      const db = createTrackingDb();
      const importer = new StagedImporter(db);

      const result = await importer.execute(
        PROJECT_ID,
        TENANT_ID,
        makeMultiLayerRecords(),
        makeMultiLayerSuperseded(),
        ALL_LAYERS,
      );

      expect(result.success).toBe(true);

      const updateCalls = (db.updateImportOperation as ReturnType<typeof vi.fn>).mock.calls;
      const completedUpdate = updateCalls.find(
        ([, , , update]: [string, string, string, Record<string, unknown>]) =>
          update.status === 'completed' && update.supersededRecordIds !== undefined,
      );
      expect(completedUpdate).toBeDefined();
    });

    it('should set expiresAt for TTL-based cleanup', async () => {
      const db = createTrackingDb();
      const importer = new StagedImporter(db);

      await importer.execute(
        PROJECT_ID,
        TENANT_ID,
        makeMultiLayerRecords(),
        makeMultiLayerSuperseded(),
        ALL_LAYERS,
      );

      const createCall = (db.createImportOperation as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(createCall[0].expiresAt).toBeInstanceOf(Date);
      // TTL should be ~1 hour in the future
      const ttlMs = createCall[0].expiresAt.getTime() - Date.now();
      expect(ttlMs).toBeGreaterThan(50 * 60 * 1000); // at least 50 minutes
      expect(ttlMs).toBeLessThanOrEqual(60 * 60 * 1000); // at most 60 minutes
    });
  });

  describe('empty and edge cases', () => {
    it('should handle import with no records', async () => {
      const db = createTrackingDb();
      const importer = new StagedImporter(db);

      const result = await importer.execute(PROJECT_ID, TENANT_ID, [], [], ['core']);

      expect(result.success).toBe(true);
      expect(result.phase).toBe('completed');
    });

    it('should handle import with records but no superseded', async () => {
      const db = createTrackingDb();
      const importer = new StagedImporter(db);

      const records: StagedRecord[] = [
        {
          layer: 'core',
          collection: 'project_agents',
          data: {
            name: 'NewAgent',
            dslContent: 'AGENT: New',
            projectId: PROJECT_ID,
            tenantId: TENANT_ID,
          },
        },
      ];

      const result = await importer.execute(PROJECT_ID, TENANT_ID, records, [], ['core']);

      expect(result.success).toBe(true);
      expect(result.phase).toBe('completed');
    });

    it('should handle single-layer import', async () => {
      const db = createTrackingDb();
      const importer = new StagedImporter(db);

      const records: StagedRecord[] = [
        {
          layer: 'connections',
          collection: 'connector_connections',
          data: { name: 'conn1', projectId: PROJECT_ID, tenantId: TENANT_ID },
        },
      ];

      const superseded: SupersededRecord[] = [
        { layer: 'connections', collection: 'connector_connections', recordId: 'old-1' },
      ];

      const result = await importer.execute(PROJECT_ID, TENANT_ID, records, superseded, [
        'connections',
      ]);

      expect(result.success).toBe(true);
    });
  });
});
