/**
 * Tests for Staged Importer — verifies staging, activation, rollback, and cleanup
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  StagedImporter,
  ACTIVATION_ORDER,
  IMPORT_LIFECYCLE_FIELD,
  type ImportDbAdapter,
  type StagedRecord,
  type SupersededRecord,
} from '../import/staged-importer.js';

// ─── Mock DB Adapter ────────────────────────────────────────────────────

function createMockDb(): ImportDbAdapter {
  return {
    createImportOperation: vi.fn().mockResolvedValue({ _id: 'op-1' }),
    updateImportOperation: vi.fn().mockResolvedValue(undefined),
    insertStagedRecords: vi
      .fn()
      .mockImplementation((_coll, records) =>
        Promise.resolve(records.map((_: unknown, i: number) => `staged-${i}`)),
      ),
    deleteRecordsByIds: vi.fn().mockResolvedValue(undefined),
    activateLayer: vi.fn().mockResolvedValue(undefined),
    rollbackLayer: vi.fn().mockResolvedValue(undefined),
    findActiveRecordIds: vi.fn().mockResolvedValue([]),
  };
}

// ─── Test Data ──────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-1';
const TENANT_ID = 'tenant-1';

function makeStagedRecords(): StagedRecord[] {
  return [
    {
      layer: 'connections',
      collection: 'connector_connections',
      data: { name: 'salesforce', projectId: PROJECT_ID, tenantId: TENANT_ID },
    },
    {
      layer: 'core',
      collection: 'project_agents',
      data: {
        name: 'Supervisor',
        dslContent: 'AGENT: Supervisor',
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
      },
    },
    {
      layer: 'core',
      collection: 'project_tools',
      data: {
        name: 'HotelAPI',
        dslContent: 'TOOL: HotelAPI',
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
      },
    },
  ];
}

function makeSupersededRecords(): SupersededRecord[] {
  return [
    { layer: 'connections', collection: 'connector_connections', recordId: 'old-conn-1' },
    { layer: 'core', collection: 'project_agents', recordId: 'old-agent-1' },
    { layer: 'core', collection: 'project_tools', recordId: 'old-tool-1' },
  ];
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('StagedImporter', () => {
  let db: ImportDbAdapter;
  let importer: StagedImporter;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    importer = new StagedImporter(db);
  });

  describe('ACTIVATION_ORDER', () => {
    it('should have connections before core (dependencies first)', () => {
      const connIdx = ACTIVATION_ORDER.indexOf('connections');
      const coreIdx = ACTIVATION_ORDER.indexOf('core');
      expect(connIdx).toBeLessThan(coreIdx);
    });

    it('should have core before workflows', () => {
      const coreIdx = ACTIVATION_ORDER.indexOf('core');
      const wfIdx = ACTIVATION_ORDER.indexOf('workflows');
      expect(coreIdx).toBeLessThan(wfIdx);
    });
  });

  describe('execute — happy path', () => {
    it('should complete full import cycle', async () => {
      const records = makeStagedRecords();
      const superseded = makeSupersededRecords();

      const result = await importer.execute(PROJECT_ID, TENANT_ID, records, superseded, [
        'connections',
        'core',
      ]);

      expect(result.success).toBe(true);
      expect(result.phase).toBe('completed');
      expect(result.operationId).toBe('op-1');
    });

    it('should create an import operation record', async () => {
      await importer.execute(PROJECT_ID, TENANT_ID, makeStagedRecords(), makeSupersededRecords(), [
        'connections',
        'core',
      ]);

      expect(db.createImportOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          layers: {
            connections: { status: 'pending' },
            core: { status: 'pending' },
          },
        }),
      );
    });

    it('should insert staged records with import lifecycle metadata', async () => {
      await importer.execute(PROJECT_ID, TENANT_ID, makeStagedRecords(), makeSupersededRecords(), [
        'connections',
        'core',
      ]);

      expect(db.insertStagedRecords).toHaveBeenCalled();
      const calls = (db.insertStagedRecords as ReturnType<typeof vi.fn>).mock.calls;
      for (const [, records] of calls) {
        for (const record of records) {
          expect(record.status).toBeUndefined();
          expect(record[IMPORT_LIFECYCLE_FIELD]).toMatchObject({
            operationId: 'op-1',
            state: 'staged',
          });
          expect(typeof (record[IMPORT_LIFECYCLE_FIELD] as { stagedAt?: unknown }).stagedAt).toBe(
            'string',
          );
        }
      }
    });

    it('should preserve domain status instead of overloading it for import lifecycle', async () => {
      await importer.execute(
        PROJECT_ID,
        TENANT_ID,
        [
          {
            layer: 'guardrails',
            collection: 'guardrail_policies',
            data: {
              name: 'policy1',
              status: 'draft',
              projectId: PROJECT_ID,
              tenantId: TENANT_ID,
            },
          },
        ],
        [],
        ['guardrails'],
      );

      const records = (db.insertStagedRecords as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as Array<Record<string, unknown>>;
      expect(records[0].status).toBe('draft');
      expect(records[0][IMPORT_LIFECYCLE_FIELD]).toMatchObject({
        operationId: 'op-1',
        state: 'staged',
        layer: 'guardrails',
      });
    });

    it('should activate layers in dependency order', async () => {
      await importer.execute(PROJECT_ID, TENANT_ID, makeStagedRecords(), makeSupersededRecords(), [
        'connections',
        'core',
      ]);

      // activateLayer should be called — connections before core
      const updateCalls = (db.updateImportOperation as ReturnType<typeof vi.fn>).mock.calls;
      const activationUpdates = updateCalls
        .filter(([, , , update]: [string, string, string, Record<string, unknown>]) => {
          return Object.keys(update).some(
            (k) =>
              k.startsWith('layers.') &&
              (update[k] as Record<string, string>)?.status === 'activated',
          );
        })
        .map(([, , , update]: [string, string, string, Record<string, unknown>]) => {
          const key = Object.keys(update).find((k) => k.startsWith('layers.'));
          return key?.replace('layers.', '');
        });

      // connections should be activated before core
      const connIdx = activationUpdates.indexOf('connections');
      const coreIdx = activationUpdates.indexOf('core');
      if (connIdx >= 0 && coreIdx >= 0) {
        expect(connIdx).toBeLessThan(coreIdx);
      }
    });

    it('should update operation to completed', async () => {
      await importer.execute(PROJECT_ID, TENANT_ID, makeStagedRecords(), makeSupersededRecords(), [
        'connections',
        'core',
      ]);

      const updateCalls = (db.updateImportOperation as ReturnType<typeof vi.fn>).mock.calls;
      const completedUpdate = updateCalls.find(
        ([, , , update]: [string, string, string, Record<string, unknown>]) =>
          update.status === 'completed',
      );
      expect(completedUpdate).toBeDefined();
    });
  });

  describe('stage — failure', () => {
    it('stages dependency collections before dependent workflow records', async () => {
      const records: StagedRecord[] = [
        {
          layer: 'workflows',
          collection: 'trigger_registrations',
          data: { triggerName: 'on_submit' },
        },
        {
          layer: 'workflows',
          collection: 'workflow_versions',
          data: { _workflowName: 'LoanFlow', version: 'draft' },
        },
        {
          layer: 'workflows',
          collection: 'workflows',
          data: { name: 'LoanFlow' },
        },
      ];

      const result = await importer.stage('op-1', PROJECT_ID, TENANT_ID, records, ['workflows']);

      expect(result.success).toBe(true);
      expect(
        (db.insertStagedRecords as ReturnType<typeof vi.fn>).mock.calls.map(
          ([collection]) => collection,
        ),
      ).toEqual(['workflows', 'workflow_versions', 'trigger_registrations']);
    });

    it('stages portable search and vocabulary parents before dependent configs', async () => {
      const records: StagedRecord[] = [
        {
          layer: 'vocabulary',
          collection: 'canonical_schemas',
          data: { _schemaKnowledgeBaseId: 'source-kb', knowledgeBaseId: 'source-kb' },
        },
        {
          layer: 'connections',
          collection: 'connector_configs',
          data: { _connectorConfigSourceId: 'source-src', sourceId: 'source-src' },
        },
        {
          layer: 'vocabulary',
          collection: 'domain_vocabularies',
          data: {
            _vocabularyKnowledgeBaseId: 'source-kb',
            projectKnowledgeBaseId: 'source-kb',
          },
        },
        {
          layer: 'search',
          collection: 'search_sources',
          data: { _exportedId: 'source-src', name: 'Loans source' },
        },
        {
          layer: 'search',
          collection: 'knowledge_bases',
          data: { _exportedId: 'source-kb', name: 'Loans KB' },
        },
        {
          layer: 'search',
          collection: 'search_indexes',
          data: { slug: 'loans', name: 'Loans' },
        },
      ];

      const result = await importer.stage('op-1', PROJECT_ID, TENANT_ID, records, [
        'connections',
        'search',
        'vocabulary',
      ]);

      expect(result.success).toBe(true);
      expect(
        (db.insertStagedRecords as ReturnType<typeof vi.fn>).mock.calls.map(
          ([collection]) => collection,
        ),
      ).toEqual([
        'search_indexes',
        'knowledge_bases',
        'search_sources',
        'connector_configs',
        'domain_vocabularies',
        'canonical_schemas',
      ]);
    });

    it('returns collection and layer context when staging fails', async () => {
      (db.insertStagedRecords as ReturnType<typeof vi.fn>).mockImplementation((collection) => {
        if (collection === 'workflow_versions') {
          return Promise.reject(new Error('E11000 duplicate key'));
        }
        return Promise.resolve(['staged-0']);
      });

      const result = await importer.stage(
        'op-1',
        PROJECT_ID,
        TENANT_ID,
        [
          {
            layer: 'workflows',
            collection: 'workflows',
            data: { name: 'LoanFlow' },
          },
          {
            layer: 'workflows',
            collection: 'workflow_versions',
            data: { _workflowName: 'LoanFlow', version: 'draft' },
          },
        ],
        ['workflows'],
      );

      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        phase: 'staging',
        layer: 'workflows',
        message:
          'Could not stage records for collection "workflow_versions" in layer "workflows". Check for duplicate names or missing parent references.',
      });
      expect(db.deleteRecordsByIds).toHaveBeenCalledWith('workflows', ['staged-0']);
    });

    it('should clean up staged records on staging failure', async () => {
      // First call succeeds, second fails
      (db.insertStagedRecords as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(['staged-0'])
        .mockRejectedValueOnce(new Error('DB write failed'));

      const result = await importer.execute(
        PROJECT_ID,
        TENANT_ID,
        makeStagedRecords(),
        makeSupersededRecords(),
        ['connections', 'core'],
      );

      expect(result.success).toBe(false);
      expect(result.phase).toBe('failed');
      expect(result.error?.phase).toBe('staging');

      // Should attempt to clean up the successfully staged records
      expect(db.deleteRecordsByIds).toHaveBeenCalled();
    });

    it('should mark operation as failed', async () => {
      (db.insertStagedRecords as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Write error'),
      );

      await importer.execute(PROJECT_ID, TENANT_ID, makeStagedRecords(), makeSupersededRecords(), [
        'connections',
        'core',
      ]);

      const updateCalls = (db.updateImportOperation as ReturnType<typeof vi.fn>).mock.calls;
      const failedUpdate = updateCalls.find(
        ([, , , update]: [string, string, string, Record<string, unknown>]) =>
          update.status === 'failed',
      );
      expect(failedUpdate).toBeDefined();
    });
  });

  describe('activate — failure with rollback', () => {
    it('should rollback on activation failure', async () => {
      // Activation fails on the second layer
      let callCount = 0;
      (db.activateLayer as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        if (callCount > 1) {
          return Promise.reject(new Error('Activation failed'));
        }
        return Promise.resolve();
      });

      const result = await importer.execute(
        PROJECT_ID,
        TENANT_ID,
        makeStagedRecords(),
        makeSupersededRecords(),
        ['connections', 'core'],
      );

      expect(result.success).toBe(false);
      expect(result.error?.phase).toBe('activating');

      // Should have called rollbackLayer
      expect(db.rollbackLayer).toHaveBeenCalled();
    });

    it('should transition through rolling_back status', async () => {
      (db.activateLayer as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('fail'));

      await importer.execute(PROJECT_ID, TENANT_ID, makeStagedRecords(), makeSupersededRecords(), [
        'connections',
        'core',
      ]);

      const updateCalls = (db.updateImportOperation as ReturnType<typeof vi.fn>).mock.calls;
      const rollingBackUpdate = updateCalls.find(
        ([, , , update]: [string, string, string, Record<string, unknown>]) =>
          update.status === 'rolling_back',
      );
      expect(rollingBackUpdate).toBeDefined();
    });

    it('should rollback collections that only have superseded records', async () => {
      await importer.rollback(
        'op-1',
        PROJECT_ID,
        TENANT_ID,
        { project_agents: ['agent-new-1'] },
        {
          project_agents: ['agent-old-1'],
          project_runtime_configs: ['runtime-old-1'],
        },
        ['core'],
      );

      expect(db.rollbackLayer).toHaveBeenCalledWith(
        'project_agents',
        ['agent-new-1'],
        ['agent-old-1'],
      );
      expect(db.rollbackLayer).toHaveBeenCalledWith(
        'project_runtime_configs',
        [],
        ['runtime-old-1'],
      );
    });
  });

  describe('execute — edge cases', () => {
    it('should handle empty records', async () => {
      const result = await importer.execute(PROJECT_ID, TENANT_ID, [], [], ['core']);

      expect(result.success).toBe(true);
      expect(result.phase).toBe('completed');
    });

    it('first-time import with no existing records should still activate staged records', async () => {
      const records: StagedRecord[] = [
        {
          layer: 'connections',
          collection: 'connector_connections',
          data: { name: 'salesforce', projectId: PROJECT_ID, tenantId: TENANT_ID },
        },
        {
          layer: 'core',
          collection: 'project_agents',
          data: {
            name: 'Supervisor',
            dslContent: 'AGENT: Supervisor',
            projectId: PROJECT_ID,
            tenantId: TENANT_ID,
          },
        },
      ];

      // No superseded records — this is a brand-new project import
      const result = await importer.execute(
        PROJECT_ID,
        TENANT_ID,
        records,
        [],
        ['connections', 'core'],
      );

      expect(result.success).toBe(true);
      expect(result.phase).toBe('completed');

      // activateLayer should have been called for both collections
      const activateCalls = (db.activateLayer as ReturnType<typeof vi.fn>).mock.calls;
      const activatedCollections = activateCalls.map(
        ([collection]: [string, string[], string[]]) => collection,
      );
      expect(activatedCollections).toContain('connector_connections');
      expect(activatedCollections).toContain('project_agents');
    });

    it('should only activate requested layers', async () => {
      const records: StagedRecord[] = [
        {
          layer: 'core',
          collection: 'project_agents',
          data: { name: 'A1', projectId: PROJECT_ID, tenantId: TENANT_ID },
        },
      ];

      await importer.execute(PROJECT_ID, TENANT_ID, records, [], ['core']);

      // Should not activate connections layer
      const updateCalls = (db.updateImportOperation as ReturnType<typeof vi.fn>).mock.calls;
      const connectionActivation = updateCalls.find(
        ([, , , update]: [string, string, string, Record<string, unknown>]) =>
          update['layers.connections']?.status === 'activated',
      );
      expect(connectionActivation).toBeUndefined();
    });

    it('should handle non-Error thrown values', async () => {
      (db.insertStagedRecords as ReturnType<typeof vi.fn>).mockRejectedValue('string error');

      const result = await importer.execute(
        PROJECT_ID,
        TENANT_ID,
        makeStagedRecords(),
        makeSupersededRecords(),
        ['connections', 'core'],
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({
        phase: 'staging',
        layer: 'connections',
        message:
          'Could not stage records for collection "connector_connections" in layer "connections". Check for duplicate names or missing parent references.',
      });
    });
  });

  describe('search layer activation', () => {
    it('should activate search layer in correct ACTIVATION_ORDER position', () => {
      const searchIdx = ACTIVATION_ORDER.indexOf('search');
      const coreIdx = ACTIVATION_ORDER.indexOf('core');
      const connectionsIdx = ACTIVATION_ORDER.indexOf('connections');

      // search should come after core and connections
      expect(searchIdx).toBeGreaterThan(coreIdx);
      expect(searchIdx).toBeGreaterThan(connectionsIdx);
      // search should be in the activation order at all
      expect(searchIdx).toBeGreaterThanOrEqual(0);
    });

    it('should stage and activate a search layer through the pipeline', async () => {
      const searchRecords: StagedRecord[] = [
        {
          layer: 'search',
          collection: 'search_indexes',
          data: {
            name: 'products',
            type: 'vector',
            projectId: PROJECT_ID,
            tenantId: TENANT_ID,
          },
        },
        {
          layer: 'search',
          collection: 'search_sources',
          data: {
            name: 'web_crawl',
            indexId: 'idx-1',
            projectId: PROJECT_ID,
            tenantId: TENANT_ID,
          },
        },
      ];

      const superseded: SupersededRecord[] = [
        { layer: 'search', collection: 'search_indexes', recordId: 'old-idx-1' },
      ];

      const result = await importer.execute(PROJECT_ID, TENANT_ID, searchRecords, superseded, [
        'search',
      ]);

      expect(result.success).toBe(true);
      expect(result.phase).toBe('completed');

      // Verify staging happened
      expect(db.insertStagedRecords).toHaveBeenCalled();
      const stagingCalls = (db.insertStagedRecords as ReturnType<typeof vi.fn>).mock.calls;
      const stagedCollections = stagingCalls.map(([coll]: [string]) => coll);
      expect(stagedCollections).toContain('search_indexes');
      expect(stagedCollections).toContain('search_sources');

      // Verify activation happened for search layer
      expect(db.activateLayer).toHaveBeenCalled();
      const activateCalls = (db.activateLayer as ReturnType<typeof vi.fn>).mock.calls;
      const activatedCollections = activateCalls.map(
        ([collection]: [string, string[], string[]]) => collection,
      );
      expect(activatedCollections).toContain('search_indexes');
      expect(activatedCollections).toContain('search_sources');
    });

    it('should activate search layer after connections and core when all are requested', async () => {
      const records: StagedRecord[] = [
        {
          layer: 'connections',
          collection: 'connector_connections',
          data: { name: 'db-conn', projectId: PROJECT_ID, tenantId: TENANT_ID },
        },
        {
          layer: 'core',
          collection: 'project_agents',
          data: { name: 'Agent1', projectId: PROJECT_ID, tenantId: TENANT_ID },
        },
        {
          layer: 'search',
          collection: 'search_indexes',
          data: { name: 'main-index', projectId: PROJECT_ID, tenantId: TENANT_ID },
        },
      ];

      await importer.execute(PROJECT_ID, TENANT_ID, records, [], ['connections', 'core', 'search']);

      // Check that layer activation updates happen in order
      const updateCalls = (db.updateImportOperation as ReturnType<typeof vi.fn>).mock.calls;
      const activationUpdates = updateCalls
        .filter(([, , , update]: [string, string, string, Record<string, unknown>]) =>
          Object.keys(update).some(
            (k) =>
              k.startsWith('layers.') &&
              (update[k] as Record<string, string>)?.status === 'activated',
          ),
        )
        .map(([, , , update]: [string, string, string, Record<string, unknown>]) => {
          const key = Object.keys(update).find((k) => k.startsWith('layers.'));
          return key?.replace('layers.', '');
        });

      const connIdx = activationUpdates.indexOf('connections');
      const coreIdx = activationUpdates.indexOf('core');
      const searchIdx = activationUpdates.indexOf('search');

      // All three should have been activated
      expect(connIdx).toBeGreaterThanOrEqual(0);
      expect(coreIdx).toBeGreaterThanOrEqual(0);
      expect(searchIdx).toBeGreaterThanOrEqual(0);

      // Order: connections < core < search
      expect(connIdx).toBeLessThan(coreIdx);
      expect(coreIdx).toBeLessThan(searchIdx);
    });
  });
});
