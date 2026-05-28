import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { ImportPhase, ImportPreviewV2, LayerImportStatus } from '../types.js';
import { assignCollisionSafePath, profileFilePath } from '../export/folder-builder.js';
import {
  mcpServerConfigFilePath,
  serializeMcpServerConfigForFile,
  type ProjectIOMcpServerConfig,
} from '../mcp-server-config-io.js';
import {
  promptBundleFilePath,
  serializePromptLibraryBundleForFile,
  type ProjectIOPromptLibraryBundle,
} from '../prompt-library-io.js';
import { localeAssetRelativePathToFilePath } from '../locale-files.js';
import { sanitizeName } from '../export/layer-assemblers/assembler-utils.js';
import { buildCoreImportSnapshotMetadata } from './core-import-snapshot-metadata.js';
import type {
  CoreImportApplyAdapterV2,
  CoreImportApplyCountsV2,
  CoreImportErrorV2,
  CoreImportApplyPlanV2,
  CoreImportPlanOptionsV2,
} from './core-direct-apply.js';
import { buildCoreImportApplyPlanV2, executeCoreImportApplyPlanV2 } from './core-direct-apply.js';
import { enrichImportPreview, validatePreviewAcknowledgement } from './core-import-preview.js';
import type { ExistingProjectStateV2 } from './project-importer-v2.js';
import {
  createEmptyEvalState,
  type CoreImportEvalEntityStateV2,
  type CoreImportEvalSetStateV2,
} from './core-direct-eval-apply.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const MAX_CORE_IMPORT_SNAPSHOT_SIZE = 14 * 1024 * 1024; // 14MB pre-compression (safe margin for 16MB BSON limit)
const PROJECT_MODEL_SOURCE_BINDING_KEYS = new Set([
  'tenantModelId',
  'credentialId',
  'authProfileId',
]);

export interface CoreImportSnapshotAgentV2 {
  name: string;
  dslContent: string | null;
  description: string | null;
  systemPromptLibraryRef?: {
    promptId: string;
    versionId: string;
    resolvedHash?: string;
  } | null;
}

export interface CoreImportSnapshotToolV2 {
  name: string;
  dslContent: string;
  description: string | null;
}

export type CoreImportSnapshotPromptV2 = ProjectIOPromptLibraryBundle;

export type CoreImportSnapshotMcpServerV2 = ProjectIOMcpServerConfig;

export interface CoreImportSnapshotLocaleV2 {
  relativePath: string;
  value: string;
  description: string | null;
}

export interface CoreImportSnapshotProfileV2 {
  name: string;
  dslContent: string;
}
export interface CoreImportSnapshotAgentModelConfigV2 {
  agentName: string;
  data: Record<string, unknown>;
}
export interface CoreImportSnapshotProjectModelConfigV2 {
  name: string;
  data: Record<string, unknown>;
}

function sanitizeProjectModelSnapshotData(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => !PROJECT_MODEL_SOURCE_BINDING_KEYS.has(key)),
  );
}

function sanitizeProjectModelSnapshotConfig(
  config: CoreImportSnapshotProjectModelConfigV2,
): CoreImportSnapshotProjectModelConfigV2 {
  return {
    ...config,
    data: sanitizeProjectModelSnapshotData(config.data),
  };
}

function hasOwnRecordKey(data: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(data, key);
}

function canonicalizeSnapshotModelPolicyConfigs(input: {
  runtimeConfig?: Record<string, unknown> | null;
  llmConfig?: Record<string, unknown> | null;
}): {
  runtimeConfig?: Record<string, unknown> | null;
  llmConfig?: Record<string, unknown> | null;
} {
  const runtimeConfig = input.runtimeConfig ? { ...input.runtimeConfig } : input.runtimeConfig;
  const llmConfig = input.llmConfig ? { ...input.llmConfig } : input.llmConfig;

  if (
    runtimeConfig &&
    llmConfig &&
    hasOwnRecordKey(runtimeConfig, 'operationTierOverrides') &&
    hasOwnRecordKey(llmConfig, 'operationTierOverrides')
  ) {
    delete runtimeConfig.operationTierOverrides;
  }

  return { runtimeConfig, llmConfig };
}

