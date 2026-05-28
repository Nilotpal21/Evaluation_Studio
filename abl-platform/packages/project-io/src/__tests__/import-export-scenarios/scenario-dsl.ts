import { expect } from 'vitest';
import {
  exportProjectV2,
  resolveLayersForToolDependencies,
} from '../../export/project-exporter.js';
import { readFolderV2 } from '../../import/folder-reader.js';
import {
  importProjectV2,
  type CrossRefDbAdapter,
  type ExistingProjectStateV2,
  type ImportV2Deps,
} from '../../import/project-importer-v2.js';
import { validateCrossLayerDeps, validateImport } from '../../import/import-validator.js';
import { validateEntitySchema } from '../../import/entity-schemas.js';
import type { ImportDbAdapter, StagedRecord } from '../../import/staged-importer.js';
import type { PostImportDbAdapter } from '../../import/post-import-validator.js';
import type { ManifestInputV2 } from '../../export/manifest-generator.js';
import type { LayerDisassembler } from '../../import/layer-disassemblers/types.js';
import type {
  ExportOptionsV2,
  ImportOptionsV2,
  ExportResultV2,
  LayerAssemblyResult,
  LayerName,
  ProjectManifestV2,
} from '../../types.js';
import type { LayerAssembler, LayerQueryContext } from '../../export/layer-assemblers/types.js';

export const ALL_PORTABLE_PROJECT_LAYERS = [
  'core',
  'connections',
  'prompts',
  'guardrails',
  'workflows',
  'evals',
  'search',
  'channels',
  'vocabulary',
] as const satisfies readonly LayerName[];

export type ExportPlanningScenarioKind =
  | 'default_full_project'
  | 'explicit_layer_selection'
  | 'portable_tool_dependency_expansion'
  | 'canonical_requested_layer_order'
  | 'tool_dependency_order_invariant';

export const EXPORT_PLANNING_SCENARIO_COVERAGE = {
  default_full_project: 'EXP-P1',
  explicit_layer_selection: 'EXP-P2',
  portable_tool_dependency_expansion: 'EXP-P3',
  canonical_requested_layer_order: 'EXP-P4',
  tool_dependency_order_invariant: 'EXP-P5',
} satisfies Record<ExportPlanningScenarioKind, string>;

export type ExportOrchestratorScenarioKind =
  | 'deployment_context_forwarding'
  | 'requested_layer_missing_assembler';

export const EXPORT_ORCHESTRATOR_SCENARIO_COVERAGE = {
  deployment_context_forwarding: 'EXP-O1',
  requested_layer_missing_assembler: 'EXP-O2',
} satisfies Record<ExportOrchestratorScenarioKind, string>;

export type ImportCompletenessScenarioKind = 'manifest_declares_layer_without_files';

export const IMPORT_COMPLETENESS_SCENARIO_COVERAGE = {
  manifest_declares_layer_without_files: 'IMP-C1',
} satisfies Record<ImportCompletenessScenarioKind, string>;

export type ImportOrchestratorScenarioKind =
  | 'requested_layer_missing_files'
  | 'detected_layer_missing_disassembler'
  | 'activation_failure_preserves_details'
  | 'binding_resolution_round_trip'
  | 'full_archive_cross_layer_import'
  | 'workflow_version_trigger_ambiguity'
  | 'layer_deselection_with_dependencies'
  | 'partial_layer_agent_scoped_reference'
  | 'empty_model_config_unfulfilled_state'
  | 'channel_unique_collision_upsert'
  | 'guardrail_scoped_name_collision'
  | 'search_graph_complete_remapping'
  | 'invalid_binding_resolution_rejected'
  | 'rollback_after_partial_activation'
  | 'archive_portability_hygiene'
  | 'post_import_action_required_warnings'
  | 'archive_prefix_normalization'
  | 'idempotent_reimport_preview';

export const IMPORT_ORCHESTRATOR_SCENARIO_COVERAGE = {
  requested_layer_missing_files: 'IMP-O1',
  detected_layer_missing_disassembler: 'IMP-O2',
  activation_failure_preserves_details: 'IMP-O3',
  binding_resolution_round_trip: 'IMP-O4',
  full_archive_cross_layer_import: 'IMP-O5',
  workflow_version_trigger_ambiguity: 'IMP-O6',
  layer_deselection_with_dependencies: 'IMP-O7',
  partial_layer_agent_scoped_reference: 'IMP-O8',
  empty_model_config_unfulfilled_state: 'IMP-O9',
  channel_unique_collision_upsert: 'IMP-O10',
  guardrail_scoped_name_collision: 'IMP-O11',
  search_graph_complete_remapping: 'IMP-O12',
  invalid_binding_resolution_rejected: 'IMP-O13',
  rollback_after_partial_activation: 'IMP-O14',
  archive_portability_hygiene: 'IMP-O15',
  post_import_action_required_warnings: 'IMP-O16',
  archive_prefix_normalization: 'IMP-O17',
  idempotent_reimport_preview: 'IMP-O18',
} satisfies Record<ImportOrchestratorScenarioKind, string>;

export type ImportManifestValidationScenarioKind =
  | 'unknown_manifest_layer'
  | 'manifest_logical_entity_count_differs_from_file_count'
  | 'archive_file_for_undeclared_layer'
  | 'duplicate_entity_names';

export const IMPORT_MANIFEST_VALIDATION_SCENARIO_COVERAGE = {
  unknown_manifest_layer: 'IMP-M1',
  manifest_logical_entity_count_differs_from_file_count: 'IMP-M2',
  archive_file_for_undeclared_layer: 'IMP-M3',
  duplicate_entity_names: 'IMP-M4',
} satisfies Record<ImportManifestValidationScenarioKind, string>;

export type ImportLockfileValidationScenarioKind =
  | 'manifest_layer_missing_lockfile_hash'
  | 'lockfile_layer_hash_for_undeclared_layer'
  | 'lockfile_section_empty_for_manifest_count';

export const IMPORT_LOCKFILE_VALIDATION_SCENARIO_COVERAGE = {
  manifest_layer_missing_lockfile_hash: 'IMP-L1',
  lockfile_layer_hash_for_undeclared_layer: 'IMP-L2',
  lockfile_section_empty_for_manifest_count: 'IMP-L3',
} satisfies Record<ImportLockfileValidationScenarioKind, string>;

