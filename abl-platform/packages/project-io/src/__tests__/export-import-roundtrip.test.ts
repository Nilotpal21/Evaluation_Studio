/**
 * Integration test: Export v2 → Import v2 round-trip
 *
 * Verifies that a project exported with exportProjectV2 can be read back
 * by readFolderV2, passes SHA integrity verification, cross-layer dependency
 * validation, and staged import execution.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exportProjectV2, type ExportV2Deps } from '../export/project-exporter.js';
import { verifyLockfileV2Integrity } from '../export/lockfile-generator.js';
import { readFolderV2, detectLayers } from '../import/folder-reader.js';
import { verifySHAIntegrity, validateCrossLayerDeps } from '../import/import-validator.js';
import { stripCommonPrefix } from '../import/path-normalizer.js';
import { migrateV1ToV2 } from '../import/v1-migration.js';
import {
  StagedImporter,
  ACTIVATION_ORDER,
  type ImportDbAdapter,
  type StagedRecord,
  type SupersededRecord,
} from '../import/staged-importer.js';
import type { ExportOptionsV2, LayerName, LayerAssemblyResult, ExportResultV2 } from '../types.js';
import type { LayerAssembler } from '../export/layer-assemblers/types.js';
import type { FolderReadResultV2 } from '../import/folder-reader.js';

// ─── Mock Assemblers ─────────────────────────────────────────────────────

function createMockAssembler(
  layer: LayerName,
  files: Map<string, string>,
  entityCount: number,
): LayerAssembler {
  return {
    layer,
    assemble: vi.fn().mockResolvedValue({
      layer,
      files,
      entityCount,
      warnings: [],
    } satisfies LayerAssemblyResult),
    countEntities: vi.fn().mockResolvedValue(entityCount),
  };
}

function createMockDbAdapter(): ImportDbAdapter {
  return {
    createImportOperation: vi.fn().mockResolvedValue({ _id: 'roundtrip-op-1' }),
    updateImportOperation: vi.fn().mockResolvedValue(undefined),
    insertStagedRecords: vi
      .fn()
      .mockImplementation((_coll, records) =>
        Promise.resolve(records.map((_: unknown, i: number) => `staged-rt-${i}`)),
      ),
    deleteRecordsByIds: vi.fn().mockResolvedValue(undefined),
    activateLayer: vi.fn().mockResolvedValue(undefined),
    rollbackLayer: vi.fn().mockResolvedValue(undefined),
    findActiveRecordIds: vi.fn().mockResolvedValue([]),
  };
}

// ─── Test Fixtures ───────────────────────────────────────────────────────

const SUPERVISOR_DSL = `SUPERVISOR: BookingAgent
GOAL: Handle hotel booking requests
TOOLS:
  - HotelSearchAPI
HANDOFFS:
  - PaymentAgent
`;

const PAYMENT_DSL = `AGENT: PaymentAgent
GOAL: Process payments
TOOLS:
  - PaymentGateway
`;

const HOTEL_TOOL_CONTENT = `TOOL: HotelSearchAPI
TYPE: rest
ENDPOINT: https://api.hotels.example.com/search
`;

const PAYMENT_TOOL_CONTENT = `TOOL: PaymentGateway
TYPE: rest
ENDPOINT: https://api.payments.example.com/charge
`;

const CONNECTOR_CONTENT = JSON.stringify({
  name: 'salesforce',
  type: 'oauth2',
  config: { clientId: '{{SF_CLIENT_ID}}' },
});

const GUARDRAIL_CONTENT = JSON.stringify({
  name: 'pii-filter',
  type: 'content_filter',
  rules: [{ pattern: 'SSN', action: 'redact' }],
});

const WORKFLOW_CONTENT = JSON.stringify({
  name: 'booking-flow',
  steps: [
    { agent: 'BookingAgent', action: 'search' },
    { agent: 'PaymentAgent', action: 'charge' },
  ],
});

function buildCoreFiles(): Map<string, string> {
  const files = new Map<string, string>();
  files.set('agents/bookingagent.agent.abl', SUPERVISOR_DSL);
  files.set('agents/paymentagent.agent.abl', PAYMENT_DSL);
  files.set('tools/hotelsearchapi.tools.abl', HOTEL_TOOL_CONTENT);
  files.set('tools/paymentgateway.tools.abl', PAYMENT_TOOL_CONTENT);
  return files;
}

function buildConnectionFiles(): Map<string, string> {
  const files = new Map<string, string>();
  files.set('connections/connectors/salesforce.connection.json', CONNECTOR_CONTENT);
  return files;
}

function buildGuardrailFiles(): Map<string, string> {
  const files = new Map<string, string>();
  files.set('guardrails/pii-filter.guardrail.json', GUARDRAIL_CONTENT);
  return files;
}

function buildWorkflowFiles(): Map<string, string> {
  const files = new Map<string, string>();
  files.set('workflows/booking-flow.workflow.json', WORKFLOW_CONTENT);
  return files;
}

const PROJECT_ID = 'proj-rt-1';
const TENANT_ID = 'tenant-rt-1';
const USER_ID = 'user-rt-1';

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Export-Import Round-Trip (v2)', () => {
  let exportResult: ExportResultV2;

  beforeEach(async () => {
    const layers: LayerName[] = ['core', 'connections', 'guardrails', 'workflows'];

    const assemblers = new Map<LayerName, LayerAssembler>();
    assemblers.set('core', createMockAssembler('core', buildCoreFiles(), 4));
    assemblers.set('connections', createMockAssembler('connections', buildConnectionFiles(), 1));
    assemblers.set('guardrails', createMockAssembler('guardrails', buildGuardrailFiles(), 1));
    assemblers.set('workflows', createMockAssembler('workflows', buildWorkflowFiles(), 1));

    const options: ExportOptionsV2 = {
      projectId: PROJECT_ID,
      userId: USER_ID,
      tenantId: TENANT_ID,
      format: 'folder',
      layers,
    };

    const deps: ExportV2Deps = {
      assemblers,
      agentData: [
        { name: 'BookingAgent', version: '1.0.0', dslContent: SUPERVISOR_DSL, status: 'active' },
        { name: 'PaymentAgent', version: '0.1.0', dslContent: PAYMENT_DSL, status: 'active' },
      ],
      edges: [{ from: 'BookingAgent', to: 'PaymentAgent', type: 'handoff' }],
    };

    const manifestMeta = {
      projectName: 'RoundTrip Hotel',
      projectSlug: 'roundtrip-hotel',
      projectDescription: 'Integration test project',
      exportedBy: USER_ID,
      entryAgent: 'BookingAgent',
      agents: [
        {
          name: 'BookingAgent',
          description: 'Booking supervisor',
          ownerId: null,
          ownerTeamId: null,
          version: '1.0.0',
        },
        {
          name: 'PaymentAgent',
          description: 'Payment handler',
          ownerId: null,
          ownerTeamId: null,
          version: '0.1.0',
        },
      ],
      tools: [
        { name: 'HotelSearchAPI', ownerId: null },
        { name: 'PaymentGateway', ownerId: null },
      ],
    };

    exportResult = await exportProjectV2(options, deps, manifestMeta);
  });

  it('should export successfully with all layers', () => {
    expect(exportResult.success).toBe(true);
    expect(exportResult.files.size).toBeGreaterThan(0);
    expect(exportResult.manifest.format_version).toBe('2.0');
  });

  it('should include project.json and abl.lock in exported files', () => {
    expect(exportResult.files.has('project.json')).toBe(true);
    expect(exportResult.files.has('abl.lock')).toBe(true);
  });

  it('should produce a lockfile with valid integrity', () => {
    expect(verifyLockfileV2Integrity(exportResult.lockfile)).toBe(true);
  });

  describe('readFolderV2 round-trip', () => {
    let readResult: FolderReadResultV2;

    beforeEach(() => {
      readResult = readFolderV2(exportResult.files);
    });

    it('should read exported files without errors', () => {
      expect(readResult.success).toBe(true);
      expect(readResult.errors).toHaveLength(0);
    });

    it('should detect v2 format version', () => {
      expect(readResult.formatVersion).toBe('2.0');
    });

    it('should parse manifest v2', () => {
      expect(readResult.manifestV2).not.toBeNull();
      expect(readResult.manifestV2!.format_version).toBe('2.0');
      expect(readResult.manifestV2!.name).toBe('RoundTrip Hotel');
    });

    it('should parse lockfile v2', () => {
      expect(readResult.lockfileV2).not.toBeNull();
      expect(readResult.lockfileV2!.lockfile_version).toBe('2.0');
    });

    it('should preserve agent files', () => {
      expect(readResult.agentFiles.size).toBe(2);
      expect(readResult.agentFiles.has('agents/bookingagent.agent.abl')).toBe(true);
      expect(readResult.agentFiles.has('agents/paymentagent.agent.abl')).toBe(true);
    });

    it('should preserve tool files', () => {
      expect(readResult.toolFiles.size).toBe(2);
    });

    it('should categorize connection files', () => {
      expect(readResult.connectionFiles.size).toBe(1);
    });

    it('should categorize guardrail files', () => {
      expect(readResult.guardrailFiles.size).toBe(1);
    });

    it('should categorize workflow files', () => {
      expect(readResult.workflowFiles.size).toBe(1);
    });

    it('should detect all layers present in export', () => {
      const layers = detectLayers(readResult);
      expect(layers).toContain('core');
      expect(layers).toContain('connections');
      expect(layers).toContain('guardrails');
      expect(layers).toContain('workflows');
    });
  });

  describe('SHA integrity verification', () => {
    it('should pass per-file SHA verification on unmodified export', () => {
      const shaResult = verifySHAIntegrity(exportResult.lockfile, exportResult.files);

      // All per-file checks should show no mismatches
      const allLayerResults = Object.values(shaResult.layerResults);
      const allFilesClean = allLayerResults.every((r) => r.mismatchedFiles.length === 0);
      expect(allFilesClean).toBe(true);
    });

    it('should detect tampered agent file via per-file hash', () => {
      const tampered = new Map(exportResult.files);
      tampered.set('agents/bookingagent.agent.abl', 'AGENT: Tampered\nGOAL: Hacked');

      const shaResult = verifySHAIntegrity(exportResult.lockfile, tampered);

      // The agents layer should show a mismatched file
      const agentLayer = shaResult.layerResults['agents'];
      expect(agentLayer).toBeDefined();
      expect(agentLayer.mismatchedFiles.length).toBeGreaterThan(0);
    });

    it('should detect tampered lockfile integrity hash', () => {
      const tampered = { ...exportResult.lockfile, integrity: 'deadbeef'.repeat(8) };

      const isValid = verifyLockfileV2Integrity(tampered);
      expect(isValid).toBe(false);
    });
  });

  describe('cross-layer dependency validation', () => {
    it('should validate clean export with no missing dependencies', () => {
      const readResult = readFolderV2(exportResult.files);
      const depsResult = validateCrossLayerDeps(readResult);

      expect(depsResult.valid).toBe(true);
      expect(depsResult.missingDependencies).toHaveLength(0);
    });

    it('should detect missing tool after removal', () => {
      const tampered = new Map(exportResult.files);
      tampered.delete('tools/hotelsearchapi.tools.abl');

      const readResult = readFolderV2(tampered);
      const depsResult = validateCrossLayerDeps(readResult);

      // Agent references HotelSearchAPI but it was removed
      expect(depsResult.missingDependencies.length).toBeGreaterThan(0);
    });
  });

  describe('staged import from export', () => {
    let db: ImportDbAdapter;
    let importer: StagedImporter;

    beforeEach(() => {
      db = createMockDbAdapter();
      importer = new StagedImporter(db);
    });

    it('should successfully stage and activate exported records', async () => {
      const readResult = readFolderV2(exportResult.files);
      const layers = detectLayers(readResult);

      // Build staged records from read result
      const records: StagedRecord[] = [];
      for (const [path, content] of readResult.agentFiles) {
        const name = path
          .replace('agents/', '')
          .replace('.agent.abl', '')
          .replace('.agent.yaml', '');
        records.push({
          layer: 'core',
          collection: 'project_agents',
          data: { name, dslContent: content, projectId: PROJECT_ID, tenantId: TENANT_ID },
        });
      }
      for (const [path, content] of readResult.toolFiles) {
        const name = path.replace('tools/', '').replace('.tools.abl', '');
        records.push({
          layer: 'core',
          collection: 'project_tools',
          data: { name, content, projectId: PROJECT_ID, tenantId: TENANT_ID },
        });
      }
      for (const [, content] of readResult.connectionFiles) {
        records.push({
          layer: 'connections',
          collection: 'connector_connections',
          data: { config: content, projectId: PROJECT_ID, tenantId: TENANT_ID },
        });
      }

      const superseded: SupersededRecord[] = [];
      const importLayers = layers.filter((l): l is LayerName =>
        ACTIVATION_ORDER.includes(l as LayerName),
      );

      const result = await importer.execute(
        PROJECT_ID,
        TENANT_ID,
        records,
        superseded,
        importLayers,
      );

      expect(result.success).toBe(true);
      expect(result.phase).toBe('completed');
      expect(result.operationId).toBe('roundtrip-op-1');
    });

    it('should activate layers in dependency order', async () => {
      const records: StagedRecord[] = [
        {
          layer: 'connections',
          collection: 'connector_connections',
          data: { name: 'sf', projectId: PROJECT_ID, tenantId: TENANT_ID },
        },
        {
          layer: 'core',
          collection: 'project_agents',
          data: {
            name: 'A1',
            dslContent: 'AGENT: A1',
            projectId: PROJECT_ID,
            tenantId: TENANT_ID,
          },
        },
        {
          layer: 'guardrails',
          collection: 'guardrail_policies',
          data: { name: 'pii', projectId: PROJECT_ID, tenantId: TENANT_ID },
        },
      ];

      const superseded: SupersededRecord[] = [
        { layer: 'connections', collection: 'connector_connections', recordId: 'old-1' },
        { layer: 'core', collection: 'project_agents', recordId: 'old-2' },
        { layer: 'guardrails', collection: 'guardrail_policies', recordId: 'old-3' },
      ];

      const result = await importer.execute(PROJECT_ID, TENANT_ID, records, superseded, [
        'connections',
        'core',
        'guardrails',
      ]);

      expect(result.success).toBe(true);

      // Verify activation order via updateImportOperation calls
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
      const guardIdx = activationUpdates.indexOf('guardrails');

      if (connIdx >= 0 && coreIdx >= 0) {
        expect(connIdx).toBeLessThan(coreIdx);
      }
      if (coreIdx >= 0 && guardIdx >= 0) {
        expect(coreIdx).toBeLessThan(guardIdx);
      }
    });
  });

  describe('manifest round-trip fidelity', () => {
    it('should preserve project metadata', () => {
      const readResult = readFolderV2(exportResult.files);

      expect(readResult.manifestV2!.name).toBe('RoundTrip Hotel');
      expect(readResult.manifestV2!.slug).toBe('roundtrip-hotel');
      expect(readResult.manifestV2!.entry_agent).toBe('BookingAgent');
    });

    it('should preserve layers_included list', () => {
      const readResult = readFolderV2(exportResult.files);
      const included = readResult.manifestV2!.layers_included;

      expect(included).toContain('core');
      expect(included).toContain('connections');
      expect(included).toContain('guardrails');
      expect(included).toContain('workflows');
    });

    it('should preserve agent entries in manifest', () => {
      const readResult = readFolderV2(exportResult.files);
      const agents = readResult.manifestV2!.agents;

      expect(agents['BookingAgent']).toBeDefined();
      expect(agents['PaymentAgent']).toBeDefined();
    });
  });

  describe('wrapper-directory import (zip extraction scenario)', () => {
    it('should handle exported files wrapped in a directory prefix', () => {
      // Simulate what happens when a zip file wraps everything in a directory
      // e.g. "retail-voice-demo/project.json" instead of "project.json"
      const wrappedFiles = new Map<string, string>();
      for (const [path, content] of exportResult.files) {
        wrappedFiles.set(`my-project/${path}`, content);
      }

      // stripCommonPrefix must run BEFORE migrateV1ToV2 — this was the bug
      const { files: stripped, strippedPrefix } = stripCommonPrefix(wrappedFiles);

      expect(strippedPrefix).toBe('my-project/');
      expect(stripped.has('project.json')).toBe(true);
      expect(stripped.has('agents/bookingagent.agent.abl')).toBe(true);

      // Now migrateV1ToV2 should find project.json
      const migration = migrateV1ToV2(stripped);
      expect(migration.error).toBeUndefined();
      expect(migration.formatVersion).toBe('2.0');

      // And readFolderV2 should detect the agents
      const folderResult = readFolderV2(migration.files);
      expect(folderResult.success).toBe(true);
      expect(folderResult.agentFiles.size).toBe(2);
    });

    it('should fail migrateV1ToV2 when prefix is NOT stripped (the old bug)', () => {
      // With prefix, project.json is at retail-voice-demo/project.json (not found at root).
      // Auto-manifest scans for agents/* but finds retail-voice-demo/agents/* — no match.
      // Result: NO_AGENTS_FOUND error (previously MISSING_MANIFEST).
      const wrappedFiles = new Map<string, string>();
      for (const [path, content] of exportResult.files) {
        wrappedFiles.set(`retail-voice-demo/${path}`, content);
      }

      const migration = migrateV1ToV2(wrappedFiles);
      expect(migration.error).toBeDefined();
      expect(migration.error!.code).toBe('NO_AGENTS_FOUND');
    });

    it('should handle deeply nested wrapper directories', () => {
      const wrappedFiles = new Map<string, string>();
      for (const [path, content] of exportResult.files) {
        wrappedFiles.set(`downloads/export-2026/my-project/${path}`, content);
      }

      const { files: stripped, strippedPrefix } = stripCommonPrefix(wrappedFiles);
      expect(strippedPrefix).toBe('downloads/export-2026/my-project/');

      const migration = migrateV1ToV2(stripped);
      expect(migration.error).toBeUndefined();

      const folderResult = readFolderV2(migration.files);
      expect(folderResult.success).toBe(true);
      expect(folderResult.agentFiles.size).toBe(2);
    });

    it('should handle no wrapper directory (flat files)', () => {
      // No prefix to strip — files already at root
      const { files: stripped, strippedPrefix } = stripCommonPrefix(exportResult.files);
      expect(strippedPrefix).toBeNull();

      const migration = migrateV1ToV2(stripped);
      expect(migration.error).toBeUndefined();

      const folderResult = readFolderV2(migration.files);
      expect(folderResult.success).toBe(true);
      expect(folderResult.agentFiles.size).toBe(2);
    });
  });
});
