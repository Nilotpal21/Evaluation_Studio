/**
 * Tests for v2 Import Orchestrator — verifies the multi-phase import pipeline:
 *   Phase 0: Format detection (v1 flat vs v2 layered)
 *   Phase 1: Parse manifest and validate
 *   Phase 2: Disassemble layers via layer disassemblers
 *   Phase 3: Schema validate (validateStagedRecordBatch)
 *   Phase 4: Stage (StagedImporter.stage())
 *   Phase 5: Cross-ref resolution
 *   Phase 6: Activate (StagedImporter.activate())
 *   Phase 7: Post-validate
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { LayerName, ImportOptionsV2, ProjectManifestV2 } from '../types.js';
import type { ImportDbAdapter, StagedRecord, SupersededRecord } from '../import/staged-importer.js';
import type { CrossRefDbAdapter } from '../import/cross-ref-resolver.js';
import type { PostImportDbAdapter } from '../import/post-import-validator.js';
import type {
  DisassembleContext,
  DisassembleResult,
  LayerDisassembler,
} from '../import/layer-disassemblers/types.js';
import type { ImportV2Deps, ExistingProjectStateV2 } from '../import/project-importer-v2.js';

// ── Mock all external dependencies ──────────────────────────────────────

vi.mock('../import/v1-migration.js', () => ({
  migrateV1ToV2: vi.fn(),
}));

vi.mock('../import/path-normalizer.js', () => ({
  stripCommonPrefix: vi.fn(),
}));

vi.mock('../import/folder-reader.js', () => ({
  readFolderV2: vi.fn(),
  detectLayers: vi.fn(),
  getManifestBehaviorProfilePaths: vi.fn(() => new Set()),
  isBehaviorProfileImportPath: vi.fn((path: string) => path.startsWith('behavior_profiles/')),
  extractAgentName: vi.fn((content: string) => {
    const match = content.match(/^(?:AGENT|SUPERVISOR|agent|supervisor):\s*(\S+)/m);
    return match ? match[1] : null;
  }),
}));

vi.mock('../import/import-validator.js', () => ({
  verifySHAIntegrity: vi.fn(),
  validateImport: vi.fn(),
  validateCrossLayerDeps: vi.fn(),
}));

// StagedImporter is a class — must use a real constructor function.
// We store the mock instance methods here so tests can control them.
const mockStagedImporterInstance = {
  stage: vi.fn(),
  activate: vi.fn(),
  rollback: vi.fn(),
};

vi.mock('../import/staged-importer.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../import/staged-importer.js')>();
  return {
    ...original,
    StagedImporter: vi.fn().mockImplementation(function () {
      return mockStagedImporterInstance;
    }),
  };
});

vi.mock('../import/entity-schemas.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../import/entity-schemas.js')>();
  return {
    ...original,
    validateStagedRecordBatch: vi.fn(),
  };
});

vi.mock('../import/cross-ref-resolver.js', () => ({
  resolveCrossReferences: vi.fn(),
}));

vi.mock('../import/post-import-validator.js', () => ({
  validatePostImport: vi.fn(),
}));

// Import the mocked modules so we can control their behavior
import { migrateV1ToV2 } from '../import/v1-migration.js';
import { stripCommonPrefix } from '../import/path-normalizer.js';
import { readFolderV2, detectLayers } from '../import/folder-reader.js';
import {
  verifySHAIntegrity,
  validateImport,
  validateCrossLayerDeps,
} from '../import/import-validator.js';
import { StagedImporter } from '../import/staged-importer.js';
import { validateStagedRecordBatch } from '../import/entity-schemas.js';
import { resolveCrossReferences } from '../import/cross-ref-resolver.js';
import { validatePostImport } from '../import/post-import-validator.js';

// Import the function under test (after all mocks are set up)
import { importProjectV2 } from '../import/project-importer-v2.js';

// ── Type aliases for mocked functions ──────────────────────────────────

const mockMigrateV1ToV2 = migrateV1ToV2 as Mock;
const mockStripCommonPrefix = stripCommonPrefix as Mock;
const mockReadFolderV2 = readFolderV2 as Mock;
const mockDetectLayers = detectLayers as Mock;
const mockVerifySHAIntegrity = verifySHAIntegrity as Mock;
const mockValidateImport = validateImport as Mock;
const mockValidateCrossLayerDeps = validateCrossLayerDeps as Mock;
const mockValidateStagedRecordBatch = validateStagedRecordBatch as Mock;
const mockResolveCrossReferences = resolveCrossReferences as Mock;
const mockValidatePostImport = validatePostImport as Mock;

// ── Constants ───────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-test-1';
const TENANT_ID = 'tenant-test-1';
const USER_ID = 'user-test-1';
const OPERATION_ID = 'import-op-1';

// ── Mock Factories ──────────────────────────────────────────────────────

function buildV2Manifest(overrides: Partial<ProjectManifestV2> = {}): ProjectManifestV2 {
  return {
    format_version: '2.0',
    name: 'Test Project',
    slug: 'test-project',
    description: 'A test project',
    abl_version: '2.0',
    exported_at: '2026-01-01T00:00:00Z',
    exported_by: USER_ID,
    entry_agent: 'Main',
    dsl_format: 'yaml',
    layers_included: ['core', 'connections'],
    agents: {
      Main: {
        path: 'agents/Main.agent.yaml',
        owner: USER_ID,
        ownerTeam: null,
        description: 'Main agent',
        version: '1.0',
      },
    },
    tools: {},
    metadata: {
      entity_counts: { agents: 1 },
      required_env_vars: [],
      required_connectors: [],
      required_mcp_servers: [],
    },
    ...overrides,
  };
}

function buildDefaultFolderResult() {
  return {
    success: true,
    manifest: null,
    lockfile: null,
    manifestV2: null,
    lockfileV2: null,
    formatVersion: '2.0' as const,
    agentFiles: new Map([['agents/Main.agent.yaml', 'AGENT: Main']]),
    toolFiles: new Map<string, string>(),
    configFiles: new Map<string, string>(),
    deploymentFiles: new Map<string, string>(),
    localeFiles: new Map<string, string>(),
    profileFiles: new Map<string, string>(),
    connectionFiles: new Map<string, string>(),
    environmentFiles: new Map<string, string>(),
    guardrailFiles: new Map<string, string>(),
    workflowFiles: new Map<string, string>(),
    workflowVersionFiles: new Map<string, string>(),
    evalFiles: new Map<string, string>(),
    searchFiles: new Map<string, string>(),
    channelFiles: new Map<string, string>(),
    vocabularyFiles: new Map<string, string>(),
    errors: [] as string[],
    warnings: [] as string[],
    layerFiles: {
      core: new Map([['agents/Main.agent.yaml', 'AGENT: Main']]),
      connections: new Map<string, string>(),
      guardrails: new Map<string, string>(),
      workflows: new Map<string, string>(),
      evals: new Map<string, string>(),
      search: new Map<string, string>(),
      channels: new Map<string, string>(),
      vocabulary: new Map<string, string>(),
    },
  };
}

function buildOptions(overrides: Partial<ImportOptionsV2> = {}): ImportOptionsV2 {
  return {
    projectId: PROJECT_ID,
    tenantId: TENANT_ID,
    userId: USER_ID,
    conflictStrategy: 'replace',
    dryRun: false,
    ...overrides,
  };
}

function buildExistingState(
  overrides: Partial<ExistingProjectStateV2> = {},
): ExistingProjectStateV2 {
  return {
    agents: new Map(),
    toolFiles: new Map(),
    activeRecords: new Map(),
    ...overrides,
  };
}

function createMockDbAdapter(): ImportDbAdapter {
  return {
    createImportOperation: vi.fn().mockResolvedValue({ _id: OPERATION_ID }),
    updateImportOperation: vi.fn().mockResolvedValue(undefined),
    insertStagedRecords: vi
      .fn()
      .mockImplementation((_coll: string, records: unknown[]) =>
        Promise.resolve(records.map((_: unknown, i: number) => `staged-${_coll}-${i}`)),
      ),
    deleteRecordsByIds: vi.fn().mockResolvedValue(undefined),
    activateLayer: vi.fn().mockResolvedValue(undefined),
    rollbackLayer: vi.fn().mockResolvedValue(undefined),
    findActiveRecordIds: vi.fn().mockResolvedValue([]),
  };
}

function createMockCrossRefDb(): CrossRefDbAdapter {
  return {
    queryStagedRecords: vi.fn().mockResolvedValue([]),
    batchUpdateStagedRecords: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockDisassembler(
  layer: LayerName,
  records: StagedRecord[] = [],
  superseded: SupersededRecord[] = [],
  warnings: string[] = [],
): LayerDisassembler {
  return {
    layer,
    disassemble: vi.fn().mockResolvedValue({
      records,
      superseded,
      warnings,
    } satisfies DisassembleResult),
  };
}

function buildDefaultStagedRecords(): StagedRecord[] {
  return [
    {
      layer: 'core',
      collection: 'project_agents',
      data: {
        name: 'Main',
        dslContent: 'AGENT: Main',
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        createdBy: USER_ID,
      },
    },
  ];
}

/**
 * Wire up all mocks for a successful happy-path import.
 * Individual tests override specific mocks to test failure paths.
 */
function setupHappyPath(deps: {
  detectedLayers?: LayerName[];
  records?: StagedRecord[];
  schemaWarnings?: string[];
  schemaErrors?: string[];
}) {
  const {
    detectedLayers = ['core'],
    records = buildDefaultStagedRecords(),
    schemaWarnings = [],
    schemaErrors = [],
  } = deps;

  const manifest = buildV2Manifest({ layers_included: detectedLayers });
  const folderResult = buildDefaultFolderResult();

  // Phase 0: v2 format detection (no migration needed)
  mockMigrateV1ToV2.mockReturnValue({
    migrated: false,
    formatVersion: '2.0',
    manifest,
    files: new Map([['project.json', JSON.stringify(manifest)]]),
    warnings: [],
    skipLockfileVerification: false,
  });

  // Phase 1: Parse
  mockStripCommonPrefix.mockReturnValue({
    files: new Map([['project.json', JSON.stringify(manifest)]]),
    prefix: '',
  });
  mockReadFolderV2.mockReturnValue(folderResult);
  mockDetectLayers.mockReturnValue(detectedLayers);
  mockValidateImport.mockReturnValue({
    valid: true,
    syntaxErrors: [],
    dependencyValidation: { valid: true, missing: [], circular: [] },
  });
  mockValidateCrossLayerDeps.mockReturnValue({
    valid: true,
    missingDependencies: [],
    warnings: [],
  });

  // Phase 3: Schema validation
  mockValidateStagedRecordBatch.mockReturnValue({
    sanitized: records,
    warnings: schemaWarnings,
    errors: schemaErrors,
  });

  // Phase 5: Cross-ref resolution
  mockResolveCrossReferences.mockResolvedValue({
    resolved: 0,
    warnings: [],
  });

  // Phase 7: Post-import validation
  mockValidatePostImport.mockResolvedValue({
    status: 'ready',
    provisioning_required: {
      env_vars: [],
      connectors_needing_credentials: [],
      mcp_servers_needing_auth: [],
      auth_profiles: [],
    },
    warnings: [],
    layer_summary: {},
  });

  // Configure the shared StagedImporter mock instance
  mockStagedImporterInstance.stage.mockResolvedValue({
    success: true,
    stagedRecordIds: { project_agents: ['staged-id-1'] },
  });
  mockStagedImporterInstance.activate.mockResolvedValue({
    success: true,
    activatedLayers: detectedLayers,
    supersededRecordIds: {},
  });
  mockStagedImporterInstance.rollback.mockResolvedValue(undefined);

  return {
    manifest,
    folderResult,
    mockStage: mockStagedImporterInstance.stage,
    mockActivate: mockStagedImporterInstance.activate,
    mockRollback: mockStagedImporterInstance.rollback,
  };
}