export type ImportDependencyScenarioKind = 'tool_connector_reference_without_connections_layer';

export const IMPORT_DEPENDENCY_SCENARIO_COVERAGE = {
  tool_connector_reference_without_connections_layer: 'IMP-D1',
} satisfies Record<ImportDependencyScenarioKind, string>;

export type ImportSanitizationScenarioKind = 'source_scope_and_creator_fields_scrubbed';

export const IMPORT_SANITIZATION_SCENARIO_COVERAGE = {
  source_scope_and_creator_fields_scrubbed: 'IMP-S1',
} satisfies Record<ImportSanitizationScenarioKind, string>;

export type ImportSyntaxScenarioKind = 'mixed_yaml_legacy_requires_canonical_parser';

export const IMPORT_SYNTAX_SCENARIO_COVERAGE = {
  mixed_yaml_legacy_requires_canonical_parser: 'IMP-Y1',
} satisfies Record<ImportSyntaxScenarioKind, string>;

export type ImportExportE2EBoundaryScenarioKind =
  | 'studio_preview_surfaces_actionable_layer_failure'
  | 'studio_apply_persists_operation_phase_status'
  | 'runtime_export_route_expands_portable_dependencies'
  | 'cross_tenant_archive_import_rewrites_source_scope'
  | 'full_archive_roundtrip_preserves_layer_manifest_lockfile_parity'
  | 'ui_import_dialog_renders_error_details_and_operation_status';

export interface ImportExportE2EBoundaryScenario {
  id: string;
  kind: ImportExportE2EBoundaryScenarioKind;
  boundary: 'studio-api' | 'runtime-api' | 'ui-workflow';
  deterministicCoveredBy: string[];
  maxDurationMs: number;
}

export const IMPORT_EXPORT_E2E_BOUNDARY_SCENARIOS = [
  {
    id: 'E2E-IE-1',
    kind: 'studio_preview_surfaces_actionable_layer_failure',
    boundary: 'studio-api',
    deterministicCoveredBy: ['IMP-C1', 'IMP-M1', 'IMP-M2', 'IMP-M3', 'IMP-D1'],
    maxDurationMs: 1500,
  },
  {
    id: 'E2E-IE-2',
    kind: 'studio_apply_persists_operation_phase_status',
    boundary: 'studio-api',
    deterministicCoveredBy: ['IMP-O1', 'IMP-O2'],
    maxDurationMs: 2000,
  },
  {
    id: 'E2E-IE-3',
    kind: 'runtime_export_route_expands_portable_dependencies',
    boundary: 'runtime-api',
    deterministicCoveredBy: ['EXP-P1', 'EXP-P3', 'EXP-O1', 'EXP-O2'],
    maxDurationMs: 2000,
  },
  {
    id: 'E2E-IE-4',
    kind: 'cross_tenant_archive_import_rewrites_source_scope',
    boundary: 'ui-workflow',
    deterministicCoveredBy: ['IMP-D1', 'IMP-O4', 'IMP-O12', 'IMP-O15'],
    maxDurationMs: 5000,
  },
  {
    id: 'E2E-IE-5',
    kind: 'full_archive_roundtrip_preserves_layer_manifest_lockfile_parity',
    boundary: 'runtime-api',
    deterministicCoveredBy: ['EXP-P1', 'IMP-O5', 'IMP-C1', 'IMP-M2', 'IMP-L1', 'IMP-L2'],
    maxDurationMs: 2500,
  },
  {
    id: 'E2E-IE-6',
    kind: 'ui_import_dialog_renders_error_details_and_operation_status',
    boundary: 'ui-workflow',
    deterministicCoveredBy: ['IMP-O3', 'IMP-O4', 'IMP-O13', 'IMP-O16'],
    maxDurationMs: 5000,
  },
] as const satisfies readonly ImportExportE2EBoundaryScenario[];

export interface LayerPlanningScenarioInput {
  requestedLayers?: LayerName[];
  tools?: Array<{ dslContent: string; toolType?: string | null }>;
}

export function runLayerPlanningScenario(input: LayerPlanningScenarioInput): LayerName[] {
  return resolveLayersForToolDependencies(input.requestedLayers, input.tools ?? []);
}

export function expectDeterministicLayerPlanning(input: LayerPlanningScenarioInput): void {
  const first = runLayerPlanningScenario(input);
  const second = runLayerPlanningScenario(input);
  expect(second).toEqual(first);
}

export interface CapturingAssembler extends LayerAssembler {
  readonly contexts: LayerQueryContext[];
}

export function capturingAssembler(
  layer: LayerName,
  files: Map<string, string> = new Map([[`${layer}/fixture.json`, '{}']]),
): CapturingAssembler {
  const contexts: LayerQueryContext[] = [];
  return {
    layer,
    contexts,
    async assemble(ctx): Promise<LayerAssemblyResult> {
      contexts.push({ ...ctx });
      return {
        layer,
        files,
        entityCount: files.size,
        warnings: [],
      };
    },
    async countEntities(): Promise<number> {
      return files.size;
    },
  };
}

export function makeExportOptions(overrides: Partial<ExportOptionsV2> = {}): ExportOptionsV2 {
  return {
    projectId: 'project-import-export-scenarios',
    tenantId: 'tenant-import-export-scenarios',
    userId: 'user-import-export-scenarios',
    format: 'folder',
    layers: ['core'],
    ...overrides,
  };
}

export function makeManifestMeta(
  overrides: Partial<Omit<ManifestInputV2, 'layers' | 'edges' | 'dslFormat'>> = {},
): Omit<ManifestInputV2, 'layers' | 'edges' | 'dslFormat'> {
  return {
    projectName: 'Portable Import Export Scenario Project',
    projectSlug: 'portable-import-export-scenario-project',
    projectDescription: 'Deterministic import/export target-state scenario fixture',
    exportedBy: 'user-import-export-scenarios',
    entryAgent: 'Main',
    agents: [
      {
        name: 'Main',
        description: 'Main supervisor',
        ownerId: null,
        ownerTeamId: null,
        version: '1.0.0',
      },
    ],
    tools: [],
    profiles: [],
    entityCounts: {},
    requiredEnvVars: [],
    requiredConnectors: [],
    requiredMcpServers: [],
    ...overrides,
  };
}