export type CoreImportSnapshotEvalEntityV2 = CoreImportEvalEntityStateV2;
export type CoreImportSnapshotEvalSetV2 = CoreImportEvalSetStateV2;

export interface CoreImportSnapshotStateV2 {
  agents: CoreImportSnapshotAgentV2[];
  prompts?: CoreImportSnapshotPromptV2[];
  tools: CoreImportSnapshotToolV2[];
  mcpServers?: CoreImportSnapshotMcpServerV2[];
  locales?: CoreImportSnapshotLocaleV2[];
  profiles?: CoreImportSnapshotProfileV2[];
  runtimeConfig?: Record<string, unknown> | null;
  llmConfig?: Record<string, unknown> | null;
  projectModelConfigs?: CoreImportSnapshotProjectModelConfigV2[];
  agentModelConfigs?: CoreImportSnapshotAgentModelConfigV2[];
  evalSets?: CoreImportSnapshotEvalSetV2[];
  evalScenarios?: CoreImportSnapshotEvalEntityV2[];
  evalPersonas?: CoreImportSnapshotEvalEntityV2[];
  evalEvaluators?: CoreImportSnapshotEvalEntityV2[];
  entryAgentName: string | null;
}

export interface CoreImportSnapshotCompressionOptionsV2 {
  maxSnapshotSize?: number;
  onTooLarge?: (size: number) => void;
}

export interface CoreImportCompletedOperationStoreV2 {
  createCompletedOperation(snapshot: Buffer | null): Promise<{ operationId: string }>;
}

export interface CoreImportStateStoreV2 {
  loadCurrentState(): Promise<CoreImportSnapshotStateV2>;
}

export interface CoreImportOperationErrorV2 {
  phase: string;
  layer: string;
  message: string;
}

export interface CoreImportOperationStatusV2 {
  operationId: string;
  status: ImportPhase;
  layers: Record<string, { status: LayerImportStatus }>;
  error: CoreImportOperationErrorV2 | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CoreImportOperationSnapshotResultV2 =
  | {
      success: true;
      rawSnapshot: unknown;
    }
  | {
      success: false;
      error: { code: 'OPERATION_NOT_FOUND' | 'NO_SNAPSHOT'; message: string };
    };

export interface CoreImportOperationStoreV2 extends CoreImportCompletedOperationStoreV2 {
  getOperationStatus(operationId: string): Promise<CoreImportOperationStatusV2 | null>;
  getOperationSnapshot(operationId: string): Promise<CoreImportOperationSnapshotResultV2>;
}

export interface CoreImportStoreV2 extends CoreImportOperationStoreV2, CoreImportStateStoreV2 {}

export interface BuildCoreImportSnapshotFilesInputV2 extends CoreImportSnapshotStateV2 {
  description: string;
}

export interface PrepareCoreImportApplyOptionsV2 {
  files: Map<string, string>;
  planOptions: CoreImportPlanOptionsV2;
  stateStore: CoreImportStateStoreV2;
}

export type PrepareCoreImportApplyResultV2 =
  | {
      success: true;
      currentState: CoreImportSnapshotStateV2;
      plan: CoreImportApplyPlanV2;
    }
  | {
      success: false;
      error: CoreImportErrorV2;
      preview?: ImportPreviewV2;
      warnings: string[];
    };

export interface PreviewCoreImportOptionsV2 extends PrepareCoreImportApplyOptionsV2 {}

export type PreviewCoreImportResultV2 =
  | {
      success: true;
      currentState: CoreImportSnapshotStateV2;
      plan: CoreImportApplyPlanV2;
      preview: ImportPreviewV2;
      warnings: string[];
    }
  | {
      success: false;
      error: CoreImportErrorV2;
      preview?: ImportPreviewV2;
      warnings: string[];
    };

function isUnsafeImportPath(filePath: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(filePath);
  } catch {
    return true;
  }