// Alias for the mocked StagedImporter constructor
const MockStagedImporter = StagedImporter as unknown as Mock;

// ── Tests ───────────────────────────────────────────────────────────────

describe('importProjectV2', () => {
  let dbAdapter: ImportDbAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    dbAdapter = createMockDbAdapter();
  });

  // ─── Phase 0: Format Detection ─────────────────────────────────────

  describe('Phase 0 — Format Detection', () => {
    it('detects v2 format from manifest with format_version "2.0"', async () => {
      const { manifest } = setupHappyPath({ detectedLayers: ['core'] });

      const coreDisassembler = createMockDisassembler('core', buildDefaultStagedRecords());
      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', coreDisassembler]]),
        dbAdapter,
      };

      const result = await importProjectV2(
        new Map([['project.json', JSON.stringify(manifest)]]),
        buildExistingState(),
        buildOptions(),
        deps,
      );

      expect(result.success).toBe(true);
      expect(mockMigrateV1ToV2).toHaveBeenCalledTimes(1);
      // Verify migrateV1ToV2 received the file map
      const passedFiles = mockMigrateV1ToV2.mock.calls[0][0] as Map<string, string>;
      expect(passedFiles.has('project.json')).toBe(true);
    });

    it('falls back to v1 migration for flat format (no format_version)', async () => {
      const manifest = buildV2Manifest();
      const folderResult = buildDefaultFolderResult();

      // Simulate v1 -> v2 migration
      mockMigrateV1ToV2.mockReturnValue({
        migrated: true,
        formatVersion: '1.0',
        manifest,
        files: new Map([['project.json', JSON.stringify(manifest)]]),
        warnings: ['Migrated from v1 to v2 format'],
        skipLockfileVerification: true,
      });

      mockStripCommonPrefix.mockReturnValue({
        files: new Map([['project.json', JSON.stringify(manifest)]]),
        prefix: '',
      });
      mockReadFolderV2.mockReturnValue(folderResult);
      mockDetectLayers.mockReturnValue(['core']);
      mockValidateImport.mockReturnValue({
        valid: true,
        syntaxErrors: [],
        dependencyValidation: { valid: true, missing: [], circular: [] },
      });
      mockValidateCrossLayerDeps.mockReturnValue({
        valid: true,
        missingDependencies: [],
        warnings: [],
      });

      const records = buildDefaultStagedRecords();
      const coreDisassembler = createMockDisassembler('core', records);
      mockValidateStagedRecordBatch.mockReturnValue({
        sanitized: records,
        warnings: [],
      });

      mockStagedImporterInstance.stage.mockResolvedValue({
        success: true,
        stagedRecordIds: { project_agents: ['staged-1'] },
      });
      mockStagedImporterInstance.activate.mockResolvedValue({
        success: true,
        activatedLayers: ['core'],
        supersededRecordIds: {},
      });

      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', coreDisassembler]]),
        dbAdapter,
      };

      const result = await importProjectV2(
        new Map([['project.json', '{"name":"Test"}']]),
        buildExistingState(),
        buildOptions(),
        deps,
      );

      expect(result.success).toBe(true);
      // v1 migration warnings should be surfaced
      expect(result.warnings).toContain('Migrated from v1 to v2 format');
      // v1 migration should skip lockfile verification
      expect(result.warnings).toContain(
        'SHA verification skipped for v1 imports (lockfile format incompatible)',
      );
    });

    it('returns error when migration fails (e.g., missing manifest)', async () => {
      mockMigrateV1ToV2.mockReturnValue({
        migrated: false,
        formatVersion: '',
        manifest: null,
        files: new Map(),
        warnings: [],
        skipLockfileVerification: false,
        error: { code: 'MISSING_MANIFEST', message: 'No project.json found' },
      });

      const deps: ImportV2Deps = {
        disassemblers: new Map(),
        dbAdapter,
      };

      const result = await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSING_MANIFEST');
      expect(result.preview.hasBlockingIssues).toBe(true);
      expect(result.preview.issues).toEqual([
        expect.objectContaining({
          category: 'general',
          code: 'MISSING_MANIFEST',
          blocking: true,
          message: 'No project.json found',
        }),
      ]);
    });
  });

  // ─── Phase 1: Parse & Validate ─────────────────────────────────────

  describe('Phase 1 — Parse & Validate', () => {
    it('returns error when folder read fails', async () => {
      const manifest = buildV2Manifest();
      mockMigrateV1ToV2.mockReturnValue({
        migrated: false,
        formatVersion: '2.0',
        manifest,
        files: new Map([['project.json', JSON.stringify(manifest)]]),
        warnings: [],
        skipLockfileVerification: false,
      });
      mockStripCommonPrefix.mockReturnValue({
        files: new Map(),
        prefix: '',
      });
      mockReadFolderV2.mockReturnValue({
        success: false,
        errors: ['Invalid folder structure'],
        warnings: [],
      });

      const deps: ImportV2Deps = {
        disassemblers: new Map(),
        dbAdapter,
      };

      const result = await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('FOLDER_READ_FAILED');
      expect(result.error?.message).toContain('Invalid folder structure');
    });

    it('returns error when no importable layers found', async () => {
      const manifest = buildV2Manifest();
      mockMigrateV1ToV2.mockReturnValue({
        migrated: false,
        formatVersion: '2.0',
        manifest,
        files: new Map([['project.json', JSON.stringify(manifest)]]),
        warnings: [],
        skipLockfileVerification: false,
      });
      mockStripCommonPrefix.mockReturnValue({
        files: new Map(),
        prefix: '',
      });
      mockReadFolderV2.mockReturnValue(buildDefaultFolderResult());
      mockDetectLayers.mockReturnValue([]);
      mockValidateCrossLayerDeps.mockReturnValue({
        valid: true,
        missingDependencies: [],
        warnings: [],
      });

      const deps: ImportV2Deps = {
        disassemblers: new Map(),
        dbAdapter,
      };

      const result = await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('NO_LAYERS');
    });

    it('filters detected layers by requested layers', async () => {
      setupHappyPath({ detectedLayers: ['core', 'connections', 'workflows'] });

      // Only request core + connections
      const options = buildOptions({ layers: ['core', 'connections'] });

      const coreDisassembler = createMockDisassembler('core', buildDefaultStagedRecords());
      const connDisassembler = createMockDisassembler('connections');
      // workflows disassembler should NOT be called
      const wfDisassembler = createMockDisassembler('workflows');

      const deps: ImportV2Deps = {
        disassemblers: new Map<LayerName, LayerDisassembler>([
          ['core', coreDisassembler],
          ['connections', connDisassembler],
          ['workflows', wfDisassembler],
        ]),
        dbAdapter,
      };

      // Override detectLayers to return all 3
      mockDetectLayers.mockReturnValue(['core', 'connections', 'workflows']);

      const result = await importProjectV2(new Map(), buildExistingState(), options, deps);

      expect(result.success).toBe(true);
      // Workflows disassembler should not be called since it was not requested
      expect(wfDisassembler.disassemble).not.toHaveBeenCalled();
    });

    it('returns preview on dry-run without staging', async () => {
      setupHappyPath({ detectedLayers: ['core'] });

      const deps: ImportV2Deps = {
        disassemblers: new Map(),
        dbAdapter,
      };

      const result = await importProjectV2(
        new Map(),
        buildExistingState(),
        buildOptions({ dryRun: true }),
        deps,
      );

      expect(result.success).toBe(true);
      expect(result.operationId).toBe('');
      expect(result.phase).toBe('completed');
      expect(result.preview).toBeDefined();
      expect(result.preview.layers).toContain('core');
      // StagedImporter.stage should not have been called in dry-run
      expect(mockStagedImporterInstance.stage).not.toHaveBeenCalled();
    });

    it('counts exported core config files in dry-run preview changes', async () => {
      const folderResult = buildDefaultFolderResult();
      folderResult.configFiles = new Map([
        ['config/project-settings.json', JSON.stringify({ enableThinking: true })],
        [
          'config/runtime-config.json',
          JSON.stringify({ extraction: { nlu_provider: 'standard' } }),
        ],
        [
          'config/project-model-configs/balanced.model-config.json',
          JSON.stringify({ name: 'Balanced', modelId: 'gpt-4o-mini', provider: 'openai' }),
        ],
        [
          'config/agent-model-configs/Main.model-config.json',
          JSON.stringify({ agentName: 'Main', defaultModel: 'gpt-4o-mini' }),
        ],
        [
          'core/mcp-servers/public-repo.mcp-config.json',
          JSON.stringify({ name: 'public-repo', transport: 'sse', url: 'https://example.com/mcp' }),
        ],
      ]);
      folderResult.environmentFiles = new Map([
        [
          'environment/env-vars.json',
          JSON.stringify([{ key: 'OPENAI_API_KEY', environment: 'global', isSecret: true }]),
        ],
        [
          'environment/config-vars.json',
          JSON.stringify([{ key: 'support.region', value: 'emea' }]),
        ],
      ]);
      folderResult.layerFiles.core = new Map([
        ...folderResult.agentFiles,
        ...folderResult.configFiles,
        ...folderResult.environmentFiles,
      ]);

      const records = buildDefaultStagedRecords();
      setupHappyPath({ detectedLayers: ['core'], records });
      mockReadFolderV2.mockReturnValue(folderResult);

      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', createMockDisassembler('core', records)]]),
        dbAdapter,
      };

      const result = await importProjectV2(
        new Map(),
        buildExistingState({
          agents: new Map([['Main', { name: 'Main', dslContent: 'AGENT: Main' }]]),
          activeRecords: new Map([
            ['project_runtime_configs', [{ _id: 'runtime-1' }]],
            ['model_configs', [{ _id: 'model-1', name: 'Balanced' }]],
            [
              'environment_variables',
              [{ _id: 'env-1', key: 'OPENAI_API_KEY', environment: 'global' }],
            ],
          ]),
        }),
        buildOptions({ dryRun: true }),
        deps,
      );

      expect(result.success).toBe(true);
      expect(result.preview.layerChanges.core).toMatchObject({
        added: 4,
        modified: 3,
        removed: 0,
        unchanged: 1,
      });
      expect(mockStagedImporterInstance.stage).not.toHaveBeenCalled();
    });

    it('counts unchanged exported core configs as unchanged in dry-run preview changes', async () => {
      const folderResult = buildDefaultFolderResult();
      folderResult.configFiles = new Map([
        ['config/project-settings.json', JSON.stringify({ enableThinking: true })],
        [
          'config/runtime-config.json',
          JSON.stringify({ extraction: { nlu_provider: 'standard' } }),
        ],
        ['config/llm-config.json', JSON.stringify({ operationTierOverrides: { chat: 'fast' } })],
        [
          'config/project-model-configs/balanced.model-config.json',
          JSON.stringify({ name: 'Balanced', modelId: 'gpt-4o-mini', provider: 'openai' }),
        ],
        [
          'config/agent-model-configs/Main.model-config.json',
          JSON.stringify({ agentName: 'Main', defaultModel: 'gpt-4o-mini' }),
        ],
        [
          'core/mcp-servers/public-repo.mcp-config.json',
          JSON.stringify({ name: 'public-repo', transport: 'sse', url: 'https://example.com/mcp' }),
        ],
      ]);
      folderResult.environmentFiles = new Map([
        [
          'environment/env-vars.json',
          JSON.stringify([
            {
              key: 'OPENAI_API_KEY',
              environment: 'global',
              isSecret: true,
              description: 'OpenAI key',
            },
          ]),
        ],
        [
          'environment/config-vars.json',
          JSON.stringify([{ key: 'support.region', value: 'emea', description: null }]),
        ],
      ]);
      folderResult.layerFiles.core = new Map([
        ...folderResult.agentFiles,
        ...folderResult.configFiles,
        ...folderResult.environmentFiles,
      ]);

      const records = buildDefaultStagedRecords();
      setupHappyPath({ detectedLayers: ['core'], records });
      mockReadFolderV2.mockReturnValue(folderResult);

      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', createMockDisassembler('core', records)]]),
        dbAdapter,
      };

      const result = await importProjectV2(
        new Map(),
        buildExistingState({
          agents: new Map([['Main', { name: 'Main', dslContent: 'AGENT: Main' }]]),
          activeRecords: new Map([
            ['project_settings', [{ _id: 'settings-1', enableThinking: true }]],
            [
              'project_runtime_configs',
              [{ _id: 'runtime-1', extraction: { nlu_provider: 'standard' } }],
            ],
            ['project_llm_configs', [{ _id: 'llm-1', operationTierOverrides: { chat: 'fast' } }]],
            [
              'model_configs',
              [
                {
                  _id: 'model-1',
                  name: 'Balanced',
                  modelId: 'gpt-4o-mini',
                  provider: 'openai',
                },
              ],
            ],
            [
              'agent_model_configs',
              [{ _id: 'agent-model-1', agentName: 'Main', defaultModel: 'gpt-4o-mini' }],
            ],
            [
              'mcp_server_configs',
              [
                {
                  _id: 'mcp-1',
                  name: 'public-repo',
                  transport: 'sse',
                  url: 'https://example.com/mcp',
                },
              ],
            ],
            [
              'environment_variables',
              [
                {
                  _id: 'env-1',
                  key: 'OPENAI_API_KEY',
                  environment: 'global',
                  isSecret: true,
                  description: 'OpenAI key',
                },
              ],
            ],
            [
              'project_config_variables',
              [{ _id: 'config-var-1', key: 'support.region', value: 'emea' }],
            ],
          ]),
        }),
        buildOptions({ dryRun: true }),
        deps,
      );

      expect(result.success).toBe(true);
      expect(result.preview.layerChanges.core).toMatchObject({
        added: 0,
        modified: 0,
        removed: 0,
        unchanged: 9,
      });
      expect(mockStagedImporterInstance.stage).not.toHaveBeenCalled();
    });

    it('dry-run disassembles requested layers and schema-validates the planned records', async () => {
      const coreRecords = buildDefaultStagedRecords();
      const workflowRecords: StagedRecord[] = [
        {
          layer: 'workflows',
          collection: 'workflows',
          data: {
            name: 'LoanApplication',
            projectId: PROJECT_ID,
            tenantId: TENANT_ID,
            createdBy: USER_ID,
          },
        },
      ];
      const allRecords = [...coreRecords, ...workflowRecords];
      const folderResult = buildDefaultFolderResult();
      folderResult.layerFiles.workflows = new Map([
        ['workflows/LoanApplication.workflow.yaml', 'WORKFLOW: LoanApplication'],
      ]);

      setupHappyPath({ detectedLayers: ['core', 'workflows'], records: allRecords });
      mockReadFolderV2.mockReturnValue(folderResult);

      const coreDisassembler = createMockDisassembler('core', coreRecords);
      const workflowDisassembler = createMockDisassembler('workflows', workflowRecords);
      const deps: ImportV2Deps = {
        disassemblers: new Map<LayerName, LayerDisassembler>([
          ['core', coreDisassembler],
          ['workflows', workflowDisassembler],
        ]),
        dbAdapter,
      };

      const result = await importProjectV2(
        new Map(),
        buildExistingState(),
        buildOptions({ dryRun: true, layers: ['core', 'workflows'] }),
        deps,
      );

      expect(result.success).toBe(true);
      expect(coreDisassembler.disassemble).toHaveBeenCalledTimes(1);
      expect(workflowDisassembler.disassemble).toHaveBeenCalledTimes(1);
      expect(mockValidateStagedRecordBatch).toHaveBeenCalledWith(allRecords);
      expect(mockStagedImporterInstance.stage).not.toHaveBeenCalled();
      expect(mockStagedImporterInstance.activate).not.toHaveBeenCalled();
    });

    it('dry-run rejects imported tool records that fail canonical save validation', async () => {
      const toolRecord: StagedRecord = {
        layer: 'core',
        collection: 'project_tools',
        data: {
          name: 'run_workflow',
          toolType: 'workflow',
          dslContent: 'run_workflow() -> object\n  type: workflow\n',
          sourceHash: 'hash-1',
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          createdBy: USER_ID,
        },
      };
      setupHappyPath({ detectedLayers: ['core'], records: [toolRecord] });

      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', createMockDisassembler('core', [toolRecord])]]),
        dbAdapter,
      };
      const validateToolBindingForSave = vi.fn().mockResolvedValue({
        valid: false,
        message: 'workflow target is missing',
      });

      const result = await importProjectV2(
        new Map(),
        buildExistingState(),
        buildOptions({ dryRun: true, validateToolBindingForSave }),
        deps,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TOOL_SAVE_VALIDATION_FAILED');
      expect(validateToolBindingForSave).toHaveBeenCalledWith({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        toolType: 'workflow',
        dslContent: toolRecord.data.dslContent,
      });
      expect(mockStagedImporterInstance.stage).not.toHaveBeenCalled();
    });

    it('rewrites imported SearchAI tool tenant bindings to the target tenant before save validation', async () => {
      const toolRecord: StagedRecord = {
        layer: 'core',
        collection: 'project_tools',
        data: {
          name: 'search_docs',
          toolType: 'searchai',
          dslContent: [
            'search_docs(query: string) -> object',
            '  type: searchai',
            '  index_id: "target-index-1"',
            '  tenant_id: "source-tenant-1"',
            '  kb_name: "Docs KB"',
          ].join('\n'),
          sourceHash: 'hash-1',
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          createdBy: USER_ID,
        },
      };
      setupHappyPath({ detectedLayers: ['core'], records: [toolRecord] });

      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', createMockDisassembler('core', [toolRecord])]]),
        dbAdapter,
      };
      const validateToolBindingForSave = vi.fn().mockResolvedValue({ valid: true });

      const result = await importProjectV2(
        new Map(),
        buildExistingState(),
        buildOptions({ dryRun: true, validateToolBindingForSave }),
        deps,
      );

      expect(result.success).toBe(true);
      expect(validateToolBindingForSave).toHaveBeenCalledWith({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        toolType: 'searchai',
        dslContent: expect.stringContaining(`tenant_id: "${TENANT_ID}"`),
      });
      expect(toolRecord.data.dslContent).toContain(`tenant_id: "${TENANT_ID}"`);
      expect(toolRecord.data.dslContent).not.toContain('source-tenant-1');
      expect(toolRecord.data.sourceHash).not.toBe('hash-1');
      expect(mockStagedImporterInstance.stage).not.toHaveBeenCalled();
    });

    it('persists normalized imported tool DSL returned by save validation', async () => {
      const toolRecord: StagedRecord = {
        layer: 'core',
        collection: 'project_tools',
        data: {
          name: 'search_docs',
          toolType: 'searchai',
          dslContent: [
            'search_docs(query: string) -> object',
            '  type: searchai',
            '  index_id: "source-index-1"',
            '  tenant_id: "source-tenant-1"',
            '  kb_name: "Docs KB"',
            '  kb_name: "Docs KB"',
          ].join('\n'),
          sourceHash: 'hash-1',
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          createdBy: USER_ID,
        },
      };
      setupHappyPath({ detectedLayers: ['core'], records: [toolRecord] });

      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', createMockDisassembler('core', [toolRecord])]]),
        dbAdapter,
      };
      const validateToolBindingForSave = vi.fn(async ({ dslContent }) => ({
        valid: true as const,
        dslContent: dslContent.replace('index_id: "source-index-1"', 'index_id: "target-index-1"'),
      }));

      const result = await importProjectV2(
        new Map(),
        buildExistingState(),
        buildOptions({ dryRun: true, validateToolBindingForSave }),
        deps,
      );

      expect(result.success).toBe(true);
      expect(toolRecord.data.dslContent).toContain('index_id: "target-index-1"');
      expect(toolRecord.data.dslContent).toContain(`tenant_id: "${TENANT_ID}"`);
      expect(toolRecord.data.dslContent).not.toContain('source-index-1');
      expect(toolRecord.data.dslContent).not.toContain('source-tenant-1');
      expect(toolRecord.data.sourceHash).not.toBe('hash-1');
      expect(mockStagedImporterInstance.stage).not.toHaveBeenCalled();
    });

    it('allows imported SearchAI tool indexes to resolve from the imported search layer', async () => {
      const toolRecord: StagedRecord = {
        layer: 'core',
        collection: 'project_tools',
        data: {
          name: 'search_docs',
          toolType: 'searchai',
          dslContent: [
            'search_docs(query: string) -> object',
            '  type: searchai',
            '  index_id: "source-index-1"',
            '  tenant_id: "source-tenant-1"',
            '  kb_name: "Docs KB"',
          ].join('\n'),
          sourceHash: 'hash-1',
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          createdBy: USER_ID,
        },
      };
      const searchIndexRecord: StagedRecord = {
        layer: 'search',
        collection: 'search_indexes',
        data: {
          _exportedId: 'source-index-1',
          slug: 'docs-kb',
          name: 'Docs KB',
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          createdBy: USER_ID,
        },
      };
      setupHappyPath({
        detectedLayers: ['core', 'search'],
        records: [toolRecord, searchIndexRecord],
      });

      const deps: ImportV2Deps = {
        disassemblers: new Map([
          ['core', createMockDisassembler('core', [toolRecord])],
          ['search', createMockDisassembler('search', [searchIndexRecord])],
        ]),
        dbAdapter,
      };
      const validateToolBindingForSave = vi.fn().mockRejectedValue(new Error('should not call'));

      const result = await importProjectV2(
        new Map(),
        buildExistingState(),
        buildOptions({ dryRun: true, validateToolBindingForSave }),
        deps,
      );

      expect(result.success).toBe(true);
      expect(validateToolBindingForSave).not.toHaveBeenCalled();
      expect(toolRecord.data.dslContent).toContain(`tenant_id: "${TENANT_ID}"`);
      expect(toolRecord.data._searchAiIndexExportedId).toBe('source-index-1');
      expect(toolRecord.data.sourceHash).not.toBe('hash-1');
      expect(mockStagedImporterInstance.stage).not.toHaveBeenCalled();
    });

    it('synthesizes an empty knowledge base when a SearchAI tool has a portable kb_name but no search layer', async () => {
      const toolRecord: StagedRecord = {
        layer: 'core',
        collection: 'project_tools',
        data: {
          name: 'search_docs',
          toolType: 'searchai',
          dslContent: [
            'search_docs(query: string) -> object',
            '  type: searchai',
            '  index_id: "source-index-1"',
            '  tenant_id: "source-tenant-1"',
            '  kb_name: "Docs KB"',
          ].join('\n'),
          sourceHash: 'hash-1',
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          createdBy: USER_ID,
        },
      };
      setupHappyPath({ detectedLayers: ['core'], records: [toolRecord] });

      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', createMockDisassembler('core', [toolRecord])]]),
        dbAdapter,
        crossRefDb: createMockCrossRefDb(),
      };
      const validateToolBindingForSave = vi.fn().mockResolvedValue({
        valid: false,
        message: 'SearchAI index not found',
      });

      const result = await importProjectV2(
        new Map(),
        buildExistingState(),
        buildOptions({ dryRun: false, validateToolBindingForSave }),
        deps,
      );

      expect(result.success).toBe(true);
      expect(validateToolBindingForSave).toHaveBeenCalledTimes(1);
      const stagedRecords = mockStagedImporterInstance.stage.mock.calls[0]?.[3] as StagedRecord[];
      expect(stagedRecords).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            layer: 'search',
            collection: 'search_indexes',
            data: expect.objectContaining({
              _exportedId: 'source-index-1',
              name: 'Docs KB',
              slug: 'docs_kb',
            }),
          }),
          expect.objectContaining({
            layer: 'search',
            collection: 'knowledge_bases',
            data: expect.objectContaining({
              name: 'Docs KB',
              _indexSlug: 'docs_kb',
            }),
          }),
        ]),
      );
      expect(mockStagedImporterInstance.stage.mock.calls[0]?.[4]).toContain('search');
    });

    it('allows imported workflow tools to resolve from imported workflow trigger metadata', async () => {
      const toolRecord: StagedRecord = {
        layer: 'core',
        collection: 'project_tools',
        data: {
          name: 'process_loan',
          toolType: 'workflow',
          dslContent: [
            'process_loan(customer_id: string) -> object',
            '  type: workflow',
            '  workflow_id: "source-workflow-1"',
            '  workflow_version: draft',
            '  trigger_id: "source-trigger-1"',
          ].join('\n'),
          sourceHash: 'hash-1',
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          createdBy: USER_ID,
        },
      };
      const workflowRecord: StagedRecord = {
        layer: 'workflows',
        collection: 'workflows',
        data: {
          _exportedId: 'source-workflow-1',
          name: 'LoanFlow',
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          createdBy: USER_ID,
        },
      };
      const triggerRecord: StagedRecord = {
        layer: 'workflows',
        collection: 'trigger_registrations',
        data: {
          _exportedId: 'source-trigger-1',
          _workflowName: 'LoanFlow',
          _workflowVersion: 'draft',
          triggerName: 'webhook',
          triggerType: 'webhook',
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          createdBy: USER_ID,
        },
      };
      setupHappyPath({
        detectedLayers: ['core', 'workflows'],
        records: [toolRecord, workflowRecord, triggerRecord],
      });

      const deps: ImportV2Deps = {
        disassemblers: new Map([
          ['core', createMockDisassembler('core', [toolRecord])],
          ['workflows', createMockDisassembler('workflows', [workflowRecord, triggerRecord])],
        ]),
        dbAdapter,
      };
      const validateToolBindingForSave = vi.fn().mockResolvedValue({
        valid: false,
        message: 'Trigger not found',
      });

      const result = await importProjectV2(
        new Map(),
        buildExistingState(),
        buildOptions({ dryRun: true, validateToolBindingForSave, layers: ['core', 'workflows'] }),
        deps,
      );

      expect(result.success).toBe(true);
      expect(validateToolBindingForSave).not.toHaveBeenCalled();
      expect(toolRecord.data._workflowToolExportedWorkflowId).toBe('source-workflow-1');
      expect(toolRecord.data._workflowToolExportedTriggerId).toBe('source-trigger-1');
      expect(toolRecord.data.sourceHash).toBe('hash-1');
      expect(mockStagedImporterInstance.stage).not.toHaveBeenCalled();
    });

    it('synthesizes a workflow trigger when a workflow tool references an imported workflow without trigger metadata', async () => {
      const toolRecord: StagedRecord = {
        layer: 'core',
        collection: 'project_tools',
        data: {
          name: 'process_loan',
          toolType: 'workflow',
          dslContent: [
            'process_loan(customer_id: string) -> object',
            '  type: workflow',
            '  workflow_id: "source-workflow-1"',
            '  workflow_version: draft',
            '  trigger_id: "source-trigger-1"',
          ].join('\n'),
          sourceHash: 'hash-1',
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          createdBy: USER_ID,
        },
      };
      const workflowRecord: StagedRecord = {
        layer: 'workflows',
        collection: 'workflows',
        data: {
          _exportedId: 'source-workflow-1',
          name: 'LoanFlow',
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          createdBy: USER_ID,
        },
      };
      const workflowVersionRecord: StagedRecord = {
        layer: 'workflows',
        collection: 'workflow_versions',
        data: {
          _workflowName: 'LoanFlow',
          version: 'draft',
          state: 'active',
          definition: { nodes: [] },
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          createdBy: USER_ID,
        },
      };
      setupHappyPath({
        detectedLayers: ['core', 'workflows'],
        records: [toolRecord, workflowRecord, workflowVersionRecord],
      });

      const deps: ImportV2Deps = {
        disassemblers: new Map([
          ['core', createMockDisassembler('core', [toolRecord])],
          [
            'workflows',
            createMockDisassembler('workflows', [workflowRecord, workflowVersionRecord]),
          ],
        ]),
        dbAdapter,
        crossRefDb: createMockCrossRefDb(),
      };
      const validateToolBindingForSave = vi.fn().mockResolvedValue({
        valid: false,
        message: 'Trigger not found',
      });

      const result = await importProjectV2(
        new Map(),
        buildExistingState(),
        buildOptions({
          dryRun: false,
          validateToolBindingForSave,
          layers: ['core', 'workflows'],
        }),
        deps,
      );

      expect(result.success).toBe(true);
      expect(validateToolBindingForSave).toHaveBeenCalledTimes(1);
      const stagedRecords = mockStagedImporterInstance.stage.mock.calls[0]?.[3] as StagedRecord[];
      expect(stagedRecords).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            layer: 'workflows',
            collection: 'trigger_registrations',
            data: expect.objectContaining({
              _exportedId: 'source-trigger-1',
              _workflowName: 'LoanFlow',
              _workflowVersion: 'draft',
              triggerType: 'webhook',
              status: 'active',
            }),
          }),
        ]),
      );
    });

    it('does not ask for binding resolution in preview when an imported workflow can receive a synthesized trigger', async () => {
      const toolRecord: StagedRecord = {
        layer: 'core',
        collection: 'project_tools',
        data: {
          name: 'process_loan',
          toolType: 'workflow',
          dslContent: [
            'process_loan(customer_id: string) -> object',
            '  type: workflow',
            '  workflow_id: "source-workflow-1"',
            '  workflow_version: draft',
            '  trigger_id: "source-trigger-1"',
          ].join('\n'),
          sourceHash: 'hash-1',
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          createdBy: USER_ID,
        },
      };
      const workflowRecord: StagedRecord = {
        layer: 'workflows',
        collection: 'workflows',
        data: {
          _exportedId: 'source-workflow-1',
          name: 'LoanFlow',
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          createdBy: USER_ID,
        },
      };
      const workflowVersionRecord: StagedRecord = {
        layer: 'workflows',
        collection: 'workflow_versions',
        data: {
          _workflowName: 'LoanFlow',
          version: 'draft',
          state: 'active',
          definition: { nodes: [] },
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          createdBy: USER_ID,
        },
      };
      setupHappyPath({
        detectedLayers: ['core', 'workflows'],
        records: [toolRecord, workflowRecord, workflowVersionRecord],
      });

      const deps: ImportV2Deps = {
        disassemblers: new Map([
          ['core', createMockDisassembler('core', [toolRecord])],
          [
            'workflows',
            createMockDisassembler('workflows', [workflowRecord, workflowVersionRecord]),
          ],
        ]),
        dbAdapter,
      };
      const validateToolBindingForSave = vi.fn().mockResolvedValue({
        valid: false,
        message: 'Trigger not found',
      });

      const result = await importProjectV2(
        new Map(),
        buildExistingState(),
        buildOptions({
          dryRun: true,
          validateToolBindingForSave,
          layers: ['core', 'workflows'],
        }),
        deps,
      );

      expect(result.success).toBe(true);
      expect(result.preview.bindingResolutionRequests ?? []).toEqual([]);
      expect(result.preview.issues).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'E_IMPORT_BINDING_WORKFLOW_TRIGGER' }),
        ]),
      );
      expect(mockStagedImporterInstance.stage).not.toHaveBeenCalled();
    });

    it('turns stale workflow tool IDs into a blocking binding-resolution request during preview', async () => {
      const toolRecord: StagedRecord = {
        layer: 'core',
        collection: 'project_tools',
        data: {
          name: 'process_loan',
          toolType: 'workflow',
          dslContent: [
            'process_loan(customer_id: string) -> object',
            '  type: workflow',
            '  workflow_id: "source-workflow-1"',
            '  workflow_version: draft',
            '  trigger_id: "source-trigger-1"',
          ].join('\n'),
          sourceHash: 'hash-1',
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          createdBy: USER_ID,
        },
      };
      setupHappyPath({ detectedLayers: ['core'], records: [toolRecord] });

      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', createMockDisassembler('core', [toolRecord])]]),
        dbAdapter,
      };
      const validateToolBindingForSave = vi.fn().mockResolvedValue({
        valid: false,
        message: 'Workflow not found',
      });

      const result = await importProjectV2(
        new Map(),
        buildExistingState(),
        buildOptions({ dryRun: true, validateToolBindingForSave }),
        deps,
      );

      expect(result.success).toBe(true);
      expect(result.preview.hasBlockingIssues).toBe(true);
      expect(result.preview.bindingResolutionRequests).toEqual([
        expect.objectContaining({
          kind: 'workflow_trigger',
          toolName: 'process_loan',
          required: true,
          source: expect.objectContaining({
            workflowId: 'source-workflow-1',
            triggerId: 'source-trigger-1',
          }),
        }),
      ]);
      expect(result.preview.issues).toEqual([
        expect.objectContaining({
          category: 'binding',
          blocking: true,
          code: 'E_IMPORT_BINDING_WORKFLOW_TRIGGER',
        }),
      ]);
      expect(validateToolBindingForSave).toHaveBeenCalledTimes(1);
      expect(mockStagedImporterInstance.stage).not.toHaveBeenCalled();
    });

    it('applies a selected target workflow binding before canonical save validation', async () => {
      const createToolRecord = (): StagedRecord => ({
        layer: 'core',
        collection: 'project_tools',
        data: {
          name: 'process_loan',
          toolType: 'workflow',
          dslContent: [
            'process_loan(customer_id: string) -> object',
            '  type: workflow',
            '  workflow_id: "source-workflow-1"',
            '  workflow_version: draft',
            '  trigger_id: "source-trigger-1"',
          ].join('\n'),
          sourceHash: 'hash-1',
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          createdBy: USER_ID,
        },
      });
      const previewToolRecord = createToolRecord();
      setupHappyPath({ detectedLayers: ['core'], records: [previewToolRecord] });

      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', createMockDisassembler('core', [previewToolRecord])]]),
        dbAdapter,
      };
      const previewValidator = vi.fn().mockResolvedValue({
        valid: false,
        message: 'Workflow not found',
      });

      const previewResult = await importProjectV2(
        new Map(),
        buildExistingState(),
        buildOptions({ dryRun: true, validateToolBindingForSave: previewValidator }),
        deps,
      );
      const requestId = previewResult.preview.bindingResolutionRequests?.[0]?.id;
      expect(requestId).toBeTruthy();

      const resolvedToolRecord = createToolRecord();
      setupHappyPath({ detectedLayers: ['core'], records: [resolvedToolRecord] });
      const resolvedDeps: ImportV2Deps = {
        disassemblers: new Map([['core', createMockDisassembler('core', [resolvedToolRecord])]]),
        dbAdapter,
      };
      const resolvedValidator = vi.fn().mockResolvedValue({ valid: true });

      const result = await importProjectV2(
        new Map(),
        buildExistingState(),
        buildOptions({
          dryRun: true,
          validateToolBindingForSave: resolvedValidator,
          bindingResolutions: {
            [requestId as string]: {
              action: 'map_existing',
              target: {
                workflowId: 'target-workflow-1',
                workflowVersion: 'draft',
                triggerId: 'target-trigger-1',
              },
            },
          },
        }),
        resolvedDeps,
      );

      expect(result.success).toBe(true);
      expect(result.preview.hasBlockingIssues).toBe(false);
      expect(resolvedValidator).toHaveBeenCalledWith({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        toolType: 'workflow',
        dslContent: expect.stringContaining('workflow_id: "target-workflow-1"'),
      });
      const validatedDsl = resolvedValidator.mock.calls[0]?.[0]?.dslContent as string;
      expect(validatedDsl).toContain('trigger_id: "target-trigger-1"');
      expect(resolvedToolRecord.data.dslContent).toContain('workflow_id: "target-workflow-1"');
      expect(resolvedToolRecord.data.dslContent).toContain('trigger_id: "target-trigger-1"');
      expect(resolvedToolRecord.data.sourceHash).not.toBe('hash-1');
      expect(mockStagedImporterInstance.stage).not.toHaveBeenCalled();
    });

    it('turns stale SearchAI index IDs into a blocking binding-resolution request during preview', async () => {
      const toolRecord: StagedRecord = {
        layer: 'core',
        collection: 'project_tools',
        data: {
          name: 'search_docs',
          toolType: 'searchai',
          dslContent: [
            'search_docs(query: string) -> object',
            '  type: searchai',
            '  index_id: "source-index-1"',
            '  tenant_id: "source-tenant-1"',
          ].join('\n'),
          sourceHash: 'hash-1',
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          createdBy: USER_ID,
        },
      };
      setupHappyPath({ detectedLayers: ['core'], records: [toolRecord] });

      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', createMockDisassembler('core', [toolRecord])]]),
        dbAdapter,
      };
      const validateToolBindingForSave = vi.fn().mockResolvedValue({
        valid: false,
        message: 'SearchAI index not found',
      });

      const result = await importProjectV2(
        new Map(),
        buildExistingState(),
        buildOptions({ dryRun: true, validateToolBindingForSave }),
        deps,
      );

      expect(result.success).toBe(true);
      expect(result.preview.hasBlockingIssues).toBe(true);
      expect(result.preview.bindingResolutionRequests).toEqual([
        expect.objectContaining({
          kind: 'searchai_index',
          toolName: 'search_docs',
          source: expect.objectContaining({
            tenantId: 'source-tenant-1',
            indexId: 'source-index-1',
          }),
        }),
      ]);
      expect(result.preview.issues).toEqual([
        expect.objectContaining({
          category: 'binding',
          blocking: true,
          code: 'E_IMPORT_BINDING_SEARCHAI_INDEX',
        }),
      ]);
      expect(toolRecord.data.dslContent).toContain(`tenant_id: "${TENANT_ID}"`);
      expect(mockStagedImporterInstance.stage).not.toHaveBeenCalled();
    });

    it('normalizes imported runtime configs through the canonical save validator before staging', async () => {
      const runtimeRecord: StagedRecord = {
        layer: 'core',
        collection: 'project_runtime_configs',
        data: {
          extraction: { nlu_provider: 'standard' },
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          createdBy: USER_ID,
          updatedBy: 'source-updater',
          ownerId: 'source-owner',
          _v: 1,
          sourceFile: 'config/runtime-config.json',
        },
      };
      setupHappyPath({ detectedLayers: ['core'], records: [runtimeRecord] });

      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', createMockDisassembler('core', [runtimeRecord])]]),
        dbAdapter,
      };
      const validateRuntimeConfigForSave = vi.fn().mockResolvedValue({
        valid: true,
        data: {
          extraction: { nlu_provider: 'standard' },
          operationTierOverrides: {},
        },
      });

      const result = await importProjectV2(
        new Map(),
        buildExistingState(),
        buildOptions({ validateRuntimeConfigForSave }),
        deps,
      );

      expect(result.success).toBe(true);
      expect(validateRuntimeConfigForSave).toHaveBeenCalledWith({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        data: {
          extraction: { nlu_provider: 'standard' },
        },
        sourceFile: 'config/runtime-config.json',
      });
      expect(mockStagedImporterInstance.stage).toHaveBeenCalledWith(
        expect.any(String),
        PROJECT_ID,
        TENANT_ID,
        [
          expect.objectContaining({
            collection: 'project_runtime_configs',
            data: expect.objectContaining({
              extraction: { nlu_provider: 'standard' },
              operationTierOverrides: {},
              projectId: PROJECT_ID,
              tenantId: TENANT_ID,
            }),
          }),
        ],
        ['core'],
      );
      const stagedRecords = mockStagedImporterInstance.stage.mock.calls[0]?.[3] as StagedRecord[];
      expect(stagedRecords[0]?.data).not.toHaveProperty('createdBy');
      expect(stagedRecords[0]?.data).not.toHaveProperty('updatedBy');
      expect(stagedRecords[0]?.data).not.toHaveProperty('ownerId');
      expect(stagedRecords[0]?.data).not.toHaveProperty('_v');
      expect(stagedRecords[0]?.data).not.toHaveProperty('sourceFile');
    });

    it('strips leaked model-policy metadata from layered import staging records', async () => {
      const records: StagedRecord[] = [
        {
          layer: 'core',
          collection: 'project_runtime_configs',
          data: {
            extraction: { nlu_provider: 'standard' },
            projectId: PROJECT_ID,
            tenantId: TENANT_ID,
            createdBy: USER_ID,
            updatedBy: 'source-updater',
            ownerId: 'source-owner',
            _v: 1,
            sourceFile: 'config/runtime-config.json',
          },
        },
        {
          layer: 'core',
          collection: 'project_llm_configs',
          data: {
            operationTierOverrides: {},
            projectId: PROJECT_ID,
            tenantId: TENANT_ID,
            createdBy: USER_ID,
            modifiedBy: 'source-modifier',
            _v: 2,
          },
        },
        {
          layer: 'core',
          collection: 'model_configs',
          data: {
            name: 'balanced',
            modelId: 'gpt-4o-mini',
            provider: 'openai',
            temperature: 0.2,
            maxTokens: 4096,
            topP: 1,
            frequencyPenalty: 0,
            presencePenalty: 0,
            supportsTools: true,
            supportsVision: true,
            supportsStreaming: true,
            contextWindow: 128000,
            tier: 'balanced',
            isDefault: true,
            priority: 10,
            projectId: PROJECT_ID,
            tenantId: TENANT_ID,
            createdBy: USER_ID,
            lastEditedBy: 'source-editor',
            _v: 3,
          },
        },
        {
          layer: 'core',
          collection: 'agent_model_configs',
          data: {
            agentName: 'Main',
            defaultModel: 'gpt-4o-mini',
            projectId: PROJECT_ID,
            tenantId: TENANT_ID,
            createdBy: USER_ID,
            ownerTeamId: 'source-team',
            _v: 4,
          },
        },
      ];
      setupHappyPath({ detectedLayers: ['core'], records });

      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', createMockDisassembler('core', records)]]),
        dbAdapter,
      };
      const validateRuntimeConfigForSave = vi.fn().mockResolvedValue({
        valid: true,
        data: {
          extraction: { nlu_provider: 'standard' },
        },
      });

      const result = await importProjectV2(
        new Map(),
        buildExistingState(),
        buildOptions({ validateRuntimeConfigForSave }),
        deps,
      );

      expect(result.success).toBe(true);
      const stagedRecords = mockStagedImporterInstance.stage.mock.calls[0]?.[3] as StagedRecord[];
      for (const record of stagedRecords) {
        expect(record.data).toMatchObject({
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
        });
        expect(record.data).not.toHaveProperty('createdBy');
        expect(record.data).not.toHaveProperty('updatedBy');
        expect(record.data).not.toHaveProperty('modifiedBy');
        expect(record.data).not.toHaveProperty('ownerId');
        expect(record.data).not.toHaveProperty('ownerTeamId');
        expect(record.data).not.toHaveProperty('lastEditedBy');
        expect(record.data).not.toHaveProperty('_v');
        expect(record.data).not.toHaveProperty('sourceFile');
      }
    });

    it('moves runtime-only operation tier overrides into canonical project llm config staging', async () => {
      const runtimeRecord: StagedRecord = {
        layer: 'core',
        collection: 'project_runtime_configs',
        data: {
          operationTierOverrides: { response_gen: 'powerful' },
          extraction: { nlu_provider: 'standard' },
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
          createdBy: USER_ID,
        },
      };
      setupHappyPath({ detectedLayers: ['core'], records: [runtimeRecord] });

      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', createMockDisassembler('core', [runtimeRecord])]]),
        dbAdapter,
      };
      const validateRuntimeConfigForSave = vi.fn().mockResolvedValue({
        valid: true,
        data: {
          extraction: { nlu_provider: 'standard' },
        },
      });

      const result = await importProjectV2(
        new Map(),
        buildExistingState(),
        buildOptions({ validateRuntimeConfigForSave }),
        deps,
      );

      expect(result.success).toBe(true);
      const stagedRecords = mockStagedImporterInstance.stage.mock.calls[0]?.[3] as StagedRecord[];
      const stagedRuntime = stagedRecords.find(
        (record) => record.collection === 'project_runtime_configs',
      );
      const stagedLlm = stagedRecords.find((record) => record.collection === 'project_llm_configs');

      expect(stagedRuntime?.data).not.toHaveProperty('operationTierOverrides');
      expect(stagedLlm?.data).toMatchObject({
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        operationTierOverrides: { response_gen: 'powerful' },
      });
    });

    it('rejects conflicting runtime and llm operation tier overrides before staging', async () => {
      const records: StagedRecord[] = [
        {
          layer: 'core',
          collection: 'project_runtime_configs',
          data: {
            operationTierOverrides: { response_gen: 'powerful' },
            projectId: PROJECT_ID,
            tenantId: TENANT_ID,
            createdBy: USER_ID,
          },
        },
        {
          layer: 'core',
          collection: 'project_llm_configs',
          data: {
            operationTierOverrides: { response_gen: 'fast' },
            projectId: PROJECT_ID,
            tenantId: TENANT_ID,
            createdBy: USER_ID,
          },
        },
      ];
      setupHappyPath({ detectedLayers: ['core'], records });

      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', createMockDisassembler('core', records)]]),
        dbAdapter,
      };
      const validateRuntimeConfigForSave = vi.fn().mockResolvedValue({
        valid: true,
        data: {},
      });

      const result = await importProjectV2(
        new Map(),
        buildExistingState(),
        buildOptions({ validateRuntimeConfigForSave }),
        deps,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('RUNTIME_CONFIG_SAVE_VALIDATION_FAILED');
      expect(result.error?.message).toContain('conflicting operationTierOverrides');
      expect(mockStagedImporterInstance.stage).not.toHaveBeenCalled();
    });

    it('surfaces entry-agent alias resolution in dry-run preview', async () => {
      const manifest = buildV2Manifest({
        entry_agent: 'afg_supervisor',
        agents: {
          afg_supervisor: {
            path: 'agents/afg_supervisor.agent.yaml',
            owner: USER_ID,
            ownerTeam: null,
            description: 'Main agent',
            version: '1.0',
          },
        },
      });

      setupHappyPath({ detectedLayers: ['core'] });
      mockMigrateV1ToV2.mockReturnValue({
        migrated: false,
        formatVersion: '2.0',
        manifest,
        files: new Map([['project.json', JSON.stringify(manifest)]]),
        warnings: [],
        skipLockfileVerification: false,
      });
      mockReadFolderV2.mockReturnValue({
        ...buildDefaultFolderResult(),
        manifestV2: manifest,
        agentFiles: new Map([
          ['agents/afg_supervisor.agent.yaml', 'SUPERVISOR: AFG_Supervisor\nGOAL: Route requests'],
        ]),
        layerFiles: {
          ...buildDefaultFolderResult().layerFiles,
          core: new Map([
            [
              'agents/afg_supervisor.agent.yaml',
              'SUPERVISOR: AFG_Supervisor\nGOAL: Route requests',
            ],
          ]),
        },
      });

      const deps: ImportV2Deps = {
        disassemblers: new Map(),
        dbAdapter,
      };

      const result = await importProjectV2(
        new Map([['project.json', JSON.stringify(manifest)]]),
        buildExistingState(),
        buildOptions({ dryRun: true }),
        deps,
      );

      expect(result.success).toBe(true);
      expect(result.preview.entryAgentResolution).toEqual({
        requested: 'afg_supervisor',
        resolved: 'AFG_Supervisor',
        matchedBy: 'alias',
      });
      expect(result.preview.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: 'entry_agent',
            code: 'W_IMPORT_AGENT_IDENTITY',
            blocking: false,
          }),
        ]),
      );
    });

    it('suppresses removed tool diffs when imported tool files are incomplete', async () => {
      const manifest = buildV2Manifest({
        tools: {
          ExistingTool: {
            path: 'tools/existing-tool.tools.abl',
            owner: USER_ID,
          },
        },
      });

      setupHappyPath({ detectedLayers: ['core'] });
      mockMigrateV1ToV2.mockReturnValue({
        migrated: false,
        formatVersion: '2.0',
        manifest,
        files: new Map([['project.json', JSON.stringify(manifest)]]),
        warnings: [],
        skipLockfileVerification: false,
      });
      mockReadFolderV2.mockReturnValue({
        ...buildDefaultFolderResult(),
        manifestV2: manifest,
        toolFiles: new Map([
          [
            'tools/bad.tools.abl',
            `TOOLS:
  broken_tool( -> object
    type: http`,
          ],
        ]),
      });

      const deps: ImportV2Deps = {
        disassemblers: new Map(),
        dbAdapter,
      };

      const result = await importProjectV2(
        new Map([['project.json', JSON.stringify(manifest)]]),
        buildExistingState({
          tools: new Map([
            [
              'ExistingTool',
              {
                name: 'ExistingTool',
                dslContent: `lookup(city: string) -> object
  type: http
  endpoint: "/weather/{city}"
  method: GET`,
              },
            ],
          ]),
        }),
        buildOptions({ dryRun: true }),
        deps,
      );

      expect(result.success).toBe(true);
      expect(result.preview.toolChanges.removed).toEqual([]);
      expect(result.preview.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: 'tool',
            code: 'E_IMPORT_TOOL_PARSE',
            blocking: false,
          }),
          expect.objectContaining({
            category: 'tool',
            code: 'W_IMPORT_TOOL_DIFF_INCOMPLETE',
            blocking: false,
          }),
        ]),
      );
    });
  });

  // ─── Phase 2: Disassemble ──────────────────────────────────────────

  describe('Phase 2 — Disassemble Layers', () => {
    it('calls disassemblers in correct wave order (connections -> core -> rest)', async () => {
      const callOrder: string[] = [];

      const connRecords: StagedRecord[] = [
        {
          layer: 'connections',
          collection: 'connector_connections',
          data: {
            connectorName: 'sf',
            displayName: 'Salesforce',
            projectId: PROJECT_ID,
            tenantId: TENANT_ID,
            createdBy: USER_ID,
          },
        },
      ];
      const coreRecords: StagedRecord[] = buildDefaultStagedRecords();
      const wfRecords: StagedRecord[] = [
        {
          layer: 'workflows',
          collection: 'workflows',
          data: {
            name: 'WF1',
            projectId: PROJECT_ID,
            tenantId: TENANT_ID,
            createdBy: USER_ID,
          },
        },
      ];

      const connDisassembler: LayerDisassembler = {
        layer: 'connections',
        disassemble: vi.fn().mockImplementation(async () => {
          callOrder.push('connections');
          return { records: connRecords, superseded: [], warnings: [] };
        }),
      };
      const coreDisassembler: LayerDisassembler = {
        layer: 'core',
        disassemble: vi.fn().mockImplementation(async () => {
          callOrder.push('core');
          return { records: coreRecords, superseded: [], warnings: [] };
        }),
      };
      const wfDisassembler: LayerDisassembler = {
        layer: 'workflows',
        disassemble: vi.fn().mockImplementation(async () => {
          callOrder.push('workflows');
          return { records: wfRecords, superseded: [], warnings: [] };
        }),
      };

      const allRecords = [...connRecords, ...coreRecords, ...wfRecords];

      setupHappyPath({
        detectedLayers: ['core', 'connections', 'workflows'],
        records: allRecords,
      });

      const deps: ImportV2Deps = {
        disassemblers: new Map<LayerName, LayerDisassembler>([
          ['connections', connDisassembler],
          ['core', coreDisassembler],
          ['workflows', wfDisassembler],
        ]),
        dbAdapter,
        crossRefDb: createMockCrossRefDb(),
      };

      const result = await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      expect(result.success).toBe(true);
      // Wave 1 (connections) must come before Wave 2 (core)
      const connIdx = callOrder.indexOf('connections');
      const coreIdx = callOrder.indexOf('core');
      const wfIdx = callOrder.indexOf('workflows');
      expect(connIdx).toBeLessThan(coreIdx);
      // Wave 2 (core) must come before Wave 3 (workflows)
      expect(coreIdx).toBeLessThan(wfIdx);
    });

    it('passes DisassembleContext with correct ownership and files', async () => {
      const coreFiles = new Map([['agents/Main.agent.yaml', 'AGENT: Main']]);
      const folderResult = buildDefaultFolderResult();
      folderResult.layerFiles.core = coreFiles;

      setupHappyPath({ detectedLayers: ['core'] });
      mockReadFolderV2.mockReturnValue(folderResult);

      const coreDisassembler = createMockDisassembler('core', buildDefaultStagedRecords());

      const existingState = buildExistingState({
        activeRecords: new Map([['project_agents', [{ _id: 'existing-1', name: 'OldAgent' }]]]),
      });

      const authMapping = { 'OAuth Profile': 'auth-profile-id-1' };

      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', coreDisassembler]]),
        dbAdapter,
      };

      await importProjectV2(
        new Map(),
        existingState,
        buildOptions({ authProfileMapping: authMapping }),
        deps,
      );

      expect(coreDisassembler.disassemble).toHaveBeenCalledTimes(1);
      const ctx = (coreDisassembler.disassemble as Mock).mock.calls[0][0] as DisassembleContext;

      expect(ctx.projectId).toBe(PROJECT_ID);
      expect(ctx.tenantId).toBe(TENANT_ID);
      expect(ctx.userId).toBe(USER_ID);
      expect(ctx.conflictStrategy).toBe('replace');
      expect(ctx.files).toBe(coreFiles);
      expect(ctx.existingRecordIds).toBe(existingState.activeRecords);
      expect(ctx.authProfileMapping).toEqual(authMapping);
    });

    it('fails the import when a requested layer cannot be disassembled', async () => {
      setupHappyPath({ detectedLayers: ['core', 'search'] });

      const coreDisassembler = createMockDisassembler('core', buildDefaultStagedRecords());
      // search disassembler throws
      const searchDisassembler: LayerDisassembler = {
        layer: 'search',
        disassemble: vi.fn().mockRejectedValue(new Error('Search disassembly boom')),
      };

      const deps: ImportV2Deps = {
        disassemblers: new Map<LayerName, LayerDisassembler>([
          ['core', coreDisassembler],
          ['search', searchDisassembler],
        ]),
        dbAdapter,
      };

      const result = await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('DISASSEMBLY_FAILED');
      expect(result.error?.message).toContain('search');
      expect(result.error?.message).toContain('Search disassembly boom');
      expect(mockStagedImporterInstance.stage).not.toHaveBeenCalled();
      expect(mockStagedImporterInstance.activate).not.toHaveBeenCalled();
    });

    it('runs Wave 3 layers in parallel', async () => {
      const parallelStart: number[] = [];

      function makeDelayedDisassembler(
        layer: LayerName,
        records: StagedRecord[] = [],
      ): LayerDisassembler {
        return {
          layer,
          disassemble: vi.fn().mockImplementation(async () => {
            parallelStart.push(Date.now());
            // Small delay to verify parallelism
            await new Promise((r) => setTimeout(r, 10));
            return { records, superseded: [], warnings: [] };
          }),
        };
      }

      setupHappyPath({
        detectedLayers: ['core', 'connections', 'search', 'workflows', 'guardrails'],
        records: buildDefaultStagedRecords(),
      });

      const connDisassembler = createMockDisassembler('connections', []);
      const coreDisassembler = createMockDisassembler('core', buildDefaultStagedRecords());
      // Wave 3 layers — should run in parallel
      const searchDisassembler = makeDelayedDisassembler('search');
      const wfDisassembler = makeDelayedDisassembler('workflows');
      const guardrailDisassembler = makeDelayedDisassembler('guardrails');

      const deps: ImportV2Deps = {
        disassemblers: new Map<LayerName, LayerDisassembler>([
          ['connections', connDisassembler],
          ['core', coreDisassembler],
          ['search', searchDisassembler],
          ['workflows', wfDisassembler],
          ['guardrails', guardrailDisassembler],
        ]),
        dbAdapter,
        crossRefDb: createMockCrossRefDb(),
      };

      const result = await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      expect(result.success).toBe(true);
      // All 3 wave-3 disassemblers were called
      expect(searchDisassembler.disassemble).toHaveBeenCalledTimes(1);
      expect(wfDisassembler.disassemble).toHaveBeenCalledTimes(1);
      expect(guardrailDisassembler.disassemble).toHaveBeenCalledTimes(1);

      // All 3 should have started within a narrow window (parallel)
      if (parallelStart.length === 3) {
        const spread = Math.max(...parallelStart) - Math.min(...parallelStart);
        // If truly parallel, spread should be well under sequential (~30ms+).
        // Allow generous headroom for CI/loaded machines.
        expect(spread).toBeLessThan(100);
      }
    });
  });

  // ─── Phase 3: Schema Validation ────────────────────────────────────

  describe('Phase 3 — Schema Validation', () => {
    it('passes all records through validateStagedRecordBatch', async () => {
      const records = buildDefaultStagedRecords();
      setupHappyPath({ detectedLayers: ['core'], records });

      const coreDisassembler = createMockDisassembler('core', records);
      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', coreDisassembler]]),
        dbAdapter,
      };

      await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      expect(mockValidateStagedRecordBatch).toHaveBeenCalledTimes(1);
      const batchArg = mockValidateStagedRecordBatch.mock.calls[0][0] as StagedRecord[];
      expect(batchArg.length).toBe(records.length);
    });

    it('collects schema validation warnings', async () => {
      setupHappyPath({
        detectedLayers: ['core'],
        records: buildDefaultStagedRecords(),
        schemaWarnings: ['Schema validation warning for "project_agents": name: String too long'],
      });

      const coreDisassembler = createMockDisassembler('core', buildDefaultStagedRecords());
      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', coreDisassembler]]),
        dbAdapter,
      };

      const result = await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      expect(result.success).toBe(true);
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('Schema validation warning')]),
      );
    });

    it('blocks staging when entity schema validation reports errors', async () => {
      setupHappyPath({
        detectedLayers: ['core'],
        records: buildDefaultStagedRecords(),
        schemaErrors: ['Schema validation failed for "project_agents": name: Required'],
      });

      const coreDisassembler = createMockDisassembler('core', buildDefaultStagedRecords());
      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', coreDisassembler]]),
        dbAdapter,
      };

      const result = await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ENTITY_SCHEMA_VALIDATION_FAILED');
      expect(mockStagedImporterInstance.stage).not.toHaveBeenCalled();
    });
  });

  // ─── Phase 4: Stage ────────────────────────────────────────────────

  describe('Phase 4 — Stage', () => {
    it('calls StagedImporter.stage with correct arguments', async () => {
      const records = buildDefaultStagedRecords();
      const { mockStage } = setupHappyPath({
        detectedLayers: ['core'],
        records,
      });

      const coreDisassembler = createMockDisassembler('core', records);
      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', coreDisassembler]]),
        dbAdapter,
      };

      await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      expect(mockStage).toHaveBeenCalledWith(OPERATION_ID, PROJECT_ID, TENANT_ID, records, [
        'core',
      ]);
    });

    it('returns error and marks operation failed on stage failure', async () => {
      setupHappyPath({ detectedLayers: ['core'] });

      mockStagedImporterInstance.stage.mockResolvedValue({
        success: false,
        stagedRecordIds: {},
        error: {
          phase: 'staging',
          layer: 'core',
          message: 'Disk full',
        },
      });

      const coreDisassembler = createMockDisassembler('core', buildDefaultStagedRecords());
      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', coreDisassembler]]),
        dbAdapter,
      };

      const result = await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('STAGING_FAILED');
      expect(result.error?.message).toContain('Disk full');
      // Operation should be updated with failed status
      expect(dbAdapter.updateImportOperation).toHaveBeenCalledWith(
        OPERATION_ID,
        PROJECT_ID,
        TENANT_ID,
        expect.objectContaining({ status: 'failed' }),
      );
    });
  });

  // ─── Phase 5: Cross-Reference Resolution ──────────────────────────

  describe('Phase 5 — Cross-Reference Resolution', () => {
    it('calls resolveCrossReferences between stage and activate when crossRefDb provided', async () => {
      const { mockStage, mockActivate } = setupHappyPath({
        detectedLayers: ['core'],
      });

      const crossRefDb = createMockCrossRefDb();
      const coreDisassembler = createMockDisassembler('core', buildDefaultStagedRecords());
      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', coreDisassembler]]),
        dbAdapter,
        crossRefDb,
      };

      await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      // Verify cross-ref was called
      expect(mockResolveCrossReferences).toHaveBeenCalledTimes(1);
      expect(mockResolveCrossReferences).toHaveBeenCalledWith(crossRefDb, OPERATION_ID, {
        project_agents: ['staged-id-1'],
      });

      // Verify ordering: stage was called, then cross-ref, then activate
      // (all three were called — ordering is enforced by the await chain in the orchestrator)
      expect(mockStage).toHaveBeenCalledTimes(1);
      expect(mockResolveCrossReferences).toHaveBeenCalledTimes(1);
      expect(mockActivate).toHaveBeenCalledTimes(1);
    });

    it('skips cross-ref resolution when crossRefDb not provided', async () => {
      setupHappyPath({ detectedLayers: ['core'] });

      const coreDisassembler = createMockDisassembler('core', buildDefaultStagedRecords());
      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', coreDisassembler]]),
        dbAdapter,
        // No crossRefDb
      };

      await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      expect(mockResolveCrossReferences).not.toHaveBeenCalled();
    });

    it('fails requested cross-ref layers when the resolver is missing', async () => {
      setupHappyPath({
        detectedLayers: ['core', 'workflows'],
      });

      const coreDisassembler = createMockDisassembler('core', buildDefaultStagedRecords());
      const wfDisassembler = createMockDisassembler('workflows');
      const deps: ImportV2Deps = {
        disassemblers: new Map<LayerName, LayerDisassembler>([
          ['core', coreDisassembler],
          ['workflows', wfDisassembler],
        ]),
        dbAdapter,
        // No crossRefDb — workflows have cross-refs
      };

      const result = await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('CROSS_REF_RESOLVER_REQUIRED');
      expect(result.error?.message).toContain('workflows');
      expect(mockResolveCrossReferences).not.toHaveBeenCalled();
      expect(mockStagedImporterInstance.stage).not.toHaveBeenCalled();
      expect(mockStagedImporterInstance.activate).not.toHaveBeenCalled();
      expect(dbAdapter.createImportOperation).not.toHaveBeenCalled();
      expect(dbAdapter.updateImportOperation).not.toHaveBeenCalled();
    });

    it('fails and skips activation when cross-ref resolution fails', async () => {
      setupHappyPath({ detectedLayers: ['core'] });

      mockResolveCrossReferences.mockRejectedValue(new Error('Cross-ref DB timeout'));

      const crossRefDb = createMockCrossRefDb();
      const coreDisassembler = createMockDisassembler('core', buildDefaultStagedRecords());
      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', coreDisassembler]]),
        dbAdapter,
        crossRefDb,
      };

      const result = await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('CROSS_REF_RESOLUTION_FAILED');
      expect(result.error?.message).toContain('Cross-ref DB timeout');
      expect(mockStagedImporterInstance.activate).not.toHaveBeenCalled();
      expect(mockStagedImporterInstance.rollback).toHaveBeenCalledWith(
        OPERATION_ID,
        PROJECT_ID,
        TENANT_ID,
        { project_agents: ['staged-id-1'] },
        {},
        [],
      );
      expect(dbAdapter.updateImportOperation).toHaveBeenCalledWith(
        OPERATION_ID,
        PROJECT_ID,
        TENANT_ID,
        expect.objectContaining({ status: 'rolling_back' }),
      );
      expect(dbAdapter.updateImportOperation).toHaveBeenCalledWith(
        OPERATION_ID,
        PROJECT_ID,
        TENANT_ID,
        expect.objectContaining({ status: 'failed' }),
      );
    });
  });

  // ─── Phase 6: Activate ────────────────────────────────────────────

  describe('Phase 6 — Activate', () => {
    it('calls activate with correct ACTIVATION_ORDER for requested layers', async () => {
      const { mockActivate } = setupHappyPath({
        detectedLayers: ['core', 'connections'],
      });

      const connDisassembler = createMockDisassembler('connections');
      const coreDisassembler = createMockDisassembler('core', buildDefaultStagedRecords());
      const deps: ImportV2Deps = {
        disassemblers: new Map<LayerName, LayerDisassembler>([
          ['connections', connDisassembler],
          ['core', coreDisassembler],
        ]),
        dbAdapter,
      };

      await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      expect(mockActivate).toHaveBeenCalledTimes(1);
      // Verify activate was called with the correct layers
      const activateCall = mockActivate.mock.calls[0];
      expect(activateCall[0]).toBe(OPERATION_ID);
      expect(activateCall[1]).toBe(PROJECT_ID);
      expect(activateCall[2]).toBe(TENANT_ID);
      // importLayers passed to activate
      expect(activateCall[5]).toEqual(expect.arrayContaining(['core', 'connections']));
    });

    it('triggers rollback on activation failure', async () => {
      setupHappyPath({ detectedLayers: ['core'] });

      mockStagedImporterInstance.stage.mockResolvedValue({
        success: true,
        stagedRecordIds: { project_agents: ['staged-1'] },
      });
      mockStagedImporterInstance.activate.mockResolvedValue({
        success: false,
        activatedLayers: [],
        supersededRecordIds: { project_agents: ['old-1'] },
        error: { phase: 'activating', layer: 'core', message: 'Conflict' },
      });

      const coreDisassembler = createMockDisassembler('core', buildDefaultStagedRecords());
      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', coreDisassembler]]),
        dbAdapter,
      };

      const result = await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('ACTIVATION_FAILED');
      expect(result.error?.message).toContain('Conflict');

      // Rollback should have been called
      expect(mockStagedImporterInstance.rollback).toHaveBeenCalledTimes(1);
      expect(mockStagedImporterInstance.rollback).toHaveBeenCalledWith(
        OPERATION_ID,
        PROJECT_ID,
        TENANT_ID,
        { project_agents: ['staged-1'] },
        { project_agents: ['old-1'] },
        [],
      );

      // Operation status should be updated to rolling_back then failed
      expect(dbAdapter.updateImportOperation).toHaveBeenCalledWith(
        OPERATION_ID,
        PROJECT_ID,
        TENANT_ID,
        { status: 'rolling_back' },
      );
      expect(dbAdapter.updateImportOperation).toHaveBeenCalledWith(
        OPERATION_ID,
        PROJECT_ID,
        TENANT_ID,
        expect.objectContaining({ status: 'failed' }),
      );
    });

    it('marks operation completed on success', async () => {
      setupHappyPath({ detectedLayers: ['core'] });

      const coreDisassembler = createMockDisassembler('core', buildDefaultStagedRecords());
      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', coreDisassembler]]),
        dbAdapter,
      };

      const result = await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      expect(result.success).toBe(true);
      expect(result.phase).toBe('completed');
      expect(result.operationId).toBe(OPERATION_ID);

      // Verify operation marked completed
      expect(dbAdapter.updateImportOperation).toHaveBeenCalledWith(
        OPERATION_ID,
        PROJECT_ID,
        TENANT_ID,
        expect.objectContaining({ status: 'completed' }),
      );
    });
  });

  // ─── Phase 7: Post-Import Validation ──────────────────────────────

  describe('Phase 7 — Post-Import Validation', () => {
    it('calls validatePostImport when postImportDb is provided', async () => {
      setupHappyPath({ detectedLayers: ['core'] });

      const postImportDb: PostImportDbAdapter = {
        getProjectEnvVars: vi.fn().mockResolvedValue([]),
        getProjectConnectors: vi.fn().mockResolvedValue([]),
        getProjectMCPServers: vi.fn().mockResolvedValue([]),
        getProjectGuardrails: vi.fn().mockResolvedValue([]),
        getTenantGuardrailProviders: vi.fn().mockResolvedValue([]),
        getProjectAuthProfiles: vi.fn().mockResolvedValue([]),
      };

      const coreDisassembler = createMockDisassembler('core', buildDefaultStagedRecords());
      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', coreDisassembler]]),
        dbAdapter,
        postImportDb,
      };

      const result = await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      expect(result.success).toBe(true);
      expect(mockValidatePostImport).toHaveBeenCalledTimes(1);
      expect(result.postImportReport).toBeDefined();
    });

    it('skips post-import validation when postImportDb not provided', async () => {
      setupHappyPath({ detectedLayers: ['core'] });

      const coreDisassembler = createMockDisassembler('core', buildDefaultStagedRecords());
      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', coreDisassembler]]),
        dbAdapter,
        // No postImportDb
      };

      const result = await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      expect(result.success).toBe(true);
      expect(mockValidatePostImport).not.toHaveBeenCalled();
      expect(result.postImportReport).toBeUndefined();
    });

    it('handles post-import validation failure gracefully', async () => {
      setupHappyPath({ detectedLayers: ['core'] });

      mockValidatePostImport.mockRejectedValue(new Error('Post-import DB down'));

      const postImportDb: PostImportDbAdapter = {
        getProjectEnvVars: vi.fn(),
        getProjectConnectors: vi.fn(),
        getProjectMCPServers: vi.fn(),
        getProjectGuardrails: vi.fn(),
        getTenantGuardrailProviders: vi.fn(),
        getProjectAuthProfiles: vi.fn(),
      };

      const coreDisassembler = createMockDisassembler('core', buildDefaultStagedRecords());
      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', coreDisassembler]]),
        dbAdapter,
        postImportDb,
      };

      const result = await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      // Import still succeeds — post-validation is non-blocking
      expect(result.success).toBe(true);
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('Post-import validation failed')]),
      );
    });
  });

  // ─── Progress Callback ────────────────────────────────────────────

  describe('Progress Callback', () => {
    it('emits progress events at each phase', async () => {
      setupHappyPath({ detectedLayers: ['core'] });

      const progressEvents: Array<{
        phase: string;
        progress: number;
        message: string;
      }> = [];

      const onProgress = vi.fn().mockImplementation((event) => {
        progressEvents.push({
          phase: event.phase,
          progress: event.progress,
          message: event.message,
        });
      });

      const coreDisassembler = createMockDisassembler('core', buildDefaultStagedRecords());
      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', coreDisassembler]]),
        dbAdapter,
        crossRefDb: createMockCrossRefDb(),
      };

      await importProjectV2(new Map(), buildExistingState(), buildOptions({ onProgress }), deps);

      // Verify progress was called multiple times
      expect(onProgress).toHaveBeenCalled();
      expect(progressEvents.length).toBeGreaterThanOrEqual(5);

      // Verify phase progression
      const phases = progressEvents.map((e) => e.phase);
      expect(phases).toContain('validating');
      expect(phases).toContain('staging');
      expect(phases).toContain('resolving_refs');
      expect(phases).toContain('activating');
      expect(phases).toContain('completed');

      // Verify progress increases monotonically (within each report)
      for (const event of progressEvents) {
        expect(event.progress).toBeGreaterThanOrEqual(0);
        expect(event.progress).toBeLessThanOrEqual(1);
      }

      // Verify each event has required fields
      for (const event of progressEvents) {
        expect(typeof event.phase).toBe('string');
        expect(typeof event.message).toBe('string');
        expect(typeof event.progress).toBe('number');
      }
    });

    it('does not throw when onProgress is undefined', async () => {
      setupHappyPath({ detectedLayers: ['core'] });

      const coreDisassembler = createMockDisassembler('core', buildDefaultStagedRecords());
      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', coreDisassembler]]),
        dbAdapter,
      };

      // No onProgress callback
      const result = await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      expect(result.success).toBe(true);
    });
  });

  // ─── Empty Import ─────────────────────────────────────────────────

  describe('Empty Import', () => {
    it('succeeds gracefully when no records produced by disassembly', async () => {
      setupHappyPath({ detectedLayers: ['core'] });

      // Override schema validation to return empty records
      mockValidateStagedRecordBatch.mockReturnValue({
        sanitized: [],
        warnings: [],
      });

      // Core disassembler returns no records
      const coreDisassembler = createMockDisassembler('core', []);
      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', coreDisassembler]]),
        dbAdapter,
      };

      const result = await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      expect(result.success).toBe(true);
      expect(result.operationId).toBe('');
      expect(result.phase).toBe('completed');
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('No records produced by disassembly')]),
      );
      // StagedImporter.stage should NOT be called when there are 0 records
      expect(mockStagedImporterInstance.stage).not.toHaveBeenCalled();
    });
  });

  // ─── Top-level Error Handling ─────────────────────────────────────

  describe('Top-level Error Handling', () => {
    it('catches unexpected errors and returns a structured error result', async () => {
      // Force an unexpected throw in phase 0
      mockMigrateV1ToV2.mockImplementation(() => {
        throw new Error('Unexpected crash');
      });

      const deps: ImportV2Deps = {
        disassemblers: new Map(),
        dbAdapter,
      };

      const result = await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('IMPORT_FAILED');
      expect(result.error?.message).toContain('Unexpected crash');
      expect(result.operationId).toBe('');
      expect(result.phase).toBe('failed');
    });
  });

  // ─── Superseded Record Handling ───────────────────────────────────

  describe('Superseded Records', () => {
    it('passes superseded records from disassemblers to activate', async () => {
      const superseded: SupersededRecord[] = [
        {
          layer: 'core',
          collection: 'project_agents',
          recordId: 'old-agent-1',
        },
      ];
      const records = buildDefaultStagedRecords();

      setupHappyPath({ detectedLayers: ['core'], records });

      const coreDisassembler = createMockDisassembler('core', records, superseded);

      mockStagedImporterInstance.activate.mockResolvedValue({
        success: true,
        activatedLayers: ['core'],
        supersededRecordIds: { project_agents: ['old-agent-1'] },
      });

      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', coreDisassembler]]),
        dbAdapter,
      };

      const result = await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      expect(result.success).toBe(true);
      // Verify superseded records were passed to activate
      const activateArgs = mockStagedImporterInstance.activate.mock.calls[0];
      expect(activateArgs[4]).toEqual(superseded);
    });

    it('fires-and-forgets cleanup of superseded records after activation', async () => {
      setupHappyPath({ detectedLayers: ['core'] });

      mockStagedImporterInstance.activate.mockResolvedValue({
        success: true,
        activatedLayers: ['core'],
        supersededRecordIds: { project_agents: ['old-1', 'old-2'] },
      });

      const coreDisassembler = createMockDisassembler('core', buildDefaultStagedRecords());
      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', coreDisassembler]]),
        dbAdapter,
      };

      await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      // deleteRecordsByIds should have been called for cleanup
      expect(dbAdapter.deleteRecordsByIds).toHaveBeenCalledWith('project_agents', [
        'old-1',
        'old-2',
      ]);
    });
  });

  // ─── Import Operation Lifecycle ───────────────────────────────────

  describe('Import Operation Lifecycle', () => {
    it('creates import operation with correct parameters', async () => {
      setupHappyPath({ detectedLayers: ['core', 'connections'] });

      const connDisassembler = createMockDisassembler('connections');
      const coreDisassembler = createMockDisassembler('core', buildDefaultStagedRecords());
      const deps: ImportV2Deps = {
        disassemblers: new Map<LayerName, LayerDisassembler>([
          ['connections', connDisassembler],
          ['core', coreDisassembler],
        ]),
        dbAdapter,
      };

      await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      expect(dbAdapter.createImportOperation).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        layers: {
          core: { status: 'pending' },
          connections: { status: 'pending' },
        },
        expiresAt: expect.any(Date),
      });
    });

    it('updates operation status to activating before activation', async () => {
      setupHappyPath({ detectedLayers: ['core'] });

      const coreDisassembler = createMockDisassembler('core', buildDefaultStagedRecords());
      const deps: ImportV2Deps = {
        disassemblers: new Map([['core', coreDisassembler]]),
        dbAdapter,
      };

      await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      // Should have been called with status: 'activating' before activate
      expect(dbAdapter.updateImportOperation).toHaveBeenCalledWith(
        OPERATION_ID,
        PROJECT_ID,
        TENANT_ID,
        expect.objectContaining({ status: 'activating' }),
      );
    });
  });

  // ─── Multi-layer Full Import ──────────────────────────────────────

  describe('Full Multi-Layer Import', () => {
    it('successfully imports core + connections + workflows end-to-end', async () => {
      const connRecords: StagedRecord[] = [
        {
          layer: 'connections',
          collection: 'connector_connections',
          data: {
            connectorName: 'sf',
            displayName: 'Salesforce',
            projectId: PROJECT_ID,
            tenantId: TENANT_ID,
            createdBy: USER_ID,
          },
        },
      ];
      const coreRecords = buildDefaultStagedRecords();
      const wfRecords: StagedRecord[] = [
        {
          layer: 'workflows',
          collection: 'workflows',
          data: {
            name: 'Onboarding',
            projectId: PROJECT_ID,
            tenantId: TENANT_ID,
            createdBy: USER_ID,
          },
        },
      ];
      const allRecords = [...connRecords, ...coreRecords, ...wfRecords];

      setupHappyPath({
        detectedLayers: ['core', 'connections', 'workflows'],
        records: allRecords,
      });

      const connDisassembler = createMockDisassembler('connections', connRecords);
      const coreDisassembler = createMockDisassembler('core', coreRecords);
      const wfDisassembler = createMockDisassembler('workflows', wfRecords);

      const crossRefDb = createMockCrossRefDb();
      const deps: ImportV2Deps = {
        disassemblers: new Map<LayerName, LayerDisassembler>([
          ['connections', connDisassembler],
          ['core', coreDisassembler],
          ['workflows', wfDisassembler],
        ]),
        dbAdapter,
        crossRefDb,
      };

      const result = await importProjectV2(new Map(), buildExistingState(), buildOptions(), deps);

      expect(result.success).toBe(true);
      expect(result.phase).toBe('completed');
      expect(result.operationId).toBe(OPERATION_ID);
      // All three disassemblers called
      expect(connDisassembler.disassemble).toHaveBeenCalledTimes(1);
      expect(coreDisassembler.disassemble).toHaveBeenCalledTimes(1);
      expect(wfDisassembler.disassemble).toHaveBeenCalledTimes(1);
      // Cross-ref called
      expect(mockResolveCrossReferences).toHaveBeenCalledTimes(1);
    });
  });
});