export async function runExportScenario(input: {
  options: ExportOptionsV2;
  assemblers: LayerAssembler[];
}): Promise<ExportResultV2> {
  return exportProjectV2(
    input.options,
    {
      assemblers: new Map(input.assemblers.map((assembler) => [assembler.layer, assembler])),
      agentData: [
        {
          name: 'Main',
          version: '1.0.0',
          dslContent: 'SUPERVISOR: Main\nGOAL: Route requests\n',
          status: 'active',
        },
      ],
      toolData: [],
      edges: [],
    },
    makeManifestMeta(),
  );
}

export function makeManifestWithLayers(layers: LayerName[]): ProjectManifestV2 {
  return {
    format_version: '2.0',
    name: 'Incomplete Import Scenario',
    slug: 'incomplete-import-scenario',
    description: null,
    abl_version: '1.0',
    exported_at: '2026-05-11T00:00:00.000Z',
    exported_by: 'user-import-export-scenarios',
    entry_agent: 'Main',
    dsl_format: 'legacy',
    layers_included: layers,
    agents: {
      Main: {
        path: 'agents/main.agent.abl',
        owner: null,
        ownerTeam: null,
        description: null,
        version: '1.0.0',
      },
    },
    tools: {},
    metadata: {
      entity_counts: Object.fromEntries(layers.map((layer) => [layer, 1])),
      required_env_vars: [],
      required_connectors: [],
      required_mcp_servers: [],
    },
  };
}

export function makeFilesForLayers(
  layers: LayerName[],
  manifestLayers: LayerName[] = layers,
): Map<string, string> {
  const files = new Map<string, string>([
    ['project.json', JSON.stringify(makeManifestWithLayers(manifestLayers), null, 2)],
  ]);

  for (const layer of layers) {
    const [path, content] = makeLayerFixture(layer);
    files.set(path, content);
  }

  return files;
}

export function makeLayerFixture(layer: LayerName): [string, string] {
  switch (layer) {
    case 'core':
      return ['agents/main.agent.abl', 'SUPERVISOR: Main\nGOAL: Route requests\n'];
    case 'connections':
      return [
        'connections/salesforce.connection.json',
        JSON.stringify({ name: 'salesforce', connectorName: 'salesforce' }),
      ];
    case 'prompts':
      return [
        'prompts/default.prompt.json',
        JSON.stringify({ name: 'Default Prompt', versions: [] }),
      ];
    case 'guardrails':
      return [
        'guardrails/default.guardrail.json',
        JSON.stringify({ name: 'Default Guardrail', scope: { type: 'project' } }),
      ];
    case 'workflows':
      return ['workflows/process_loan.workflow.json', JSON.stringify({ name: 'process_loan' })];
    case 'evals':
      return ['evals/default.eval.json', JSON.stringify({ name: 'default_eval' })];
    case 'search':
      return ['search/loans.index.json', JSON.stringify({ name: 'loans' })];
    case 'channels':
      return ['channels/web.channel.json', JSON.stringify({ name: 'web' })];
    case 'vocabulary':
      return ['vocabulary/default.vocabulary.json', JSON.stringify({ name: 'default' })];
    default:
      assertNeverLayer(layer);
  }
}

function assertNeverLayer(layer: never): never {
  throw new Error(`Unhandled layer fixture: ${layer}`);
}

export function runImportCompletenessScenario(layers: LayerName[]) {
  return readFolderV2(
    new Map([
      ['project.json', JSON.stringify(makeManifestWithLayers(layers), null, 2)],
      ['agents/main.agent.abl', 'SUPERVISOR: Main\nGOAL: Route requests\n'],
    ]),
  );
}

export function runUnknownManifestLayerScenario() {
  return readFolderV2(
    new Map([
      [
        'project.json',
        JSON.stringify(
          {
            ...makeManifestWithLayers(['core']),
            layers_included: ['core', 'quantum'],
          },
          null,
          2,
        ),
      ],
      ['agents/main.agent.abl', 'SUPERVISOR: Main\nGOAL: Route requests\n'],
    ]),
  );
}

export function runManifestLogicalEntityCountDiffersFromFileCountScenario() {
  return readFolderV2(
    new Map([
      [
        'project.json',
        JSON.stringify(
          {
            ...makeManifestWithLayers(['core']),
            metadata: {
              ...makeManifestWithLayers(['core']).metadata,
              entity_counts: { core: 3 },
            },
          },
          null,
          2,
        ),
      ],
      ['agents/main.agent.abl', 'SUPERVISOR: Main\nGOAL: Route requests\n'],
    ]),
  );
}

export function runArchiveFileForUndeclaredLayerScenario() {
  const files = makeFilesForLayers(['core'], ['core']);
  const [searchPath, searchContent] = makeLayerFixture('search');
  files.set(searchPath, searchContent);
  return readFolderV2(files);
}

export function runManifestLayerMissingLockfileHashScenario() {
  const files = makeFilesForLayers(['core', 'search'], ['core', 'search']);
  files.set('abl.lock', JSON.stringify(makeLockfileWithLayerHashes(['core']), null, 2));
  return readFolderV2(files);
}

export function runLockfileLayerHashForUndeclaredLayerScenario() {
  const files = makeFilesForLayers(['core'], ['core']);
  files.set('abl.lock', JSON.stringify(makeLockfileWithLayerHashes(['core', 'search']), null, 2));
  return readFolderV2(files);
}

export function runLockfileSectionEmptyForManifestCountScenario() {
  const files = makeFilesForLayers(['core', 'search'], ['core', 'search']);
  files.set(
    'project.json',
    JSON.stringify(
      {
        ...makeManifestWithLayers(['core', 'search']),
        metadata: {
          ...makeManifestWithLayers(['core', 'search']).metadata,
          entity_counts: { core: 1, search: 1 },
        },
      },
      null,
      2,
    ),
  );
  files.set('abl.lock', JSON.stringify(makeLockfileWithLayerHashes(['core', 'search']), null, 2));
  return readFolderV2(files);
}