  if (decoded.startsWith('/') || decoded.includes('//')) {
    return true;
  }

  const segments = decoded.split('/');
  return segments.some((segment) => !segment || segment === '.' || segment === '..');
}

function validateCoreImportFilePaths(files: Map<string, string>): CoreImportErrorV2 | null {
  for (const filePath of files.keys()) {
    if (isUnsafeImportPath(filePath)) {
      return {
        code: 'UNSAFE_IMPORT_PATH',
        message: `Import file path is not safe: ${filePath}`,
      };
    }
  }

  return null;
}

export interface ApplyCoreImportPlanWithSnapshotOptionsV2 {
  plan: CoreImportApplyPlanV2;
  currentState: CoreImportSnapshotStateV2;
  adapter: CoreImportApplyAdapterV2;
  operationStore: CoreImportCompletedOperationStoreV2;
  snapshotDescription: string;
  snapshotCompression?: CoreImportSnapshotCompressionOptionsV2;
}

export type ApplyCoreImportPlanWithSnapshotResultV2 =
  | {
      success: true;
      operationId: string;
      applied: CoreImportApplyCountsV2;
      entryAgentName: string | null;
    }
  | {
      success: false;
      operationId: string;
      error: CoreImportErrorV2;
    };

export interface CoreImportAcknowledgementOptionsV2 {
  previewDigest?: string | null;
  acknowledgedIssueIds?: string[] | null;
  enforce?: boolean;
}

export interface CoreImportSnapshotExecutionOptionsV2 {
  operationStore: CoreImportCompletedOperationStoreV2;
  description: string;
  compression?: CoreImportSnapshotCompressionOptionsV2;
}

export interface ApplyCoreImportOptionsV2 {
  files: Map<string, string>;
  planOptions: CoreImportPlanOptionsV2;
  stateStore: CoreImportStateStoreV2;
  adapter: CoreImportApplyAdapterV2;
  acknowledgement?: CoreImportAcknowledgementOptionsV2;
  snapshot?: CoreImportSnapshotExecutionOptionsV2;
}

export type ApplyCoreImportResultV2 =
  | {
      success: true;
      preview: ImportPreviewV2;
      warnings: string[];
      applied: CoreImportApplyCountsV2;
      entryAgentName: string | null;
      operationId?: string;
    }
  | {
      success: false;
      stage: 'prepare' | 'preview' | 'acknowledgement' | 'apply';
      error: CoreImportErrorV2;
      preview?: ImportPreviewV2;
      warnings: string[];
      operationId?: string;
    };

export interface RevertCoreImportFromSnapshotOptionsV2 {
  rawSnapshot: unknown;
  currentState: CoreImportSnapshotStateV2;
  planOptions: CoreImportPlanOptionsV2;
  resolvePlanOptionsFromSnapshot?: (
    snapshotFiles: Record<string, string>,
    basePlanOptions: CoreImportPlanOptionsV2,
  ) => Promise<CoreImportPlanOptionsV2> | CoreImportPlanOptionsV2;
  adapter: CoreImportApplyAdapterV2;
  operationStore: CoreImportCompletedOperationStoreV2;
  snapshotDescription: string;
  snapshotCompression?: CoreImportSnapshotCompressionOptionsV2;
}

export type RevertCoreImportFromSnapshotResultV2 =
  | {
      success: true;
      operationId: string;
      applied: CoreImportApplyCountsV2;
      entryAgentName: string | null;
    }
  | {
      success: false;
      stage: 'snapshot' | 'plan' | 'apply';
      error: CoreImportErrorV2;
      preview?: ImportPreviewV2;
      operationId?: string;
    };

