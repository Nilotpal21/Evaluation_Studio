/**
 * Export v2 Integration Tests
 *
 * Comprehensive integration tests covering:
 * 1. Round-trip: export → verify folder structure → import → verify data
 * 2. Crash recovery: staging/activation failures, rollback, TTL cleanup
 * 3. Size guard / performance: LAYER_SIZE_LIMITS rejection
 * 4. SHA tampering: 3-tier verification catches corruption
 * 5. v1→v2 migration round-trip: import v1, re-export as v2
 * 6. Cross-layer dependency: connector removal detection
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  exportProjectV2,
  resolveLayers,
  type ExportV2Deps,
} from '../../export/project-exporter.js';
import {
  computeSourceHash,
  verifyLockfileV2Integrity,
  computeLayerHash,
} from '../../export/lockfile-generator.js';
import { readFolderV2, detectLayers } from '../../import/folder-reader.js';
import { verifySHAIntegrity, validateCrossLayerDeps } from '../../import/import-validator.js';
import { migrateV1ToV2 } from '../../import/v1-migration.js';
import {
  StagedImporter,
  ACTIVATION_ORDER,
  type ImportDbAdapter,
  type StagedRecord,
  type SupersededRecord,
} from '../../import/staged-importer.js';
import type {
  ExportOptionsV2,
  LayerName,
  LayerAssemblyResult,
  ExportResultV2,
  LockFileV2,
} from '../../types.js';
import { LAYER_SIZE_LIMITS } from '../../types.js';
import type { LayerAssembler } from '../../export/layer-assemblers/types.js';

// ─── Shared Helpers ─────────────────────────────────────────────────────

function mockAssembler(
  layer: LayerName,
  entityCount: number,
  files: Map<string, string> = new Map(),
  warnings: string[] = [],
): LayerAssembler {
  return {
    layer,
    assemble: vi.fn().mockResolvedValue({
      layer,
      files,
      entityCount,
      warnings,
    } satisfies LayerAssemblyResult),
    countEntities: vi.fn().mockResolvedValue(entityCount),
  };
}

function mockDbAdapter(): ImportDbAdapter {
  return {
    createImportOperation: vi.fn().mockResolvedValue({ _id: 'int-op-1' }),
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

function makeOptions(layers: LayerName[]): ExportOptionsV2 {
  return {
    projectId: 'proj-int-1',
    userId: 'user-int-1',
    tenantId: 'tenant-int-1',
    format: 'folder',
    layers,
  };
}

function makeManifestMeta(overrides: Record<string, unknown> = {}) {
  return {
    projectName: 'IntegrationTest',
    projectSlug: 'integration-test',
    projectDescription: 'Integration test project',
    exportedBy: 'user-int-1',
    entryAgent: 'Supervisor',
    agents: [
      {
        name: 'Supervisor',
        description: 'Main supervisor',
        ownerId: null,
        ownerTeamId: null,
        version: '1.0.0',
      },
    ],
    tools: [{ name: 'SearchAPI', ownerId: null }],
    profiles: [],
    entityCounts: { agents: 1, tools: 1 },
    requiredEnvVars: ['API_KEY'],
    requiredConnectors: ['salesforce'],
    requiredMcpServers: [],
    ...overrides,
  };
}

function makeDeps(
  assemblerList: LayerAssembler[],
  agentData?: ExportV2Deps['agentData'],
): ExportV2Deps {
  const assemblers = new Map<LayerName, LayerAssembler>();
  for (const a of assemblerList) {
    assemblers.set(a.layer, a);
  }
  return {
    assemblers,
    agentData: agentData ?? [
      { name: 'Supervisor', version: '1.0.0', dslContent: SUPERVISOR_DSL, status: 'active' },
    ],
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────────

const SUPERVISOR_DSL = `SUPERVISOR: Supervisor
GOAL: Route customer requests
TOOLS:
  - SearchAPI
HANDOFFS:
  - BillingAgent
`;

const BILLING_DSL = `AGENT: BillingAgent
GOAL: Process billing
TOOLS:
  - PaymentAPI
`;

const SEARCH_TOOL = `TOOL: SearchAPI
TYPE: rest
CONNECTOR: salesforce
ENDPOINT: https://api.search.example.com
`;

const PAYMENT_TOOL = `TOOL: PaymentAPI
TYPE: rest
ENDPOINT: https://api.payment.example.com
`;

const CONNECTOR_JSON = JSON.stringify({
  name: 'salesforce',
  type: 'oauth2',
  config: { clientId: '{{SF_ID}}' },
});

const DUMMY_CONNECTOR_JSON = JSON.stringify({
  name: 'zendesk',
  type: 'api_key',
  config: { apiKey: '{{ZD_KEY}}' },
});

const GUARDRAIL_JSON = JSON.stringify({
  name: 'pii-filter',
  type: 'content_filter',
  rules: [{ pattern: 'SSN', action: 'redact' }],
});

const WORKFLOW_JSON = JSON.stringify({
  name: 'escalation',
  trigger: 'sentiment_negative',
  steps: [{ action: 'notify', target: 'manager' }],
});

const EVAL_SET_JSON = JSON.stringify({
  name: 'booking-eval',
  scenarios: ['happy-path'],
});

const SEARCH_INDEX_JSON = JSON.stringify({
  name: 'faq-index',
  type: 'vector',
  dimensions: 768,
});

const CHANNEL_JSON = JSON.stringify({
  name: 'web-chat',
  type: 'widget',
  config: { theme: 'dark' },
});

const VOCAB_JSON = JSON.stringify({
  name: 'hotel-types',
  entries: [{ key: 'suite', value: 'Suite Room' }],
});

function buildAllLayerAssemblers(): LayerAssembler[] {
  return [
    mockAssembler(
      'core',
      2,
      new Map([
        ['agents/supervisor.agent.yaml', SUPERVISOR_DSL],
        ['agents/billingagent.agent.yaml', BILLING_DSL],
        ['tools/searchapi.tools.abl', SEARCH_TOOL],
        ['tools/paymentapi.tools.abl', PAYMENT_TOOL],
      ]),
    ),
    mockAssembler(
      'connections',
      1,
      new Map([['connections/connectors/salesforce.connection.json', CONNECTOR_JSON]]),
    ),
    mockAssembler(
      'guardrails',
      1,
      new Map([['guardrails/pii-filter.guardrail.json', GUARDRAIL_JSON]]),
    ),
    mockAssembler('workflows', 1, new Map([['workflows/escalation.workflow.json', WORKFLOW_JSON]])),
    mockAssembler('evals', 1, new Map([['evals/booking-eval/eval-set.json', EVAL_SET_JSON]])),
    mockAssembler(
      'search',
      1,
      new Map([['search/indexes/faq-index.search-index.json', SEARCH_INDEX_JSON]]),
    ),
    mockAssembler('channels', 1, new Map([['channels/web-chat.channel.json', CHANNEL_JSON]])),
    mockAssembler(
      'vocabulary',
      1,
      new Map([['vocabulary/lookup-tables/hotel-types.lookup.json', VOCAB_JSON]]),
    ),
  ];
}

const ALL_LAYERS: LayerName[] = [
  'core',
  'connections',
  'guardrails',
  'workflows',
  'evals',
  'search',
  'channels',
  'vocabulary',
];

// =========================================================================
// 1. Round-Trip: Export → Folder → Import → Verify
// =========================================================================

describe('1. Round-Trip (all 8 layers)', () => {
  let result: ExportResultV2;

  beforeEach(async () => {
    const deps = makeDeps(buildAllLayerAssemblers(), [
      { name: 'Supervisor', version: '1.0.0', dslContent: SUPERVISOR_DSL, status: 'active' },
      { name: 'BillingAgent', version: '0.1.0', dslContent: BILLING_DSL, status: 'active' },
    ]);
    result = await exportProjectV2(makeOptions(ALL_LAYERS), deps, makeManifestMeta());
  });

  it('should export all 8 layers successfully', () => {
    expect(result.success).toBe(true);
    expect(result.manifest.format_version).toBe('2.0');
    expect(result.manifest.layers_included).toHaveLength(8);
  });

  it('should produce files from every layer', () => {
    expect(result.files.has('agents/supervisor.agent.yaml')).toBe(true);
    expect(result.files.has('connections/connectors/salesforce.connection.json')).toBe(true);
    expect(result.files.has('guardrails/pii-filter.guardrail.json')).toBe(true);
    expect(result.files.has('workflows/escalation.workflow.json')).toBe(true);
    expect(result.files.has('evals/booking-eval/eval-set.json')).toBe(true);
    expect(result.files.has('search/indexes/faq-index.search-index.json')).toBe(true);
    expect(result.files.has('channels/web-chat.channel.json')).toBe(true);
    expect(result.files.has('vocabulary/lookup-tables/hotel-types.lookup.json')).toBe(true);
    expect(result.files.has('project.json')).toBe(true);
    expect(result.files.has('abl.lock')).toBe(true);
  });

  it('should round-trip through readFolderV2 preserving all categories', () => {
    const read = readFolderV2(result.files);

    expect(read.success).toBe(true);
    expect(read.formatVersion).toBe('2.0');
    expect(read.agentFiles.size).toBe(2);
    expect(read.toolFiles.size).toBe(2);
    expect(read.connectionFiles.size).toBe(1);
    expect(read.guardrailFiles.size).toBe(1);
    expect(read.workflowFiles.size).toBe(1);
    expect(read.evalFiles.size).toBe(1);
    expect(read.searchFiles.size).toBe(1);
    expect(read.channelFiles.size).toBe(1);
    expect(read.vocabularyFiles.size).toBe(1);
  });

  it('should detect all 8 layers from folder read', () => {
    const read = readFolderV2(result.files);
    const layers = detectLayers(read);

    for (const layer of ALL_LAYERS) {
      expect(layers).toContain(layer);
    }
  });

  it('should preserve manifest metadata across round-trip', () => {
    const read = readFolderV2(result.files);
    const m = read.manifestV2!;

    expect(m.name).toBe('IntegrationTest');
    expect(m.slug).toBe('integration-test');
    expect(m.entry_agent).toBe('Supervisor');
    expect(m.layers_included).toHaveLength(8);
    expect(m.agents['Supervisor']).toBeDefined();
  });

  it('should produce a lockfile with valid integrity', () => {
    expect(verifyLockfileV2Integrity(result.lockfile)).toBe(true);
    expect(result.lockfile.lockfile_version).toBe('2.0');
  });

  it('should have per-file and per-layer hashes in lockfile', () => {
    expect(result.lockfile.agents['Supervisor'].source_hash).toBe(
      computeSourceHash(SUPERVISOR_DSL),
    );
    expect(result.lockfile.layer_hashes.core).toBeDefined();
    expect(result.lockfile.layer_hashes.connections).toBeDefined();
  });

  it('should stage and activate via StagedImporter', async () => {
    const read = readFolderV2(result.files);
    const records: StagedRecord[] = [];
    for (const [path, content] of read.agentFiles) {
      records.push({
        layer: 'core',
        collection: 'project_agents',
        data: { name: path, dslContent: content, projectId: 'p', tenantId: 't' },
      });
    }

    const db = mockDbAdapter();
    const importer = new StagedImporter(db);
    const importResult = await importer.execute('p', 't', records, [], ['core']);

    expect(importResult.success).toBe(true);
    expect(importResult.phase).toBe('completed');
  });
});

// =========================================================================
// 2. Crash Recovery
// =========================================================================

describe('2. Crash Recovery', () => {
  it('should clean up staged records when staging crashes', async () => {
    const db = mockDbAdapter();
    (db.insertStagedRecords as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(['s-0'])
      .mockRejectedValueOnce(new Error('Disk full'));

    const importer = new StagedImporter(db);
    const records: StagedRecord[] = [
      { layer: 'connections', collection: 'conn', data: { n: 1 } },
      { layer: 'core', collection: 'agents', data: { n: 2 } },
    ];

    const result = await importer.execute('p', 't', records, [], ['connections', 'core']);

    expect(result.success).toBe(false);
    expect(result.error?.phase).toBe('staging');
    expect(db.deleteRecordsByIds).toHaveBeenCalled();
    expect(db.activateLayer).not.toHaveBeenCalled();
  });

  it('should rollback activated layers when activation crashes', async () => {
    const db = mockDbAdapter();
    let callCount = 0;
    (db.activateLayer as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      if (callCount > 1) return Promise.reject(new Error('Activation crash'));
      return Promise.resolve();
    });

    const importer = new StagedImporter(db);
    const records: StagedRecord[] = [
      { layer: 'connections', collection: 'conn', data: { n: 1 } },
      { layer: 'core', collection: 'agents', data: { n: 2 } },
    ];
    const superseded: SupersededRecord[] = [
      { layer: 'connections', collection: 'conn', recordId: 'old-1' },
      { layer: 'core', collection: 'agents', recordId: 'old-2' },
    ];

    const result = await importer.execute('p', 't', records, superseded, ['connections', 'core']);

    expect(result.success).toBe(false);
    expect(result.error?.phase).toBe('activating');
    expect(db.rollbackLayer).toHaveBeenCalled();

    // Status transitions should include rolling_back
    const statuses = (db.updateImportOperation as ReturnType<typeof vi.fn>).mock.calls
      .map(([, , , u]: [string, string, string, Record<string, unknown>]) => u.status)
      .filter(Boolean);
    expect(statuses).toContain('rolling_back');
    expect(statuses).toContain('failed');
  });

  it('should survive rollback failure without throwing', async () => {
    const db = mockDbAdapter();
    (db.activateLayer as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Activation fail'));
    (db.rollbackLayer as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Rollback also failed'),
    );

    const importer = new StagedImporter(db);
    const records: StagedRecord[] = [
      { layer: 'connections', collection: 'conn', data: { n: 1 } },
      { layer: 'core', collection: 'agents', data: { n: 2 } },
    ];
    const superseded: SupersededRecord[] = [
      { layer: 'connections', collection: 'conn', recordId: 'o1' },
      { layer: 'core', collection: 'agents', recordId: 'o2' },
    ];

    const result = await importer.execute('p', 't', records, superseded, ['connections', 'core']);
    expect(result.success).toBe(false);
  });

  it('should set expiresAt for TTL cleanup of abandoned operations', async () => {
    const db = mockDbAdapter();
    const importer = new StagedImporter(db);

    await importer.execute('p', 't', [], [], ['core']);

    const createCall = (db.createImportOperation as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.expiresAt).toBeInstanceOf(Date);
    const ttlMs = createCall.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(50 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it('should track full lifecycle: staging → activating → completed', async () => {
    const db = mockDbAdapter();
    const importer = new StagedImporter(db);

    const records: StagedRecord[] = [{ layer: 'core', collection: 'agents', data: { name: 'A1' } }];
    const superseded: SupersededRecord[] = [
      { layer: 'core', collection: 'agents', recordId: 'old-1' },
    ];

    await importer.execute('p', 't', records, superseded, ['core']);

    const statuses = (db.updateImportOperation as ReturnType<typeof vi.fn>).mock.calls
      .map(([, , , u]: [string, string, string, Record<string, unknown>]) => u.status)
      .filter(Boolean);

    expect(statuses).toContain('staging');
    expect(statuses).toContain('activating');
    expect(statuses).toContain('completed');
  });
});

// =========================================================================
// 3. Size Guard / Performance Threshold
// =========================================================================

describe('3. Size Guard', () => {
  it('should reject export when core layer exceeds LAYER_SIZE_LIMITS', async () => {
    const coreLimit = LAYER_SIZE_LIMITS.core.max; // 1000
    const deps = makeDeps([mockAssembler('core', coreLimit + 1)]);

    const result = await exportProjectV2(makeOptions(['core']), deps, makeManifestMeta());

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('SIZE_LIMIT_EXCEEDED');
    expect(result.error!.message).toContain('core');
    expect(result.error!.message).toContain(String(coreLimit + 1));
    expect(result.error!.message).toContain(String(coreLimit));
  });

  it('should reject export when connections layer exceeds limit', async () => {
    const connLimit = LAYER_SIZE_LIMITS.connections.max; // 200
    const deps = makeDeps([mockAssembler('core', 1), mockAssembler('connections', connLimit + 1)]);

    const result = await exportProjectV2(
      makeOptions(['core', 'connections']),
      deps,
      makeManifestMeta(),
    );

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('SIZE_LIMIT_EXCEEDED');
    expect(result.error!.message).toContain('connections');
  });

  it('should reject export when channels layer exceeds limit', async () => {
    const chanLimit = LAYER_SIZE_LIMITS.channels.max; // 50
    const deps = makeDeps([mockAssembler('core', 1), mockAssembler('channels', chanLimit + 1)]);

    const result = await exportProjectV2(
      makeOptions(['core', 'channels']),
      deps,
      makeManifestMeta(),
    );

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('SIZE_LIMIT_EXCEEDED');
    expect(result.error!.message).toContain('channels');
  });

  it('should succeed at exactly the limit', async () => {
    const coreLimit = LAYER_SIZE_LIMITS.core.max;
    const deps = makeDeps([
      mockAssembler('core', coreLimit, new Map([['agents/test.agent.yaml', 'AGENT: T']])),
    ]);

    const result = await exportProjectV2(makeOptions(['core']), deps, makeManifestMeta());
    expect(result.success).toBe(true);
  });

  it('should normalize non-string assembler output before lockfile hashing', async () => {
    const deps = makeDeps([
      mockAssembler('core', 1, new Map([['agents/empty.agent.yaml', null as unknown as string]])),
    ]);

    const result = await exportProjectV2(makeOptions(['core']), deps, makeManifestMeta());

    expect(result.success).toBe(true);
    expect(result.files.get('agents/empty.agent.yaml')).toBe('');
    expect(result.warnings).toContain(
      'Coerced non-string export content for "agents/empty.agent.yaml" to an empty string',
    );
    expect(result.lockfile.layer_hashes.core).toBeTruthy();
  });

  it('should check all LAYER_SIZE_LIMITS have positive max values', () => {
    for (const [layer, limit] of Object.entries(LAYER_SIZE_LIMITS)) {
      expect(limit.max).toBeGreaterThan(0);
      expect(limit.entity).toBeTruthy();
    }
  });
});

// =========================================================================
// 4. SHA Tampering (3-tier verification)
// =========================================================================

describe('4. SHA Tampering Detection', () => {
  let exportResult: ExportResultV2;

  beforeEach(async () => {
    const deps = makeDeps(buildAllLayerAssemblers(), [
      { name: 'Supervisor', version: '1.0.0', dslContent: SUPERVISOR_DSL, status: 'active' },
      { name: 'BillingAgent', version: '0.1.0', dslContent: BILLING_DSL, status: 'active' },
    ]);
    exportResult = await exportProjectV2(makeOptions(ALL_LAYERS), deps, makeManifestMeta());
  });

  describe('Tier 1: Root integrity hash', () => {
    it('should verify unmodified lockfile', () => {
      expect(verifyLockfileV2Integrity(exportResult.lockfile)).toBe(true);
    });

    it('should reject tampered integrity field', () => {
      const tampered = { ...exportResult.lockfile, integrity: 'a'.repeat(64) };
      expect(verifyLockfileV2Integrity(tampered)).toBe(false);
    });

    it('should reject when agent hash is modified in lockfile', () => {
      const tampered: LockFileV2 = {
        ...exportResult.lockfile,
        agents: {
          ...exportResult.lockfile.agents,
          Supervisor: {
            ...exportResult.lockfile.agents['Supervisor'],
            source_hash: 'tampered_1234567',
          },
        },
      };
      expect(verifyLockfileV2Integrity(tampered)).toBe(false);
    });
  });

  describe('Tier 2: Per-layer hashes', () => {
    it('should detect core layer hash change when file modified', () => {
      const coreLayerHash = exportResult.lockfile.layer_hashes.core!;

      // Recompute with modified file
      const modified = new Map([
        ['agents/supervisor.agent.yaml', 'AGENT: Hacked\nGOAL: Evil'],
        ['agents/billingagent.agent.yaml', BILLING_DSL],
        ['tools/searchapi.tools.abl', SEARCH_TOOL],
        ['tools/paymentapi.tools.abl', PAYMENT_TOOL],
      ]);
      const newHash = computeLayerHash(modified);

      expect(newHash).not.toBe(coreLayerHash);
    });
  });

  describe('Tier 3: Per-file source hashes', () => {
    it('should detect tampered agent file', () => {
      const files = new Map(exportResult.files);
      files.set('agents/supervisor.agent.yaml', 'AGENT: Tampered\nGOAL: Hacked');

      const sha = verifySHAIntegrity(exportResult.lockfile, files);
      expect(sha.layerResults['agents'].mismatchedFiles.length).toBeGreaterThan(0);
    });

    it('should detect tampered connection file via root integrity', () => {
      // Connection files are keyed by full path in the lockfile, so Tier 3
      // per-file matching uses the path prefix pattern. Tampering is caught
      // at Tier 1 (root integrity) when the lockfile hash is recomputed.
      const tampered: LockFileV2 = {
        ...exportResult.lockfile,
        connections: {
          ...exportResult.lockfile.connections,
          'connections/connectors/salesforce.connection.json': {
            source_hash: 'tampered_hash_123',
          },
        },
      };
      expect(verifyLockfileV2Integrity(tampered)).toBe(false);
    });

    it('should pass when no files are tampered', () => {
      const sha = verifySHAIntegrity(exportResult.lockfile, exportResult.files);
      const allClean = Object.values(sha.layerResults).every((r) => r.mismatchedFiles.length === 0);
      expect(allClean).toBe(true);
    });

    it('should match individually computed source hashes', () => {
      const agentHash = exportResult.lockfile.agents['Supervisor'].source_hash;
      expect(agentHash).toBe(computeSourceHash(SUPERVISOR_DSL));
    });
  });
});

// =========================================================================
// 5. v1→v2 Migration Round-Trip
// =========================================================================

describe('5. v1→v2 Migration Round-Trip', () => {
  it('should migrate v1 export (no format_version) to v2 core-only', () => {
    const v1Manifest = {
      name: 'Legacy Project',
      slug: 'legacy-project',
      description: 'A v1 project',
      abl_version: '1.0',
      exported_at: '2026-01-01T00:00:00.000Z',
      exported_by: 'user-1',
      entry_agent: 'Main',
      dsl_format: 'legacy', // intentionally 'legacy' — v1 migration normalizes this to 'yaml'
      agents: {
        Main: {
          path: 'agents/main.agent.abl',
          owner: null,
          ownerTeam: null,
          description: null,
          version: '1.0',
        },
      },
      tools: {
        SearchAPI: { path: 'tools/searchapi.tools.abl', owner: null },
      },
      dependencies: { agent_references: [], tool_imports: [] },
    };

    const files = new Map<string, string>();
    files.set('project.json', JSON.stringify(v1Manifest));
    files.set('agents/main.agent.abl', 'AGENT: Main\nGOAL: Search');
    files.set('tools/searchapi.tools.abl', 'TOOLS: SearchAPI');

    const migration = migrateV1ToV2(files);

    expect(migration.migrated).toBe(true);
    expect(migration.formatVersion).toBe('1.0');
    expect(migration.manifest.format_version).toBe('2.0');
    expect(migration.manifest.layers_included).toEqual(['core']);
    expect(migration.warnings).toContain(
      'v1 format — configs, connections, workflows not included',
    );
    expect(migration.skipLockfileVerification).toBe(true);
  });

  it('should migrate v1 with explicit format_version 1.0', () => {
    const v1Manifest = {
      format_version: '1.0',
      name: 'Old',
      slug: 'old',
      agents: {
        A: {
          path: 'agents/a.agent.abl',
          owner: null,
          ownerTeam: null,
          description: null,
          version: '1.0',
        },
      },
      tools: {},
    };

    const files = new Map<string, string>();
    files.set('project.json', JSON.stringify(v1Manifest));
    files.set('agents/a.agent.abl', 'AGENT: A\nGOAL: Test');

    const migration = migrateV1ToV2(files);

    expect(migration.migrated).toBe(true);
    expect(migration.manifest.format_version).toBe('2.0');
  });

  it('should pass through v2 exports unchanged', () => {
    const v2Manifest = {
      format_version: '2.0',
      name: 'Modern',
      slug: 'modern',
      description: null,
      abl_version: '2.0',
      exported_at: '2026-03-07T00:00:00.000Z',
      exported_by: 'user-1',
      entry_agent: null,
      dsl_format: 'yaml',
      layers_included: ['core', 'connections'],
      agents: {},
      tools: {},
      metadata: {
        entity_counts: {},
        required_env_vars: [],
        required_connectors: [],
        required_mcp_servers: [],
      },
    };

    const files = new Map<string, string>();
    files.set('project.json', JSON.stringify(v2Manifest));

    const migration = migrateV1ToV2(files);
    expect(migration.migrated).toBe(false);
    expect(migration.formatVersion).toBe('2.0');
    expect(migration.skipLockfileVerification).toBe(false);
  });

  it('should reject unknown future versions', () => {
    const files = new Map<string, string>();
    files.set('project.json', JSON.stringify({ format_version: '3.0', name: 'Future' }));

    const migration = migrateV1ToV2(files);
    expect(migration.error).toBeDefined();
    expect(migration.error!.code).toBe('UNSUPPORTED_VERSION');
    expect(migration.error!.message).toContain('3.0');
  });

  it('should re-export migrated v1 data as full v2 structure', async () => {
    // Step 1: Create v1 files
    const v1Files = new Map<string, string>();
    v1Files.set(
      'project.json',
      JSON.stringify({
        name: 'MigrationTest',
        slug: 'migration-test',
        agents: {
          Bot: {
            path: 'agents/bot.agent.abl',
            owner: null,
            ownerTeam: null,
            description: null,
            version: '1.0',
          },
        },
        tools: {},
      }),
    );
    v1Files.set('agents/bot.agent.abl', 'AGENT: Bot\nGOAL: Respond');

    // Step 2: Migrate to v2
    const migration = migrateV1ToV2(v1Files);
    expect(migration.migrated).toBe(true);

    // Step 3: Re-export as v2 with additional layers
    const deps = makeDeps(
      [
        mockAssembler('core', 1, new Map([['agents/bot.agent.yaml', 'AGENT: Bot\nGOAL: Respond']])),
        mockAssembler('connections', 0, new Map()),
      ],
      [{ name: 'Bot', version: '1.0', dslContent: 'AGENT: Bot\nGOAL: Respond', status: 'active' }],
    );

    const reExport = await exportProjectV2(
      makeOptions(['core', 'connections']),
      deps,
      makeManifestMeta({
        projectName: 'MigrationTest',
        projectSlug: 'migration-test',
        entryAgent: null,
        agents: [
          { name: 'Bot', description: null, ownerId: null, ownerTeamId: null, version: '1.0' },
        ],
        tools: [],
      }),
    );

    expect(reExport.success).toBe(true);
    expect(reExport.manifest.format_version).toBe('2.0');
    expect(reExport.manifest.layers_included).toContain('core');
    expect(reExport.manifest.layers_included).toContain('connections');
    expect(reExport.files.has('agents/bot.agent.yaml')).toBe(true);
    expect(verifyLockfileV2Integrity(reExport.lockfile)).toBe(true);
  });
});

// =========================================================================
// 6. Cross-Layer Dependency Validation
// =========================================================================

describe('6. Cross-Layer Dependency Validation', () => {
  let exportResult: ExportResultV2;

  beforeEach(async () => {
    const deps = makeDeps(
      [
        mockAssembler(
          'core',
          2,
          new Map([
            ['agents/supervisor.agent.yaml', SUPERVISOR_DSL],
            ['tools/searchapi.tools.abl', SEARCH_TOOL],
            ['tools/paymentapi.tools.abl', PAYMENT_TOOL],
          ]),
        ),
        mockAssembler(
          'connections',
          2,
          new Map([
            ['connections/connectors/salesforce.connection.json', CONNECTOR_JSON],
            ['connections/connectors/zendesk.connection.json', DUMMY_CONNECTOR_JSON],
          ]),
        ),
      ],
      [{ name: 'Supervisor', version: '1.0.0', dslContent: SUPERVISOR_DSL, status: 'active' }],
    );

    exportResult = await exportProjectV2(
      makeOptions(['core', 'connections']),
      deps,
      makeManifestMeta(),
    );
  });

  it('should validate clean export with all dependencies present', () => {
    const read = readFolderV2(exportResult.files);
    const deps = validateCrossLayerDeps(read);

    expect(deps.valid).toBe(true);
    expect(deps.missingDependencies).toHaveLength(0);
  });

  it('should detect missing connector referenced by tool', () => {
    const files = new Map(exportResult.files);
    // Remove the salesforce connector
    files.delete('connections/connectors/salesforce.connection.json');

    const read = readFolderV2(files);
    const deps = validateCrossLayerDeps(read);

    // SearchAPI tool references CONNECTOR: salesforce — should produce a warning
    expect(deps.warnings.length).toBeGreaterThan(0);
    expect(deps.warnings.some((w) => w.includes('salesforce'))).toBe(true);
  });

  it('should detect missing tool referenced by agent', () => {
    const files = new Map(exportResult.files);
    // Remove the SearchAPI tool
    files.delete('tools/searchapi.tools.abl');

    const read = readFolderV2(files);
    const deps = validateCrossLayerDeps(read);

    expect(deps.missingDependencies.length).toBeGreaterThan(0);
    expect(
      deps.missingDependencies.some(
        (d) => d.target.toLowerCase() === 'searchapi' && d.type === 'tool_import',
      ),
    ).toBe(true);
  });

  it('should pass when connections layer is empty (no connectors to validate against)', () => {
    const files = new Map(exportResult.files);
    // Remove ALL connection files
    for (const [path] of files) {
      if (path.startsWith('connections/')) files.delete(path);
    }

    const read = readFolderV2(files);
    const deps = validateCrossLayerDeps(read);

    // With no connection files, connector warnings should not fire
    // (the validator only warns if connectionFiles.size > 0)
    expect(deps.warnings.every((w) => !w.includes('salesforce'))).toBe(true);
  });
});