function makeLockfileWithLayerHashes(layers: LayerName[]) {
  return {
    lockfile_version: '2.0',
    generated_at: '2026-05-11T00:00:00.000Z',
    agents: {},
    tools: {},
    configs: {},
    connections: {},
    guardrails: {},
    workflows: {},
    evals: {},
    search: {},
    channels: {},
    vocabulary: {},
    layer_hashes: Object.fromEntries(layers.map((layer) => [layer, `sha-${layer}`])),
    integrity: 'scenario-integrity',
  };
}

export function runToolConnectorReferenceWithoutConnectionsScenario() {
  const manifest = makeManifestWithLayers(['core']);
  manifest.metadata.entity_counts.core = 2;
  const folder = readFolderV2(
    new Map([
      ['project.json', JSON.stringify(manifest, null, 2)],
      ['agents/main.agent.abl', 'SUPERVISOR: Main\nGOAL: Route requests\n'],
      [
        'tools/account_api.tools.abl',
        'TOOL: account_api\nCONNECTOR: mercury_core\nINPUT: {}\nOUTPUT: {}\n',
      ],
    ]),
  );

  return {
    folder,
    dependencyValidation: validateCrossLayerDeps(folder),
  };
}

export function runDuplicateEntityNamesScenario() {
  return readFolderV2(
    new Map([
      ['project.json', JSON.stringify(makeManifestWithLayers(['guardrails']), null, 2)],
      [
        'guardrails/one.guardrail.json',
        JSON.stringify({ name: 'Duplicate Guardrail', scope: { type: 'project' } }),
      ],
      [
        'guardrails/two.guardrail.json',
        JSON.stringify({ name: 'Duplicate Guardrail', scope: { type: 'project' } }),
      ],
    ]),
  );
}

export function runSourceScopeScrubbingScenario() {
  return validateEntitySchema('connections/salesforce.connection.json', 'connections', {
    _id: 'source-id',
    tenantId: 'source-tenant',
    projectId: 'source-project',
    createdBy: 'source-user',
    ownerId: 'source-owner',
    connectorName: 'salesforce',
    displayName: 'Salesforce',
  });
}

export function runMixedYamlLegacySyntaxScenario() {
  return validateImport(
    new Map([
      ['agents/legacy.agent.abl', 'SUPERVISOR: Legacy\nGOAL: Help\n'],
      ['agents/yaml.agent.yaml', 'agent:\n  name: ObjectForm\nversion: "1.0.0"\n'],
    ]),
    new Map(),
  );
}

export async function runLayeredImportScenario(input: {
  files: Map<string, string>;
  options?: Partial<ImportOptionsV2>;
  disassemblers?: LayerDisassembler[];
  existingState?: ExistingProjectStateV2;
  dbAdapter?: ImportDbAdapter;
  crossRefDb?: CrossRefDbAdapter;
  postImportDb?: PostImportDbAdapter;
}) {
  return importProjectV2(
    input.files,
    input.existingState ?? makeExistingProjectState(),
    makeImportOptions(input.options),
    makeImportDeps(
      input.disassemblers ?? [],
      input.dbAdapter,
      input.postImportDb,
      input.crossRefDb,
    ),
  );
}

export function makeImportOptions(overrides: Partial<ImportOptionsV2> = {}): ImportOptionsV2 {
  return {
    projectId: 'project-import-export-scenarios',
    tenantId: 'tenant-import-export-scenarios',
    userId: 'user-import-export-scenarios',
    conflictStrategy: 'merge',
    dryRun: false,
    ...overrides,
  };
}

export function makeExistingProjectState(): ExistingProjectStateV2 {
  return {
    agents: new Map(),
    toolFiles: new Map(),
    activeRecords: new Map(),
  };
}

function makeImportDeps(
  disassemblers: LayerDisassembler[],
  dbAdapter: ImportDbAdapter = makeUnusedDbAdapter(),
  postImportDb?: PostImportDbAdapter,
  crossRefDb?: CrossRefDbAdapter,
): ImportV2Deps {
  return {
    disassemblers: new Map(disassemblers.map((disassembler) => [disassembler.layer, disassembler])),
    dbAdapter,
    ...(crossRefDb ? { crossRefDb } : {}),
    ...(postImportDb ? { postImportDb } : {}),
  };
}

function makeUnusedDbAdapter(): ImportDbAdapter {
  const fail = async (): Promise<never> => {
    throw new Error('Scenario expected to finish before database staging');
  };

  return {
    createImportOperation: fail,
    updateImportOperation: fail,
    insertStagedRecords: fail,
    deleteRecordsByIds: fail,
    activateLayer: fail,
    rollbackLayer: fail,
    findActiveRecordIds: fail,
  };
}

export function disassemblerForRecords(
  layer: LayerName,
  records: StagedRecord[],
  superseded: Array<{ layer: LayerName; collection: string; recordId: string }> = [],
): LayerDisassembler {
  return {
    layer,
    async disassemble() {
      return { records, superseded, warnings: [] };
    },
  };
}

export function makeToolRecord(input: {
  name: string;
  toolType: 'searchai' | 'workflow';
  dslContent: string;
}): StagedRecord {
  return {
    layer: 'core',
    collection: 'project_tools',
    data: {
      name: input.name,
      toolType: input.toolType,
      dslContent: input.dslContent,
      sourceHash: 'source-hash',
      projectId: 'project-import-export-scenarios',
      tenantId: 'tenant-import-export-scenarios',
      createdBy: 'user-import-export-scenarios',
    },
  };
}