export interface RevertCoreImportOperationOptionsV2 {
  operationId: string;
  planOptions: CoreImportPlanOptionsV2;
  resolvePlanOptionsFromSnapshot?: (
    snapshotFiles: Record<string, string>,
    basePlanOptions: CoreImportPlanOptionsV2,
  ) => Promise<CoreImportPlanOptionsV2> | CoreImportPlanOptionsV2;
  adapter: CoreImportApplyAdapterV2;
  store: CoreImportStoreV2;
  snapshotDescription: string;
  snapshotCompression?: CoreImportSnapshotCompressionOptionsV2;
}

export type RevertCoreImportOperationResultV2 =
  | {
      success: true;
      operationId: string;
      applied: CoreImportApplyCountsV2;
      entryAgentName: string | null;
    }
  | {
      success: false;
      stage: 'operation' | 'snapshot' | 'plan' | 'apply';
      error: CoreImportErrorV2;
      preview?: ImportPreviewV2;
      operationId?: string;
    };

export function buildCoreImportExistingStateV2(
  currentState: CoreImportSnapshotStateV2,
): ExistingProjectStateV2 {
  const mcpServers = currentState.mcpServers
    ? new Map(
        currentState.mcpServers.map((server) => [
          server.name,
          { name: server.name, config: server },
        ]),
      )
    : undefined;
  const evals = createEmptyEvalState();
  for (const evalSet of currentState.evalSets ?? []) {
    evals.sets.set(evalSet.name, evalSet);
  }
  for (const scenario of currentState.evalScenarios ?? []) {
    evals.scenarios.set(scenario.name, scenario);
  }
  for (const persona of currentState.evalPersonas ?? []) {
    evals.personas.set(persona.name, persona);
  }
  for (const evaluator of currentState.evalEvaluators ?? []) {
    evals.evaluators.set(evaluator.name, evaluator);
  }

  return {
    agents: new Map(
      currentState.agents.map((agent) => [
        agent.name,
        {
          name: agent.name,
          dslContent: agent.dslContent,
          systemPromptLibraryRef: agent.systemPromptLibraryRef ?? null,
        },
      ]),
    ),
    prompts: new Map((currentState.prompts ?? []).map((prompt) => [prompt.promptId, prompt])),
    toolFiles: new Map(),
    tools: new Map(
      currentState.tools.map((tool) => [
        tool.name,
        { name: tool.name, dslContent: tool.dslContent },
      ]),
    ),
    ...(mcpServers ? { mcpServers } : {}),
    localeFiles: new Map(
      (currentState.locales ?? []).map((locale) => [
        localeAssetRelativePathToFilePath(locale.relativePath),
        locale.value,
      ]),
    ),
    locales: new Map(
      (currentState.locales ?? []).map((locale) => [
        localeAssetRelativePathToFilePath(locale.relativePath),
        {
          filePath: localeAssetRelativePathToFilePath(locale.relativePath),
          value: locale.value,
          description: locale.description ?? null,
        },
      ]),
    ),
    profileFiles: new Map(
      (currentState.profiles ?? []).map((profile) => [
        profileFilePath(profile.name),
        profile.dslContent,
      ]),
    ),
    runtimeConfig: currentState.runtimeConfig ?? null,
    llmConfig: currentState.llmConfig ?? null,
    projectModelConfigs: new Map(
      (currentState.projectModelConfigs ?? []).map((config) => [
        config.name,
        sanitizeProjectModelSnapshotConfig(config),
      ]),
    ),
    agentModelConfigs: new Map(
      (currentState.agentModelConfigs ?? []).map((config) => [config.agentName, config]),
    ),
    evals,
    activeRecords: new Map(),
  };
}

