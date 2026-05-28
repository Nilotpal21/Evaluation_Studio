import { describe, it, expect } from 'vitest';
import {
  exportProjectV2,
  resolveLayers,
  resolveLayersForToolDependencies,
  type ExportV2Deps,
} from '../export/project-exporter.js';
import { readFolderV2 } from '../import/folder-reader.js';
import type { LayerAssembler, LayerQueryContext } from '../export/layer-assemblers/types.js';
import type { ExportOptionsV2, LayerName, LayerAssemblyResult } from '../types.js';
import type { ManifestInputV2 } from '../export/manifest-generator.js';

// ─── Mock Assembler ─────────────────────────────────────────────────────────

function mockAssembler(
  layer: LayerName,
  entityCount: number,
  files: Map<string, string> = new Map(),
  warnings: string[] = [],
): LayerAssembler {
  return {
    layer,
    async assemble(): Promise<LayerAssemblyResult> {
      return { layer, files, entityCount, warnings };
    },
    async countEntities(): Promise<number> {
      return entityCount;
    },
  };
}

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeOptions(overrides: Partial<ExportOptionsV2> = {}): ExportOptionsV2 {
  return {
    projectId: 'proj-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    format: 'folder',
    layers: ['core', 'connections'],
    ...overrides,
  };
}

function makeManifestMeta(): Omit<ManifestInputV2, 'layers' | 'edges' | 'dslFormat'> {
  return {
    projectName: 'Test Project',
    projectSlug: 'test-project',
    projectDescription: 'A test project',
    exportedBy: 'user-1',
    entryAgent: 'Main',
    agents: [
      {
        name: 'Main',
        description: 'Main agent',
        ownerId: 'user-1',
        ownerTeamId: null,
        version: '1.0',
      },
    ],
    tools: [{ name: 'SearchAPI', ownerId: null }],
    profiles: [],
    entityCounts: { agents: 1, tools: 1 },
    requiredEnvVars: ['OPENAI_API_KEY'],
    requiredConnectors: ['salesforce'],
    requiredMcpServers: [],
  };
}