export function memoryDbAdapter(
  input: {
    failOnStageCollection?: string;
    failOnActivateLayer?: LayerName;
  } = {},
): ImportDbAdapter & {
  inserted: Array<{ collection: string; records: Array<Record<string, unknown>> }>;
  updates: Array<Record<string, unknown>>;
  activated: Array<{ collection: string; stagedIds: string[]; supersededIds: string[] }>;
} {
  const inserted: Array<{ collection: string; records: Array<Record<string, unknown>> }> = [];
  const updates: Array<Record<string, unknown>> = [];
  const activated: Array<{ collection: string; stagedIds: string[]; supersededIds: string[] }> = [];
  let idCounter = 0;
  return {
    inserted,
    updates,
    activated,
    async createImportOperation() {
      return { _id: 'operation-import-export-scenarios' };
    },
    async updateImportOperation(_operationId, _projectId, _tenantId, update) {
      updates.push(update);
    },
    async insertStagedRecords(collection, records) {
      if (input.failOnStageCollection === collection) {
        throw new Error(`forced staging failure for ${collection}`);
      }
      const ids = records.map(() => `staged-${++idCounter}`);
      const recordsWithIds = records.map((record, index) => ({ ...record, _id: ids[index] }));
      inserted.push({ collection, records: recordsWithIds });
      return ids;
    },
    async deleteRecordsByIds() {},
    async activateLayer(collection, stagedIds, supersededIds) {
      const importLayer = inserted
        .filter((entry) => entry.collection === collection)
        .flatMap((entry) => entry.records)
        .map((record) => record.__ablImport)
        .find(
          (metadata): metadata is { layer: LayerName } =>
            typeof metadata === 'object' && metadata !== null && 'layer' in metadata,
        )?.layer;
      if (input.failOnActivateLayer && importLayer === input.failOnActivateLayer) {
        throw new Error(`forced activation failure for ${input.failOnActivateLayer}`);
      }
      activated.push({ collection, stagedIds, supersededIds });
    },
    async rollbackLayer() {},
    async findActiveRecordIds() {
      return [];
    },
  };
}

export function memoryCrossRefDb(
  dbAdapter: ReturnType<typeof memoryDbAdapter>,
): CrossRefDbAdapter & {
  updates: Array<{ collection: string; operations: Array<{ filter: unknown; update: unknown }> }>;
} {
  const updates: Array<{
    collection: string;
    operations: Array<{ filter: unknown; update: unknown }>;
  }> = [];

  const idsFromFilter = (filter: Record<string, unknown>): Set<string> | null => {
    const idFilter = filter._id;
    if (
      idFilter &&
      typeof idFilter === 'object' &&
      '$in' in idFilter &&
      Array.isArray((idFilter as { $in?: unknown }).$in)
    ) {
      return new Set((idFilter as { $in: unknown[] }).$in.map(String));
    }
    if (filter.$and && Array.isArray(filter.$and)) {
      for (const entry of filter.$and) {
        if (entry && typeof entry === 'object') {
          const ids = idsFromFilter(entry as Record<string, unknown>);
          if (ids) return ids;
        }
      }
    }
    return null;
  };

  const project = (record: Record<string, unknown>, projection: Record<string, number>) => {
    const projected: Record<string, unknown> = {};
    for (const [field, enabled] of Object.entries(projection)) {
      if (enabled && record[field] !== undefined) {
        projected[field] = record[field];
      }
    }
    return projected;
  };

  return {
    updates,
    async queryStagedRecords(collection, filter, projection) {
      const ids = idsFromFilter(filter);
      const records =
        dbAdapter.inserted.find((entry) => entry.collection === collection)?.records ?? [];
      return records
        .filter((record) => {
          if (!ids) return true;
          return ids.has(String(record._id));
        })
        .map((record) => project(record, projection));
    },
    async batchUpdateStagedRecords(collection, operations) {
      updates.push({ collection, operations });
      const records =
        dbAdapter.inserted.find((entry) => entry.collection === collection)?.records ?? [];
      for (const operation of operations) {
        const id = String(operation.filter._id ?? '');
        const record = records.find((candidate) => String(candidate._id) === id);
        if (!record) continue;
        const set = operation.update.$set as Record<string, unknown> | undefined;
        const unset = operation.update.$unset as Record<string, unknown> | undefined;
        if (set) {
          for (const [key, value] of Object.entries(set)) {
            record[key] = value;
          }
        }
        if (unset) {
          for (const key of Object.keys(unset)) {
            delete record[key];
          }
        }
      }
    },
  };
}

function allPortableLayerFiles(): Map<string, string> {
  return makeFilesForLayers([...ALL_PORTABLE_PROJECT_LAYERS], [...ALL_PORTABLE_PROJECT_LAYERS]);
}