export function buildCoreImportSnapshotFilesV2(
  input: BuildCoreImportSnapshotFilesInputV2,
): Record<string, string> {
  const snapshotFiles: Record<string, string> = {};
  const assignedPaths = new Set<string>();
  const setSnapshotFile = (path: string, content: string) => {
    const safePath = assignCollisionSafePath(path, assignedPaths);
    snapshotFiles[safePath] = content;
    assignedPaths.add(safePath);
  };
  const { runtimeConfig, llmConfig } = canonicalizeSnapshotModelPolicyConfigs(input);

  for (const agent of input.agents) {
    if (agent.dslContent) {
      setSnapshotFile(`agents/${agent.name}.agent.abl`, agent.dslContent);
    }
  }

  for (const prompt of input.prompts ?? []) {
    setSnapshotFile(promptBundleFilePath(prompt.name), serializePromptLibraryBundleForFile(prompt));
  }

  for (const tool of input.tools) {
    setSnapshotFile(`tools/${tool.name}.tools.abl`, tool.dslContent);
  }

  for (const server of input.mcpServers ?? []) {
    setSnapshotFile(mcpServerConfigFilePath(server.name), serializeMcpServerConfigForFile(server));
  }

  for (const locale of input.locales ?? []) {
    setSnapshotFile(localeAssetRelativePathToFilePath(locale.relativePath), locale.value);
  }

  for (const profile of input.profiles ?? []) {
    setSnapshotFile(profileFilePath(profile.name), profile.dslContent);
  }

  if (runtimeConfig) {
    setSnapshotFile('config/runtime-config.json', JSON.stringify(runtimeConfig, null, 2));
  }

  if (llmConfig) {
    setSnapshotFile('config/llm-config.json', JSON.stringify(llmConfig, null, 2));
  }

  for (const config of input.projectModelConfigs ?? []) {
    const sanitizedConfig = sanitizeProjectModelSnapshotConfig(config);
    setSnapshotFile(
      `config/project-model-configs/${sanitizeName(config.name)}.model-config.json`,
      JSON.stringify(sanitizedConfig.data, null, 2),
    );
  }

  for (const config of input.agentModelConfigs ?? []) {
    setSnapshotFile(
      `config/agent-model-configs/${sanitizeName(config.agentName)}.model-config.json`,
      JSON.stringify(config.data, null, 2),
    );
  }

  for (const scenario of input.evalScenarios ?? []) {
    setSnapshotFile(
      `evals/scenarios/${sanitizeName(scenario.name)}.scenario.json`,
      JSON.stringify(scenario.data, null, 2),
    );
  }

  for (const persona of input.evalPersonas ?? []) {
    setSnapshotFile(
      `evals/personas/${sanitizeName(persona.name)}.persona.json`,
      JSON.stringify(persona.data, null, 2),
    );
  }

  for (const evaluator of input.evalEvaluators ?? []) {
    setSnapshotFile(
      `evals/evaluators/${sanitizeName(evaluator.name)}.evaluator.json`,
      JSON.stringify(evaluator.data, null, 2),
    );
  }

  for (const evalSet of input.evalSets ?? []) {
    setSnapshotFile(
      `evals/${sanitizeName(evalSet.name)}/eval-set.json`,
      JSON.stringify(
        {
          ...evalSet.data,
          _nestedScenarioNames: evalSet.scenarioNames,
          _nestedPersonaNames: evalSet.personaNames,
          _nestedEvaluatorNames: evalSet.evaluatorNames,
        },
        null,
        2,
      ),
    );
  }

  const snapshotMetadata = buildCoreImportSnapshotMetadata(input.locales);
  if (snapshotMetadata) {
    setSnapshotFile('.core-import-snapshot.json', snapshotMetadata);
  }

  const snapshotLayers = [
    'core',
    ...((input.prompts?.length ?? 0) > 0 ? ['prompts'] : []),
    ...(input.evalSets?.length ||
    input.evalScenarios?.length ||
    input.evalPersonas?.length ||
    input.evalEvaluators?.length
      ? ['evals']
      : []),
  ];

  setSnapshotFile(
    'project.json',
    JSON.stringify({
      format_version: '2.0',
      name: 'snapshot',
      slug: 'snapshot',
      description: input.description,
      abl_version: '1.0',
      exported_at: new Date().toISOString(),
      exported_by: 'system',
      entry_agent: input.entryAgentName,
      dsl_format: 'legacy',
      layers_included: snapshotLayers,
      agents: Object.fromEntries(
        input.agents.map((agent) => [
          agent.name,
          {
            path: `agents/${agent.name}.agent.abl`,
            owner: null,
            ownerTeam: null,
            description: agent.description ?? null,
            version: null,
            systemPromptLibraryRef: agent.systemPromptLibraryRef ?? null,
          },
        ]),
      ),
      tools: Object.fromEntries(
        input.tools.map((tool) => [
          tool.name,
          { path: `tools/${tool.name}.tools.abl`, owner: null },
        ]),
      ),
      behavior_profiles: Object.fromEntries(
        (input.profiles ?? []).map((profile) => [
          profile.name,
          {
            name: profile.name,
            path: profileFilePath(profile.name),
            priority: 0,
            when_summary: '',
            used_by: [],
          },
        ]),
      ),
      metadata: {
        entity_counts: {
          agents: input.agents.length,
          prompt_library_items: input.prompts?.length ?? 0,
          prompt_library_versions: (input.prompts ?? []).reduce(
            (total, prompt) => total + prompt.versions.length,
            0,
          ),
          tools: input.tools.length,
          mcp_servers: input.mcpServers?.length ?? 0,
          locale_files: input.locales?.length ?? 0,
          behavior_profiles: input.profiles?.length ?? 0,
          model_policy_configs:
            (input.runtimeConfig ? 1 : 0) +
            (input.llmConfig ? 1 : 0) +
            (input.projectModelConfigs?.length ?? 0) +
            (input.agentModelConfigs?.length ?? 0),
          eval_sets: input.evalSets?.length ?? 0,
          eval_scenarios: input.evalScenarios?.length ?? 0,
          eval_personas: input.evalPersonas?.length ?? 0,
          eval_evaluators: input.evalEvaluators?.length ?? 0,
        },
        required_env_vars: [],
        required_connectors: [],
        required_mcp_servers: (input.mcpServers ?? []).map((server) => server.name),
      },
    }),
  );

  return snapshotFiles;
}