function makeDeps(assemblerList: LayerAssembler[]): ExportV2Deps {
  const assemblers = new Map<LayerName, LayerAssembler>();
  for (const a of assemblerList) {
    assemblers.set(a.layer, a);
  }
  return {
    assemblers,
    agentData: [{ name: 'Main', version: '1.0', dslContent: 'AGENT: Main', status: 'active' }],
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('resolveLayers', () => {
  it('always includes core even when not requested', () => {
    const layers = resolveLayers(['connections']);
    expect(layers).toContain('core');
  });

  it('returns requested layers plus core', () => {
    const layers = resolveLayers(['connections', 'evals']);
    expect(layers).toContain('core');
    expect(layers).toContain('connections');
    expect(layers).toContain('evals');
  });

  it('uses defaults when no layers requested', () => {
    const layers = resolveLayers();
    expect(layers).toEqual([
      'core',
      'connections',
      'prompts',
      'guardrails',
      'workflows',
      'evals',
      'search',
      'channels',
      'vocabulary',
    ]);
  });

  it('deduplicates core if already in requested', () => {
    const layers = resolveLayers(['core', 'core', 'connections']);
    const coreCount = layers.filter((l) => l === 'core').length;
    expect(coreCount).toBe(1);
  });

  it('adds portable dependency layers for SearchAI and workflow tools', () => {
    const layers = resolveLayersForToolDependencies(
      ['core'],
      [
        {
          dslContent: ['search_docs(query: string) -> object', '  type: searchai'].join('\n'),
        },
        {
          dslContent: ['run_flow(customer_id: string) -> object', '  type: workflow'].join('\n'),
        },
      ],
    );

    expect(layers).toContain('core');
    expect(layers).toContain('search');
    expect(layers).toContain('workflows');
  });
});

describe('exportProjectV2', () => {
  it('should return success with assembled files', async () => {
    const coreFiles = new Map([
      ['agents/main.agent.abl', 'AGENT: Main'],
      ['tools/search_api.tools.abl', 'TOOLS: search'],
    ]);
    const connFiles = new Map([['connections/connectors/salesforce.connection.json', '{}']]);

    const deps = makeDeps([
      mockAssembler('core', 1, coreFiles),
      mockAssembler('connections', 1, connFiles),
    ]);

    const result = await exportProjectV2(makeOptions(), deps, makeManifestMeta());

    expect(result.success).toBe(true);
    expect(result.files.has('agents/main.agent.abl')).toBe(true);
    expect(result.files.has('connections/connectors/salesforce.connection.json')).toBe(true);
    expect(result.files.has('project.json')).toBe(true);
    expect(result.files.has('abl.lock')).toBe(true);
  });

  it('should generate v2 manifest with format_version 2.0', async () => {
    const deps = makeDeps([mockAssembler('core', 1), mockAssembler('connections', 0)]);
    const result = await exportProjectV2(makeOptions(), deps, makeManifestMeta());

    expect(result.manifest.format_version).toBe('2.0');
    expect(result.manifest.layers_included).toEqual(['core', 'connections']);
  });

  it('should publish assembler layer entity counts in the v2 manifest', async () => {
    const coreFiles = new Map([['agents/main.agent.abl', 'AGENT: Main']]);
    const connectionFiles = new Map([
      ['connections/connectors/salesforce.connection.json', '{"name":"salesforce"}'],
    ]);
    const deps = makeDeps([
      mockAssembler('core', 2, coreFiles),
      mockAssembler('connections', 1, connectionFiles),
    ]);

    const result = await exportProjectV2(makeOptions(), deps, makeManifestMeta());

    expect(result.manifest.metadata.entity_counts).toMatchObject({
      agents: 1,
      tools: 1,
      core: 2,
      connections: 1,
    });
  });

  it('should round-trip when logical entity counts differ from archive file counts', async () => {
    const coreFiles = new Map([['agents/main.agent.abl', 'AGENT: Main']]);
    const deps = makeDeps([mockAssembler('core', 2, coreFiles)]);

    const result = await exportProjectV2(
      makeOptions({ layers: ['core'] }),
      deps,
      makeManifestMeta(),
    );
    const read = readFolderV2(result.files);

    expect(read.success).toBe(true);
    expect(read.errors).not.toEqual(
      expect.arrayContaining([expect.stringContaining('does not match')]),
    );
  });

  it('should generate v2 lockfile with lockfile_version 2.0', async () => {
    const deps = makeDeps([mockAssembler('core', 1), mockAssembler('connections', 0)]);
    const result = await exportProjectV2(makeOptions(), deps, makeManifestMeta());

    expect(result.lockfile.lockfile_version).toBe('2.0');
    expect(result.lockfile.integrity).toBeDefined();
  });

  it('should collect warnings from all assemblers', async () => {
    const deps = makeDeps([
      mockAssembler('core', 1, new Map(), ['Core warning']),
      mockAssembler('connections', 0, new Map(), ['Conn warning']),
    ]);

    const result = await exportProjectV2(makeOptions(), deps, makeManifestMeta());

    expect(result.warnings).toContain('Core warning');
    expect(result.warnings).toContain('Conn warning');
  });

  it('should reject when size limit exceeded', async () => {
    // Core layer limit is 1000 agents — create assembler that reports 1001
    const deps = makeDeps([mockAssembler('core', 1001)]);

    const result = await exportProjectV2(
      makeOptions({ layers: ['core'] }),
      deps,
      makeManifestMeta(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('SIZE_LIMIT_EXCEEDED');
    expect(result.error!.message).toContain('core');
  });

  it('should reject explicit layers missing an assembler', async () => {
    // Request evals but don't provide evals assembler
    const deps = makeDeps([mockAssembler('core', 1)]);

    const result = await exportProjectV2(
      makeOptions({ layers: ['core', 'evals'] }),
      deps,
      makeManifestMeta(),
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MISSING_LAYER_ASSEMBLER');
    expect(result.error?.message).toContain('evals');
  });

  it('should assemble wave 2 layers in parallel', async () => {
    const guardrailFiles = new Map([['guardrails/input-filter.guardrail.json', '{}']]);
    const workflowFiles = new Map([['workflows/escalation.workflow.json', '{}']]);

    const deps = makeDeps([
      mockAssembler('core', 1),
      mockAssembler('connections', 0),
      mockAssembler('guardrails', 2, guardrailFiles),
      mockAssembler('workflows', 1, workflowFiles),
    ]);

    const result = await exportProjectV2(
      makeOptions({ layers: ['core', 'connections', 'guardrails', 'workflows'] }),
      deps,
      makeManifestMeta(),
    );

    expect(result.success).toBe(true);
    expect(result.files.has('guardrails/input-filter.guardrail.json')).toBe(true);
    expect(result.files.has('workflows/escalation.workflow.json')).toBe(true);
  });

  it('assembles dependency layers added for portable tool bindings', async () => {
    const deps = makeDeps([
      mockAssembler('core', 1, new Map([['tools/search_docs.tools.abl', 'type: searchai']])),
      mockAssembler('search', 1, new Map([['search/indexes/docs.index.json', '{}']])),
    ]);
    deps.toolData = [
      {
        name: 'search_docs',
        toolType: 'searchai',
        dslContent: ['search_docs(query: string) -> object', '  type: searchai'].join('\n'),
      },
    ];

    const result = await exportProjectV2(
      makeOptions({ layers: ['core'] }),
      deps,
      makeManifestMeta(),
    );

    expect(result.success).toBe(true);
    expect(result.manifest.layers_included).toContain('search');
    expect(result.files.has('search/indexes/docs.index.json')).toBe(true);
  });

  it('should handle export with all 8 layers', async () => {
    const allLayers: LayerName[] = [
      'core',
      'connections',
      'guardrails',
      'workflows',
      'evals',
      'search',
      'channels',
      'vocabulary',
    ];

    const assemblerList = allLayers.map((l) =>
      mockAssembler(l, 1, new Map([[`${l}/test.json`, `{"layer": "${l}"}`]])),
    );
    const deps = makeDeps(assemblerList);

    const result = await exportProjectV2(
      makeOptions({ layers: allLayers }),
      deps,
      makeManifestMeta(),
    );

    expect(result.success).toBe(true);
    expect(result.manifest.layers_included).toHaveLength(8);
    // All layers should contribute files
    for (const layer of allLayers) {
      expect(result.files.has(`${layer}/test.json`)).toBe(true);
    }
  });
});