function fullArchiveRecords(): StagedRecord[] {
  return [
    {
      layer: 'connections',
      collection: 'connector_connections',
      data: { displayName: 'Mercury Core', connectorName: 'http', sourceTenantId: 'source-tenant' },
    },
    {
      layer: 'prompts',
      collection: 'prompt_library_items',
      data: { _id: 'source-prompt-1', name: 'Default Prompt', description: 'Prompt' },
    },
    {
      layer: 'core',
      collection: 'project_agents',
      data: { name: 'Main', dslContent: 'SUPERVISOR: Main\nGOAL: Route requests\n' },
    },
    makeToolRecord({
      name: 'search_docs',
      toolType: 'searchai',
      dslContent: [
        'search_docs(query: string) -> object',
        '  type: searchai',
        '  index_id: "source-index-1"',
        '  tenant_id: "source-tenant-1"',
      ].join('\n'),
    }),
    makeToolRecord({
      name: 'process_loan',
      toolType: 'workflow',
      dslContent: [
        'process_loan(customer_id: string) -> object',
        '  type: workflow',
        '  workflow_id: "source-workflow-1"',
        '  workflow_version: "v2"',
        '  trigger_id: "source-trigger-v2"',
      ].join('\n'),
    }),
    {
      layer: 'search',
      collection: 'search_indexes',
      data: { _exportedId: 'source-index-1', slug: 'loans', name: 'Loans' },
    },
    {
      layer: 'search',
      collection: 'knowledge_bases',
      data: { _exportedId: 'source-kb-1', name: 'Loans KB', _indexSlug: 'loans' },
    },
    {
      layer: 'search',
      collection: 'search_sources',
      data: { _exportedId: 'source-search-source-1', name: 'Loan Docs', _indexSlug: 'loans' },
    },
    {
      layer: 'search',
      collection: 'crawl_patterns',
      data: { domain: 'loans.example.test', patterns: ['/docs/**'] },
    },
    {
      layer: 'workflows',
      collection: 'workflows',
      data: { _exportedId: 'source-workflow-1', name: 'Loan Flow' },
    },
    {
      layer: 'workflows',
      collection: 'workflow_versions',
      data: {
        _workflowName: 'Loan Flow',
        version: 'v2',
        definition: {
          inputSchema: {
            type: 'object',
            required: ['customer_id'],
            properties: { customer_id: { type: 'string' } },
          },
          nodes: [{ id: 'start', nodeType: 'start', config: { inputVariables: [] } }],
          edges: [],
        },
      },
    },
    {
      layer: 'workflows',
      collection: 'trigger_registrations',
      data: {
        _exportedId: 'source-trigger-v2',
        _workflowName: 'Loan Flow',
        _workflowVersion: 'v2',
        triggerName: 'webhook_v2',
        triggerType: 'webhook',
      },
    },
    {
      layer: 'guardrails',
      collection: 'guardrail_policies',
      data: { name: 'Main Guardrail', scope: { type: 'agent' }, _guardrailAgentName: 'Main' },
    },
    {
      layer: 'channels',
      collection: 'channel_connections',
      data: {
        displayName: 'CignaDemo',
        channelType: 'voice_realtime',
        externalIdentifier: 'CignaDemo',
      },
    },
    {
      layer: 'channels',
      collection: 'webhook_subscriptions',
      data: {
        callbackUrl: 'https://voice.example.test/hooks',
        events: ['call.started'],
        _channelDisplayName: 'CignaDemo',
      },
    },
    {
      layer: 'vocabulary',
      collection: 'domain_vocabularies',
      data: { name: 'Loan Terms', _vocabularyKnowledgeBaseId: 'source-kb-1' },
    },
    {
      layer: 'vocabulary',
      collection: 'canonical_schemas',
      data: { name: 'Loan Schema', _schemaKnowledgeBaseId: 'source-kb-1' },
    },
    {
      layer: 'evals',
      collection: 'eval_sets',
      data: {
        name: 'Loan Evals',
        _nestedScenarioNames: ['happy_path'],
        _nestedPersonaNames: ['borrower'],
        _nestedEvaluatorNames: ['accuracy'],
      },
    },
    {
      layer: 'evals',
      collection: 'eval_scenarios',
      data: { name: 'happy_path', _parentSetName: 'Loan Evals' },
    },
    {
      layer: 'evals',
      collection: 'eval_personas',
      data: { name: 'borrower', _parentSetName: 'Loan Evals' },
    },
    {
      layer: 'evals',
      collection: 'eval_evaluators',
      data: { name: 'accuracy', type: 'llm_judge' },
    },
  ];
}

function disassemblersForFullArchive(records: StagedRecord[]): LayerDisassembler[] {
  return ALL_PORTABLE_PROJECT_LAYERS.map((layer) =>
    disassemblerForRecords(
      layer,
      records.filter((record) => record.layer === layer),
    ),
  );
}

export async function runActivationFailureScenario() {
  const dbAdapter = memoryDbAdapter({ failOnActivateLayer: 'core' });
  const result = await runLayeredImportScenario({
    files: makeFilesForLayers(['core']),
    disassemblers: [
      disassemblerForRecords('core', [
        {
          layer: 'core',
          collection: 'project_agents',
          data: {
            name: 'Main',
            dslContent: 'SUPERVISOR: Main\nGOAL: Route requests\n',
            projectId: 'project-import-export-scenarios',
            tenantId: 'tenant-import-export-scenarios',
          },
        },
      ]),
    ],
    dbAdapter,
  });

  return { result, dbAdapter };
}

export async function runBindingResolutionRoundTripScenario() {
  const createRecord = () =>
    makeToolRecord({
      name: 'search_docs',
      toolType: 'searchai',
      dslContent: [
        'search_docs(query: string) -> object',
        '  type: searchai',
        '  index_id: "source-index-1"',
        '  tenant_id: "source-tenant-1"',
      ].join('\n'),
    });

  const previewRecord = createRecord();
  const preview = await runLayeredImportScenario({
    files: makeFilesForLayers(['core']),
    disassemblers: [disassemblerForRecords('core', [previewRecord])],
    options: {
      dryRun: true,
      validateToolBindingForSave: async () => ({ valid: false, message: 'SearchAI index missing' }),
    },
  });

  const requestId = preview.preview.bindingResolutionRequests?.[0]?.id ?? 'missing-request';
  const applyRecord = createRecord();
  const dbAdapter = memoryDbAdapter();
  const applied = await runLayeredImportScenario({
    files: makeFilesForLayers(['core']),
    disassemblers: [disassemblerForRecords('core', [applyRecord])],
    dbAdapter,
    options: {
      dryRun: false,
      validateToolBindingForSave: async (input) => ({
        valid: input.dslContent.includes('index_id: "target-index-1"'),
        message: 'SearchAI index missing',
      }),
      bindingResolutions: {
        [requestId]: {
          action: 'map_existing',
          target: { indexId: 'target-index-1' },
        },
      },
    },
  });

  const persistedRecord = dbAdapter.inserted
    .flatMap((entry) => entry.records)
    .find((record) => record.name === 'search_docs');

  return { preview, applied, applyRecord, persistedRecord };
}

export async function runFullArchiveCrossLayerImportScenario() {
  const records = fullArchiveRecords();
  const dbAdapter = memoryDbAdapter();
  const crossRefDb = memoryCrossRefDb(dbAdapter);
  const result = await runLayeredImportScenario({
    files: allPortableLayerFiles(),
    disassemblers: disassemblersForFullArchive(records),
    dbAdapter,
    crossRefDb,
  });

  return { result, dbAdapter, crossRefDb };
}