export async function compressCoreImportSnapshotFilesV2(
  snapshotFiles: Record<string, string>,
  options: CoreImportSnapshotCompressionOptionsV2 = {},
): Promise<Buffer | null> {
  const snapshotJson = JSON.stringify(snapshotFiles);
  if (snapshotJson.length > (options.maxSnapshotSize ?? MAX_CORE_IMPORT_SNAPSHOT_SIZE)) {
    options.onTooLarge?.(snapshotJson.length);
    return null;
  }

  return gzipAsync(Buffer.from(snapshotJson, 'utf-8'));
}

function normalizeSnapshotBuffer(rawSnapshot: unknown): Buffer {
  if (Buffer.isBuffer(rawSnapshot)) {
    return rawSnapshot;
  }

  if (!rawSnapshot || typeof rawSnapshot !== 'object') {
    throw new Error('Snapshot payload is not a binary buffer');
  }

  const binary = (rawSnapshot as { buffer?: unknown }).buffer;
  if (Buffer.isBuffer(binary)) {
    return binary;
  }

  if (binary instanceof Uint8Array) {
    return Buffer.from(binary);
  }

  if (binary instanceof ArrayBuffer || binary instanceof SharedArrayBuffer) {
    return Buffer.from(binary);
  }

  throw new Error('Snapshot payload is not a supported binary buffer');
}

