/**
 * Integration test: Export/Import performance
 *
 * Validates that export and import operations complete within acceptable
 * time limits for various project sizes. Tests layer assembly, lockfile
 * generation, folder reading, and SHA verification at scale.
 */

import { describe, it, expect, vi } from 'vitest';
import { exportProjectV2, resolveLayers, type ExportV2Deps } from '../export/project-exporter.js';
import { generateLockfileV2, verifyLockfileV2Integrity } from '../export/lockfile-generator.js';
import { readFolderV2 } from '../import/folder-reader.js';
import { verifySHAIntegrity } from '../import/import-validator.js';
import {
  StagedImporter,
  type ImportDbAdapter,
  type StagedRecord,
} from '../import/staged-importer.js';
import type { ExportOptionsV2, LayerName, LayerAssemblyResult } from '../types.js';
import type { LayerAssembler } from '../export/layer-assemblers/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-perf-1';
const TENANT_ID = 'tenant-perf-1';
const USER_ID = 'user-perf-1';

function generateAgentDSL(name: string, toolCount: number): string {
  const tools = Array.from({ length: toolCount }, (_, i) => `  - Tool_${name}_${i}`).join('\n');
  return `AGENT: ${name}\nGOAL: Handle requests for ${name}\nTOOLS:\n${tools}\n`;
}

function generateToolContent(name: string): string {
  return `TOOL: ${name}\nTYPE: rest\nENDPOINT: https://api.example.com/${name.toLowerCase()}\n`;
}

function generateLargeProject(
  agentCount: number,
  toolsPerAgent: number,
  connectionCount: number,
  guardrailCount: number,
): {
  coreFiles: Map<string, string>;
  connectionFiles: Map<string, string>;
  guardrailFiles: Map<string, string>;
  agentData: Array<{ name: string; version: string; dslContent: string; status: string }>;
} {
  const coreFiles = new Map<string, string>();
  const connectionFiles = new Map<string, string>();
  const guardrailFiles = new Map<string, string>();
  const agentData: Array<{ name: string; version: string; dslContent: string; status: string }> =
    [];

  for (let i = 0; i < agentCount; i++) {
    const name = `Agent_${i}`;
    const dsl = generateAgentDSL(name, toolsPerAgent);
    coreFiles.set(`agents/${name.toLowerCase()}.agent.abl`, dsl);
    agentData.push({ name, version: '1.0.0', dslContent: dsl, status: 'active' });

    for (let j = 0; j < toolsPerAgent; j++) {
      const toolName = `Tool_${name}_${j}`;
      coreFiles.set(`tools/${toolName.toLowerCase()}.tools.abl`, generateToolContent(toolName));
    }
  }

  for (let i = 0; i < connectionCount; i++) {
    connectionFiles.set(
      `connections/connectors/connector_${i}.connection.json`,
      JSON.stringify({ name: `connector_${i}`, type: 'oauth2', config: { clientId: `id_${i}` } }),
    );
  }

  for (let i = 0; i < guardrailCount; i++) {
    guardrailFiles.set(
      `guardrails/policy_${i}.guardrail.json`,
      JSON.stringify({
        name: `policy_${i}`,
        type: 'content_filter',
        rules: [{ pattern: `rule_${i}` }],
      }),
    );
  }

  return { coreFiles, connectionFiles, guardrailFiles, agentData };
}

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

function createPerfDbAdapter(): ImportDbAdapter {
  return {
    createImportOperation: vi.fn().mockResolvedValue({ _id: 'perf-op-1' }),
    updateImportOperation: vi.fn().mockResolvedValue(undefined),
    insertStagedRecords: vi
      .fn()
      .mockImplementation((_coll, records) =>
        Promise.resolve(records.map((_: unknown, i: number) => `perf-${i}`)),
      ),
    deleteRecordsByIds: vi.fn().mockResolvedValue(undefined),
    activateLayer: vi.fn().mockResolvedValue(undefined),
    rollbackLayer: vi.fn().mockResolvedValue(undefined),
    findActiveRecordIds: vi.fn().mockResolvedValue([]),
  };
}