export async function runWorkflowVersionTriggerAmbiguityScenario() {
  const toolRecord = makeToolRecord({
    name: 'process_loan',
    toolType: 'workflow',
    dslContent: [
      'process_loan(customer_id: string) -> object',
      '  type: workflow',
      '  workflow_id: "source-workflow-1"',
      '  workflow_version: "v2"',
      '  trigger_id: "source-trigger-v2"',
    ].join('\n'),
  });
  const records: StagedRecord[] = [
    toolRecord,
    {
      layer: 'workflows',
      collection: 'workflows',
      data: { _exportedId: 'source-workflow-1', name: 'Loan Flow' },
    },
    {
      layer: 'workflows',
      collection: 'workflow_versions',
      data: { _workflowName: 'Loan Flow', version: 'v1', definition: { nodes: [] } },
    },
    {
      layer: 'workflows',
      collection: 'workflow_versions',
      data: { _workflowName: 'Loan Flow', version: 'v2', definition: { nodes: [] } },
    },
    {
      layer: 'workflows',
      collection: 'trigger_registrations',
      data: {
        _exportedId: 'source-trigger-v1',
        _workflowName: 'Loan Flow',
        _workflowVersion: 'v1',
        triggerName: 'webhook_v1',
        triggerType: 'webhook',
      },
    },
    {
      layer: 'workflows',
      collection: 'trigger_registrations',
      data: {
        _exportedId: 'source-trigger-v2',
        _workflowName: 'Loan Flow',
        _workflowVersion: 'v2',
        triggerName: 'webhook_v2',
        triggerType: 'webhook',
      },
    },
  ];

  return runLayeredImportScenario({
    files: makeFilesForLayers(['core', 'workflows'], ['core', 'workflows']),
    options: {
      dryRun: true,
      validateToolBindingForSave: async () => {
        throw new Error('Imported workflow metadata should satisfy binding validation');
      },
    },
    disassemblers: [
      disassemblerForRecords('core', [toolRecord]),
      disassemblerForRecords(
        'workflows',
        records.filter((record) => record.layer === 'workflows'),
      ),
    ],
  });
}

export async function runLayerDeselectionWithDependenciesScenario() {
  const toolRecord = makeToolRecord({
    name: 'search_docs',
    toolType: 'searchai',
    dslContent: [
      'search_docs(query: string) -> object',
      '  type: searchai',
      '  index_id: "source-index-1"',
      '  tenant_id: "source-tenant-1"',
    ].join('\n'),
  });
  return runLayeredImportScenario({
    files: makeFilesForLayers(['core', 'search'], ['core', 'search']),
    options: {
      dryRun: true,
      layers: ['core'],
      validateToolBindingForSave: async () => ({ valid: false, message: 'SearchAI index missing' }),
    },
    disassemblers: [disassemblerForRecords('core', [toolRecord])],
  });
}

export async function runPartialLayerAgentScopedReferenceScenario() {
  return runLayeredImportScenario({
    files: makeFilesForLayers(['guardrails'], ['guardrails']),
    options: { dryRun: true, layers: ['guardrails'] },
    disassemblers: [
      disassemblerForRecords('guardrails', [
        {
          layer: 'guardrails',
          collection: 'guardrail_policies',
          data: {
            name: 'Agent Guardrail',
            scope: { type: 'agent', agentName: 'Main' },
            _guardrailAgentName: 'Main',
          },
        },
      ]),
    ],
  });
}

export async function runEmptyModelConfigUnfulfilledScenario() {
  return runLayeredImportScenario({
    files: makeFilesForLayers(['core']),
    options: { dryRun: true },
    disassemblers: [
      disassemblerForRecords('core', [
        {
          layer: 'core',
          collection: 'project_runtime_configs',
          data: {
            sourceFile: 'config/runtime-config.json',
            model: { projectModelConfigId: 'source-model-config' },
          },
        },
      ]),
    ],
  });
}

export async function runChannelUniqueCollisionUpsertScenario() {
  const dbAdapter = memoryDbAdapter();
  const result = await runLayeredImportScenario({
    files: makeFilesForLayers(['channels'], ['channels']),
    options: { layers: ['channels'], conflictStrategy: 'merge' },
    existingState: {
      ...makeExistingProjectState(),
      activeRecords: new Map([
        [
          'channel_connections',
          [
            {
              _id: 'existing-channel-1',
              displayName: 'CignaDemo',
              channelType: 'voice_realtime',
              externalIdentifier: 'CignaDemo',
            },
          ],
        ],
      ]),
    },
    disassemblers: [
      disassemblerForRecords(
        'channels',
        [
          {
            layer: 'channels',
            collection: 'channel_connections',
            data: {
              displayName: 'CignaDemo',
              channelType: 'voice_realtime',
              externalIdentifier: 'CignaDemo',
            },
          },
        ],
        [{ layer: 'channels', collection: 'channel_connections', recordId: 'existing-channel-1' }],
      ),
    ],
    dbAdapter,
    crossRefDb: memoryCrossRefDb(dbAdapter),
  });

  return { result, dbAdapter };
}

export function runGuardrailScopedNameCollisionScenario() {
  return validateEntitySchema('guardrails/scoped.guardrail.json', 'guardrails', {
    _id: 'source-guardrail-1',
    tenantId: 'source-tenant',
    projectId: 'source-project',
    name: 'Sensitive Data Policy',
    scope: { type: 'agent', projectId: 'target-project', agentName: 'Main' },
    createdBy: 'source-user',
  });
}

export async function runSearchGraphCompleteRemappingScenario() {
  const records: StagedRecord[] = [
    {
      layer: 'search',
      collection: 'search_indexes',
      data: { _exportedId: 'source-index-1', slug: 'loans', name: 'Loans' },
    },
    {
      layer: 'search',
      collection: 'search_sources',
      data: {
        _exportedId: 'source-source-1',
        name: 'Loan Docs',
        _indexSlug: 'loans',
        tenantId: 'source-tenant',
      },
    },
    {
      layer: 'search',
      collection: 'knowledge_bases',
      data: {
        _exportedId: 'source-kb-1',
        name: 'Loans KB',
        _indexSlug: 'loans',
        projectId: 'source-project',
      },
    },
    {
      layer: 'vocabulary',
      collection: 'domain_vocabularies',
      data: { name: 'Loan Terms', _vocabularyKnowledgeBaseId: 'source-kb-1' },
    },
    {
      layer: 'vocabulary',
      collection: 'canonical_schemas',
      data: { name: 'Loan Schema', _schemaKnowledgeBaseId: 'source-kb-1' },
    },
  ];
  const dbAdapter = memoryDbAdapter();
  const crossRefDb = memoryCrossRefDb(dbAdapter);
  const result = await runLayeredImportScenario({
    files: makeFilesForLayers(['search', 'vocabulary'], ['search', 'vocabulary']),
    options: { layers: ['search', 'vocabulary'] },
    disassemblers: [
      disassemblerForRecords(
        'search',
        records.filter((record) => record.layer === 'search'),
      ),
      disassemblerForRecords(
        'vocabulary',
        records.filter((record) => record.layer === 'vocabulary'),
      ),
    ],
    dbAdapter,
    crossRefDb,
  });

  return { result, dbAdapter, crossRefDb };
}