export async function decompressCoreImportSnapshotFilesV2(
  rawSnapshot: unknown,
): Promise<Record<string, string>> {
  const decompressed = await gunzipAsync(normalizeSnapshotBuffer(rawSnapshot));
  const parsed = JSON.parse(decompressed.toString('utf-8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Snapshot payload must decode to an object file map');
  }
  return parsed as Record<string, string>;
}

export async function prepareCoreImportApplyV2(
  input: PrepareCoreImportApplyOptionsV2,
): Promise<PrepareCoreImportApplyResultV2> {
  const unsafePathError = validateCoreImportFilePaths(input.files);
  if (unsafePathError) {
    return {
      success: false,
      error: unsafePathError,
      warnings: [],
    };
  }

  const currentState = await input.stateStore.loadCurrentState();
  const planResult = await buildCoreImportApplyPlanV2(
    input.files,
    buildCoreImportExistingStateV2(currentState),
    input.planOptions,
  );

  if (!planResult.success) {
    return {
      ...planResult,
      warnings: planResult.warnings,
    };
  }

  return {
    success: true,
    currentState,
    plan: planResult.plan,
  };
}

export async function previewCoreImportV2(
  input: PreviewCoreImportOptionsV2,
): Promise<PreviewCoreImportResultV2> {
  const planResult = await prepareCoreImportApplyV2(input);
  if (!planResult.success) {
    return planResult;
  }

  return {
    success: true,
    currentState: planResult.currentState,
    plan: planResult.plan,
    preview: enrichImportPreview(planResult.plan.preview, planResult.plan.preparedFiles),
    warnings: [...planResult.plan.warnings],
  };
}

export async function applyCoreImportPlanWithSnapshotV2(
  input: ApplyCoreImportPlanWithSnapshotOptionsV2,
): Promise<ApplyCoreImportPlanWithSnapshotResultV2> {
  const snapshotFiles = buildCoreImportSnapshotFilesV2({
    ...input.currentState,
    description: input.snapshotDescription,
  });
  const compressedSnapshot = await compressCoreImportSnapshotFilesV2(
    snapshotFiles,
    input.snapshotCompression,
  );
  const { operationId } = await input.operationStore.createCompletedOperation(compressedSnapshot);

  const executionResult = await executeCoreImportApplyPlanV2(input.plan, input.adapter);
  if (!executionResult.success) {
    return {
      success: false,
      operationId,
      error: executionResult.error ?? {
        code: 'IMPORT_APPLY_FAILED',
        message: 'Import failed during apply',
      },
    };
  }

  return {
    success: true,
    operationId,
    applied: executionResult.applied ?? input.plan.applied,
    entryAgentName: executionResult.entryAgentName ?? input.plan.entryAgentName,
  };
}