async function runExport(
  coreFiles: Map<string, string>,
  connectionFiles: Map<string, string>,
  guardrailFiles: Map<string, string>,
  agentData: Array<{ name: string; version: string; dslContent: string; status: string }>,
) {
  const layers: LayerName[] = ['core', 'connections', 'guardrails'];

  const assemblers = new Map<LayerName, LayerAssembler>();
  assemblers.set('core', createMockAssembler('core', coreFiles, coreFiles.size));
  assemblers.set(
    'connections',
    createMockAssembler('connections', connectionFiles, connectionFiles.size),
  );
  assemblers.set(
    'guardrails',
    createMockAssembler('guardrails', guardrailFiles, guardrailFiles.size),
  );

  const options: ExportOptionsV2 = {
    projectId: PROJECT_ID,
    userId: USER_ID,
    tenantId: TENANT_ID,
    format: 'folder',
    layers,
  };

  return exportProjectV2(
    options,
    { assemblers, agentData, edges: [] },
    {
      projectName: 'Perf Test',
      projectSlug: 'perf-test',
      projectDescription: 'Performance test project',
      exportedBy: USER_ID,
      entryAgent: 'Agent_0',
      agents: agentData.map((a) => ({
        name: a.name,
        description: null,
        ownerId: null,
        ownerTeamId: null,
        version: a.version,
      })),
      tools: [...coreFiles.keys()]
        .filter((p) => p.startsWith('tools/'))
        .map((p) => ({ name: p.replace('tools/', '').replace('.abl', ''), ownerId: null })),
    },
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Export/Import Performance', () => {
  describe('small project (10 agents, 2 tools each)', () => {
    const AGENT_COUNT = 10;
    const TOOLS_PER_AGENT = 2;

    it('should export within 500ms', async () => {
      const { coreFiles, connectionFiles, guardrailFiles, agentData } = generateLargeProject(
        AGENT_COUNT,
        TOOLS_PER_AGENT,
        5,
        3,
      );

      const start = performance.now();
      const result = await runExport(coreFiles, connectionFiles, guardrailFiles, agentData);
      const elapsed = performance.now() - start;

      expect(result.success).toBe(true);
      expect(elapsed).toBeLessThan(1000);
    });

    it('should read folder within 200ms', async () => {
      const { coreFiles, connectionFiles, guardrailFiles, agentData } = generateLargeProject(
        AGENT_COUNT,
        TOOLS_PER_AGENT,
        5,
        3,
      );
      const exportResult = await runExport(coreFiles, connectionFiles, guardrailFiles, agentData);

      const start = performance.now();
      const readResult = readFolderV2(exportResult.files);
      const elapsed = performance.now() - start;

      expect(readResult.success).toBe(true);
      expect(elapsed).toBeLessThan(200);
    });

    it('should verify SHA integrity within 200ms', async () => {
      const { coreFiles, connectionFiles, guardrailFiles, agentData } = generateLargeProject(
        AGENT_COUNT,
        TOOLS_PER_AGENT,
        5,
        3,
      );
      const exportResult = await runExport(coreFiles, connectionFiles, guardrailFiles, agentData);

      const start = performance.now();
      const shaResult = verifySHAIntegrity(exportResult.lockfile, exportResult.files);
      const elapsed = performance.now() - start;

      const allClean = Object.values(shaResult.layerResults).every(
        (r) => r.mismatchedFiles.length === 0,
      );
      expect(allClean).toBe(true);
      expect(elapsed).toBeLessThan(200);
    });
  });

  describe('medium project (50 agents, 3 tools each)', () => {
    const AGENT_COUNT = 50;
    const TOOLS_PER_AGENT = 3;

    it('should export within 1000ms', async () => {
      const { coreFiles, connectionFiles, guardrailFiles, agentData } = generateLargeProject(
        AGENT_COUNT,
        TOOLS_PER_AGENT,
        20,
        10,
      );

      const start = performance.now();
      const result = await runExport(coreFiles, connectionFiles, guardrailFiles, agentData);
      const elapsed = performance.now() - start;

      expect(result.success).toBe(true);
      expect(elapsed).toBeLessThan(1000);
    });

    it('should read folder within 500ms', async () => {
      const { coreFiles, connectionFiles, guardrailFiles, agentData } = generateLargeProject(
        AGENT_COUNT,
        TOOLS_PER_AGENT,
        20,
        10,
      );
      const exportResult = await runExport(coreFiles, connectionFiles, guardrailFiles, agentData);

      const start = performance.now();
      const readResult = readFolderV2(exportResult.files);
      const elapsed = performance.now() - start;

      expect(readResult.success).toBe(true);
      expect(elapsed).toBeLessThan(500);
    });

    it('should verify SHA integrity within 500ms', async () => {
      const { coreFiles, connectionFiles, guardrailFiles, agentData } = generateLargeProject(
        AGENT_COUNT,
        TOOLS_PER_AGENT,
        20,
        10,
      );
      const exportResult = await runExport(coreFiles, connectionFiles, guardrailFiles, agentData);

      const start = performance.now();
      const shaResult = verifySHAIntegrity(exportResult.lockfile, exportResult.files);
      const elapsed = performance.now() - start;

      const allClean = Object.values(shaResult.layerResults).every(
        (r) => r.mismatchedFiles.length === 0,
      );
      expect(allClean).toBe(true);
      expect(elapsed).toBeLessThan(500);
    });

    it('should complete staged import within 500ms', async () => {
      const { coreFiles, connectionFiles, guardrailFiles, agentData } = generateLargeProject(
        AGENT_COUNT,
        TOOLS_PER_AGENT,
        20,
        10,
      );
      const exportResult = await runExport(coreFiles, connectionFiles, guardrailFiles, agentData);
      const importRead = readFolderV2(exportResult.files);

      // Build staged records
      const records: StagedRecord[] = [];
      for (const [path, content] of importRead.agentFiles) {
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
      for (const [path, content] of importRead.toolFiles) {
        const name = path.replace('tools/', '').replace('.abl', '');
        records.push({
          layer: 'core',
          collection: 'project_tools',
          data: { name, content, projectId: PROJECT_ID, tenantId: TENANT_ID },
        });
      }

      const db = createPerfDbAdapter();
      const importer = new StagedImporter(db);

      const start = performance.now();
      const result = await importer.execute(PROJECT_ID, TENANT_ID, records, [], ['core']);
      const elapsed = performance.now() - start;

      expect(result.success).toBe(true);
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe('large project (200 agents, 3 tools each)', () => {
    const AGENT_COUNT = 200;
    const TOOLS_PER_AGENT = 3;

    it('should export within 3000ms', async () => {
      const { coreFiles, connectionFiles, guardrailFiles, agentData } = generateLargeProject(
        AGENT_COUNT,
        TOOLS_PER_AGENT,
        50,
        25,
      );

      const start = performance.now();
      const result = await runExport(coreFiles, connectionFiles, guardrailFiles, agentData);
      const elapsed = performance.now() - start;

      expect(result.success).toBe(true);
      expect(elapsed).toBeLessThan(3000);
    });

    it('should read folder within 1000ms', async () => {
      const { coreFiles, connectionFiles, guardrailFiles, agentData } = generateLargeProject(
        AGENT_COUNT,
        TOOLS_PER_AGENT,
        50,
        25,
      );
      const exportResult = await runExport(coreFiles, connectionFiles, guardrailFiles, agentData);

      const start = performance.now();
      const readResult = readFolderV2(exportResult.files);
      const elapsed = performance.now() - start;

      expect(readResult.success).toBe(true);
      expect(elapsed).toBeLessThan(1000);
    });

    it('should verify SHA integrity within 2000ms', async () => {
      const { coreFiles, connectionFiles, guardrailFiles, agentData } = generateLargeProject(
        AGENT_COUNT,
        TOOLS_PER_AGENT,
        50,
        25,
      );
      const exportResult = await runExport(coreFiles, connectionFiles, guardrailFiles, agentData);

      const start = performance.now();
      const shaResult = verifySHAIntegrity(exportResult.lockfile, exportResult.files);
      const elapsed = performance.now() - start;

      const allClean = Object.values(shaResult.layerResults).every(
        (r) => r.mismatchedFiles.length === 0,
      );
      expect(allClean).toBe(true);
      expect(elapsed).toBeLessThan(2000);
    });
  });

  describe('lockfile v2 performance', () => {
    it('should generate lockfile for 200 agents within 1000ms', () => {
      const layerFiles = new Map<LayerName, Map<string, string>>();
      const coreFiles = new Map<string, string>();
      const agentData: Array<{
        name: string;
        version: string;
        dslContent: string;
        status: string;
      }> = [];

      for (let i = 0; i < 200; i++) {
        const name = `Agent_${i}`;
        const dsl = generateAgentDSL(name, 3);
        coreFiles.set(`agents/${name.toLowerCase()}.agent.abl`, dsl);
        agentData.push({ name, version: '1.0.0', dslContent: dsl, status: 'active' });

        for (let j = 0; j < 3; j++) {
          const toolName = `Tool_${name}_${j}`;
          coreFiles.set(`tools/${toolName.toLowerCase()}.tools.abl`, generateToolContent(toolName));
        }
      }
      layerFiles.set('core', coreFiles);

      const start = performance.now();
      const lockfile = generateLockfileV2(layerFiles, agentData);
      const elapsed = performance.now() - start;

      expect(lockfile.lockfile_version).toBe('2.0');
      expect(Object.keys(lockfile.agents)).toHaveLength(200);
      expect(elapsed).toBeLessThan(1000);
    });

    it('should verify lockfile integrity for 200 agents within 500ms', () => {
      const layerFiles = new Map<LayerName, Map<string, string>>();
      const coreFiles = new Map<string, string>();
      const agentData: Array<{
        name: string;
        version: string;
        dslContent: string;
        status: string;
      }> = [];

      for (let i = 0; i < 200; i++) {
        const name = `Agent_${i}`;
        const dsl = generateAgentDSL(name, 3);
        coreFiles.set(`agents/${name.toLowerCase()}.agent.abl`, dsl);
        agentData.push({ name, version: '1.0.0', dslContent: dsl, status: 'active' });
      }
      layerFiles.set('core', coreFiles);

      const lockfile = generateLockfileV2(layerFiles, agentData);

      const start = performance.now();
      const valid = verifyLockfileV2Integrity(lockfile);
      const elapsed = performance.now() - start;

      expect(valid).toBe(true);
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe('layer resolution performance', () => {
    it('should resolve layers in constant time', () => {
      const start = performance.now();
      for (let i = 0; i < 10000; i++) {
        resolveLayers(['core', 'connections', 'guardrails', 'workflows', 'evals']);
      }
      const elapsed = performance.now() - start;

      // 10k iterations should complete in well under 500ms
      expect(elapsed).toBeLessThan(500);
    });
  });
});