export async function runInvalidBindingResolutionScenario() {
  const previewRecord = makeToolRecord({
    name: 'search_docs',
    toolType: 'searchai',
    dslContent: [
      'search_docs(query: string) -> object',
      '  type: searchai',
      '  index_id: "source-index-1"',
      '  tenant_id: "source-tenant-1"',
    ].join('\n'),
  });
  const preview = await runLayeredImportScenario({
    files: makeFilesForLayers(['core']),
    options: {
      dryRun: true,
      validateToolBindingForSave: async () => ({ valid: false, message: 'SearchAI index missing' }),
    },
    disassemblers: [disassemblerForRecords('core', [previewRecord])],
  });
  const requestId = preview.preview.bindingResolutionRequests?.[0]?.id ?? 'missing-request';
  const applyRecord = makeToolRecord({
    name: 'search_docs',
    toolType: 'searchai',
    dslContent: String(previewRecord.data.dslContent),
  });
  const applied = await runLayeredImportScenario({
    files: makeFilesForLayers(['core']),
    options: {
      dryRun: false,
      validateToolBindingForSave: async () => ({ valid: false, message: 'SearchAI index missing' }),
      bindingResolutions: {
        [requestId]: {
          action: 'map_existing',
          target: { workflowId: 'wrong-kind-workflow' },
        },
      },
    },
    disassemblers: [disassemblerForRecords('core', [applyRecord])],
    dbAdapter: memoryDbAdapter(),
  });

  return { preview, applied };
}

export async function runRollbackAfterPartialActivationScenario() {
  const dbAdapter = memoryDbAdapter({ failOnActivateLayer: 'guardrails' });
  const result = await runLayeredImportScenario({
    files: makeFilesForLayers(['core', 'guardrails'], ['core', 'guardrails']),
    disassemblers: [
      disassemblerForRecords('core', [
        {
          layer: 'core',
          collection: 'project_agents',
          data: { name: 'Main', dslContent: 'SUPERVISOR: Main\nGOAL: Route requests\n' },
        },
      ]),
      disassemblerForRecords('guardrails', [
        {
          layer: 'guardrails',
          collection: 'guardrail_policies',
          data: { name: 'Main Guardrail', scope: { type: 'project' } },
        },
      ]),
    ],
    dbAdapter,
    crossRefDb: memoryCrossRefDb(dbAdapter),
  });

  return { result, dbAdapter };
}

export async function runArchivePortabilityHygieneScenario() {
  const result = await runExportScenario({
    options: makeExportOptions({ layers: [...ALL_PORTABLE_PROJECT_LAYERS] }),
    assemblers: ALL_PORTABLE_PROJECT_LAYERS.map((layer) =>
      capturingAssembler(layer, new Map([makeLayerFixture(layer)])),
    ),
  });
  const forbiddenFields = ['tenantId', 'projectId', 'createdBy', 'ownerId', 'encryptedApiKey'];
  const violations: string[] = [];

  for (const [path, content] of result.files) {
    if (!path.endsWith('.json')) continue;
    const parsed = JSON.parse(content) as unknown;
    const serialized = JSON.stringify(parsed);
    for (const field of forbiddenFields) {
      if (serialized.includes(`"${field}"`)) {
        violations.push(`${path}:${field}`);
      }
    }
  }

  return { result, violations };
}

export async function runPostImportProvisioningScenario() {
  const dbAdapter = memoryDbAdapter();
  return runLayeredImportScenario({
    files: new Map([
      [
        'project.json',
        JSON.stringify(
          {
            ...makeManifestWithLayers(['core']),
            metadata: {
              ...makeManifestWithLayers(['core']).metadata,
              required_env_vars: ['MERCURY_API_KEY'],
              required_connectors: ['mercury_core'],
              required_mcp_servers: ['mercury_banking_server'],
            },
          },
          null,
          2,
        ),
      ],
      ['agents/main.agent.abl', 'SUPERVISOR: Main\nGOAL: Route requests\n'],
    ]),
    disassemblers: [
      disassemblerForRecords('core', [
        {
          layer: 'core',
          collection: 'project_agents',
          data: { name: 'Main', dslContent: 'SUPERVISOR: Main\nGOAL: Route requests\n' },
        },
      ]),
    ],
    dbAdapter,
    postImportDb: makeEmptyPostImportDb(),
  });
}

function makeEmptyPostImportDb(): PostImportDbAdapter {
  return {
    async getProjectEnvVars() {
      return [];
    },
    async getProjectConnectors() {
      return [];
    },
    async getProjectMCPServers() {
      return [];
    },
    async getProjectGuardrails() {
      return [];
    },
    async getTenantGuardrailProviders() {
      return [];
    },
    async getProjectAuthProfiles() {
      return [];
    },
  };
}

export async function runArchivePrefixNormalizationScenario() {
  const prefixed = new Map<string, string>();
  for (const [path, content] of makeFilesForLayers(['core'])) {
    prefixed.set(`mercury-bank/${path}`, content);
  }
  return runLayeredImportScenario({
    files: prefixed,
    options: { dryRun: true },
    disassemblers: [disassemblerForRecords('core', [])],
  });
}

export async function runIdempotentReimportPreviewScenario() {
  return runLayeredImportScenario({
    files: makeFilesForLayers(['core']),
    options: { dryRun: true },
    existingState: {
      ...makeExistingProjectState(),
      agents: new Map([
        [
          'Main',
          {
            name: 'Main',
            dslContent: 'SUPERVISOR: Main\nGOAL: Route requests\n',
          },
        ],
      ]),
    },
    disassemblers: [disassemblerForRecords('core', [])],
  });
}