export async function applyCoreImportV2(
  input: ApplyCoreImportOptionsV2,
): Promise<ApplyCoreImportResultV2> {
  const previewResult = await previewCoreImportV2({
    files: input.files,
    planOptions: input.planOptions,
    stateStore: input.stateStore,
  });

  if (!previewResult.success) {
    return {
      success: false,
      stage: 'prepare',
      error: previewResult.error,
      preview: previewResult.preview,
      warnings: previewResult.warnings,
    };
  }

  if (previewResult.preview.hasBlockingIssues) {
    return {
      success: false,
      stage: 'preview',
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Import preview contains blocking issues',
      },
      preview: previewResult.preview,
      warnings: previewResult.warnings,
    };
  }

  if (input.acknowledgement?.enforce) {
    const acknowledgement = validatePreviewAcknowledgement(
      previewResult.preview,
      input.acknowledgement.previewDigest,
      input.acknowledgement.acknowledgedIssueIds,
    );
    if (!acknowledgement.ok) {
      return {
        success: false,
        stage: 'acknowledgement',
        error: {
          code: acknowledgement.code,
          message: acknowledgement.message,
        },
        preview: previewResult.preview,
        warnings: previewResult.warnings,
      };
    }
  }

  if (input.snapshot) {
    const applyResult = await applyCoreImportPlanWithSnapshotV2({
      plan: previewResult.plan,
      currentState: previewResult.currentState,
      adapter: input.adapter,
      operationStore: input.snapshot.operationStore,
      snapshotDescription: input.snapshot.description,
      snapshotCompression: input.snapshot.compression,
    });

    if (!applyResult.success) {
      return {
        success: false,
        stage: 'apply',
        error: applyResult.error,
        preview: previewResult.preview,
        warnings: previewResult.warnings,
        operationId: applyResult.operationId,
      };
    }

    return {
      success: true,
      preview: previewResult.preview,
      warnings: previewResult.warnings,
      applied: applyResult.applied,
      entryAgentName: applyResult.entryAgentName,
      operationId: applyResult.operationId,
    };
  }

  const executionResult = await executeCoreImportApplyPlanV2(previewResult.plan, input.adapter);
  if (!executionResult.success) {
    return {
      success: false,
      stage: 'apply',
      error: executionResult.error ?? {
        code: 'IMPORT_APPLY_FAILED',
        message: 'Import failed during apply',
      },
      preview: previewResult.preview,
      warnings: previewResult.warnings,
    };
  }

  return {
    success: true,
    preview: previewResult.preview,
    warnings: previewResult.warnings,
    applied: executionResult.applied ?? previewResult.plan.applied,
    entryAgentName: executionResult.entryAgentName ?? previewResult.plan.entryAgentName,
  };
}

export async function revertCoreImportFromSnapshotV2(
  input: RevertCoreImportFromSnapshotOptionsV2,
): Promise<RevertCoreImportFromSnapshotResultV2> {
  let snapshotFiles: Record<string, string>;
  try {
    snapshotFiles = await decompressCoreImportSnapshotFilesV2(input.rawSnapshot);
  } catch {
    return {
      success: false,
      stage: 'snapshot',
      error: {
        code: 'SNAPSHOT_CORRUPT',
        message: 'Failed to decompress pre-import snapshot',
      },
    };
  }

  const planOptions = input.resolvePlanOptionsFromSnapshot
    ? await input.resolvePlanOptionsFromSnapshot(snapshotFiles, input.planOptions)
    : input.planOptions;
  const planResult = await buildCoreImportApplyPlanV2(
    new Map(Object.entries(snapshotFiles)),
    buildCoreImportExistingStateV2(input.currentState),
    planOptions,
  );

  if (!planResult.success) {
    return {
      success: false,
      stage: 'plan',
      error: planResult.error,
      preview: planResult.preview,
    };
  }

  const applyResult = await applyCoreImportPlanWithSnapshotV2({
    plan: planResult.plan,
    currentState: input.currentState,
    adapter: input.adapter,
    operationStore: input.operationStore,
    snapshotDescription: input.snapshotDescription,
    snapshotCompression: input.snapshotCompression,
  });

  if (!applyResult.success) {
    return {
      success: false,
      stage: 'apply',
      error: applyResult.error,
      operationId: applyResult.operationId,
    };
  }

  return applyResult;
}

export async function revertCoreImportOperationV2(
  input: RevertCoreImportOperationOptionsV2,
): Promise<RevertCoreImportOperationResultV2> {
  const snapshotResult = await input.store.getOperationSnapshot(input.operationId);
  if (!snapshotResult.success) {
    return {
      success: false,
      stage: 'operation',
      error: snapshotResult.error,
    };
  }

  const currentState = await input.store.loadCurrentState();

  return revertCoreImportFromSnapshotV2({
    rawSnapshot: snapshotResult.rawSnapshot,
    currentState,
    planOptions: input.planOptions,
    resolvePlanOptionsFromSnapshot: input.resolvePlanOptionsFromSnapshot,
    adapter: input.adapter,
    operationStore: input.store,
    snapshotDescription: input.snapshotDescription,
    snapshotCompression: input.snapshotCompression,
  });
}
