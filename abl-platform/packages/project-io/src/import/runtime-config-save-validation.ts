import { ModelConfig, PromptLibraryVersion, TenantModel } from '@agent-platform/database/models';
import {
  formatOperationTierOverrideError,
  normalizeOperationTierOverrides,
} from '@agent-platform/shared';
import {
  runtimeConfigUpdateSchema,
  type RuntimeConfigUpdateInput,
} from '@agent-platform/shared/validation';
import { isPromptBundleFilePath, parsePromptLibraryBundleFile } from '../prompt-library-io.js';
import { stripCommonPrefix } from './path-normalizer.js';

// Strict schema — rejects truly unknown runtime config fields.
const runtimeConfigImportSchema = runtimeConfigUpdateSchema.strict();

export interface ImportedPromptVersionSnapshot {
  promptId: string;
  versionId: string;
  status: 'draft' | 'active' | 'archived';
}

export interface ProjectRuntimeConfigWriteValidationInput {
  tenantId: string;
  projectId: string;
  data: Record<string, unknown>;
  importedPromptVersions?: Map<string, ImportedPromptVersionSnapshot>;
  importedProjectModelIds?: ReadonlySet<string>;
}

export interface ProjectModelPolicyConfigWriteValidationInput {
  data: Record<string, unknown>;
}

export type ProjectRuntimeConfigWriteValidationResult =
  | { valid: true; data: RuntimeConfigUpdateInput }
  | {
      valid: false;
      code: string;
      status: number;
      message: string;
    };

export type ProjectModelPolicyConfigWriteValidationResult =
  | { valid: true; data: Record<string, unknown> }
  | {
      valid: false;
      code: string;
      status: number;
      message: string;
    };

interface PortableTenantModelRef {
  provider: string;
  modelId: string;
  tier?: string;
  capabilities?: string[];
}

type RuntimeConfigDraft = Record<string, unknown>;
const MODEL_POLICY_IMPORT_METADATA_KEYS = new Set([
  '_id',
  'id',
  '__v',
  '_v',
  'tenantId',
  'projectId',
  'createdAt',
  'updatedAt',
  'createdBy',
  'updatedBy',
  'modifiedBy',
  'ownerId',
  'ownerTeamId',
  'lastEditedBy',
  'sourceFile',
]);

function formatZodIssues(error: {
  issues: Array<{ path: Array<string | number>; message: string }>;
}): string {
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stripModelPolicyImportMetadata(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => !MODEL_POLICY_IMPORT_METADATA_KEYS.has(key)),
  );
}

export function stripRuntimeConfigSaveValidationMetadata(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return stripModelPolicyImportMetadata(data);
}

function promptVersionKey(promptId: string, versionId: string): string {
  return `${promptId}:${versionId}`;
}

function normalizeArchiveReferenceFiles(files: ReadonlyMap<string, string>): Map<string, string> {
  return stripCommonPrefix(new Map(files)).files;
}

function readPortableTenantModelRef(value: unknown): PortableTenantModelRef | null {
  if (!isRecord(value) || typeof value.provider !== 'string' || typeof value.modelId !== 'string') {
    return null;
  }

  return {
    provider: value.provider,
    modelId: value.modelId,
    ...(typeof value.tier === 'string' ? { tier: value.tier } : {}),
    ...(Array.isArray(value.capabilities)
      ? { capabilities: value.capabilities.filter((cap): cap is string => typeof cap === 'string') }
      : {}),
  };
}

async function resolveDestinationTenantModelId(input: {
  tenantId: string;
  sectionName: string;
  ref: PortableTenantModelRef;
}): Promise<{ ok: true; tenantModelId: string } | { ok: false; message: string }> {
  const candidates = (await TenantModel.find({
    tenantId: input.tenantId,
    provider: input.ref.provider,
    modelId: input.ref.modelId,
    isActive: true,
    inferenceEnabled: { $ne: false },
  }).lean()) as Array<Record<string, unknown>>;

  const needsRealtimeVoice =
    input.ref.tier === 'voice' || input.ref.capabilities?.includes('realtime_voice') === true;
  const matches = needsRealtimeVoice
    ? candidates.filter(
        (candidate) =>
          Array.isArray(candidate.capabilities) &&
          candidate.capabilities.includes('realtime_voice'),
      )
    : candidates;

  if (matches.length === 0) {
    return {
      ok: false,
      message: `Runtime ${input.sectionName} model requires an active destination tenant model for ${input.ref.provider}/${input.ref.modelId}`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      message: `Runtime ${input.sectionName} model matched multiple destination tenant models for ${input.ref.provider}/${input.ref.modelId}; choose an explicit model binding before import`,
    };
  }

  const tenantModelId = matches[0]?._id;
  if (typeof tenantModelId !== 'string' || tenantModelId.length === 0) {
    return {
      ok: false,
      message: `Runtime ${input.sectionName} model matched a destination tenant model without an id`,
    };
  }

  return { ok: true, tenantModelId };
}

async function normalizePortableRuntimeModelRefs(input: {
  tenantId: string;
  data: RuntimeConfigDraft;
}): Promise<{ ok: true; data: RuntimeConfigDraft } | { ok: false; message: string }> {
  const normalized: RuntimeConfigDraft = { ...input.data };

  for (const sectionName of ['pipeline', 'filler'] as const) {
    const section = normalized[sectionName];
    if (!isRecord(section)) {
      continue;
    }

    const sectionCopy: RuntimeConfigDraft = { ...section };
    const portableRef = readPortableTenantModelRef(sectionCopy.tenantModelRef);
    delete sectionCopy.tenantModelRef;

    if (
      sectionCopy.modelSource === 'tenant' &&
      typeof sectionCopy.tenantModelId !== 'string' &&
      portableRef
    ) {
      const resolved = await resolveDestinationTenantModelId({
        tenantId: input.tenantId,
        sectionName,
        ref: portableRef,
      });
      if (!resolved.ok) {
        return resolved;
      }
      sectionCopy.tenantModelId = resolved.tenantModelId;
    }

    normalized[sectionName] = sectionCopy;
  }

  return { ok: true, data: normalized };
}

function collectProjectModelIds(config: RuntimeConfigUpdateInput): string[] {
  return [config.filler?.modelSource === 'project' ? config.filler.modelId : undefined].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
}

function collectTenantModelIds(config: RuntimeConfigUpdateInput): string[] {
  return [
    config.pipeline?.modelSource === 'tenant' ? config.pipeline.tenantModelId : undefined,
    config.filler?.modelSource === 'tenant' ? config.filler.tenantModelId : undefined,
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);
}

async function validatePromptRef(input: {
  tenantId: string;
  projectId: string;
  promptId: string;
  versionId: string;
  importedPromptVersions?: Map<string, ImportedPromptVersionSnapshot>;
}): Promise<boolean> {
  const imported = input.importedPromptVersions?.get(
    promptVersionKey(input.promptId, input.versionId),
  );
  if (imported) {
    return imported.status !== 'archived';
  }

  const version = (await PromptLibraryVersion.findOne(
    {
      _id: input.versionId,
      promptId: input.promptId,
      tenantId: input.tenantId,
      projectId: input.projectId,
    },
    { _id: 1, promptId: 1, status: 1 },
  ).lean()) as { status?: string } | null;

  return version !== null && version.status !== 'archived';
}

export function collectImportedPromptVersionSnapshots(
  files: ReadonlyMap<string, string>,
): Map<string, ImportedPromptVersionSnapshot> {
  const snapshots = new Map<string, ImportedPromptVersionSnapshot>();

  for (const [filePath, content] of normalizeArchiveReferenceFiles(files)) {
    if (!isPromptBundleFilePath(filePath)) {
      continue;
    }

    const parsed = parsePromptLibraryBundleFile(filePath, content);
    if (!parsed.success) {
      continue;
    }

    for (const version of parsed.data.versions) {
      if (!version) {
        continue;
      }
      snapshots.set(promptVersionKey(parsed.data.promptId, version.versionId), {
        promptId: parsed.data.promptId,
        versionId: version.versionId,
        status: version.status,
      });
    }
  }

  return snapshots;
}

export function collectImportedProjectModelIds(files: ReadonlyMap<string, string>): Set<string> {
  const modelIds = new Set<string>();

  for (const [filePath, content] of normalizeArchiveReferenceFiles(files)) {
    if (!/^config\/project-model-configs\/[^/]+\.model-config\.json$/.test(filePath)) {
      continue;
    }

    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (typeof parsed.modelId === 'string' && parsed.modelId.length > 0) {
        modelIds.add(parsed.modelId);
      }
    } catch {
      continue;
    }
  }

  return modelIds;
}

export function validateProjectModelPolicyConfigWrite({
  data,
}: ProjectModelPolicyConfigWriteValidationInput): ProjectModelPolicyConfigWriteValidationResult {
  const normalized = { ...data };

  if (Object.prototype.hasOwnProperty.call(normalized, 'operationTierOverrides')) {
    const validation = normalizeOperationTierOverrides(normalized.operationTierOverrides);
    if (!validation.ok) {
      return {
        valid: false,
        status: 400,
        code: 'MODEL_POLICY_OPERATION_TIERS_INVALID',
        message: formatOperationTierOverrideError(validation),
      };
    }
    normalized.operationTierOverrides = validation.overrides;
  }

  return { valid: true, data: normalized };
}

export async function validateProjectRuntimeConfigWrite({
  tenantId,
  projectId,
  data,
  importedPromptVersions,
  importedProjectModelIds,
}: ProjectRuntimeConfigWriteValidationInput): Promise<ProjectRuntimeConfigWriteValidationResult> {
  const normalized = await normalizePortableRuntimeModelRefs({ tenantId, data });
  if (!normalized.ok) {
    return {
      valid: false,
      status: 400,
      code: 'RUNTIME_CONFIG_TENANT_MODEL_NOT_FOUND',
      message: normalized.message,
    };
  }

  const dataToValidate = normalized.data
    ? stripRuntimeConfigSaveValidationMetadata(normalized.data)
    : normalized.data;

  const parsed = runtimeConfigImportSchema.safeParse(dataToValidate);
  if (!parsed.success) {
    return {
      valid: false,
      status: 400,
      code: 'RUNTIME_CONFIG_SCHEMA_INVALID',
      message: formatZodIssues(parsed.error),
    };
  }

  if (
    parsed.data.extraction?.nlu_provider === 'advanced' &&
    !parsed.data.extraction.advanced_sidecar_url
  ) {
    return {
      valid: false,
      status: 400,
      code: 'RUNTIME_CONFIG_ADVANCED_NLU_URL_REQUIRED',
      message: 'advanced_sidecar_url is required when nlu_provider is advanced',
    };
  }

  if (parsed.data.operationTierOverrides !== undefined) {
    const validation = validateProjectModelPolicyConfigWrite({
      data: { operationTierOverrides: parsed.data.operationTierOverrides },
    });
    if (!validation.valid) {
      return {
        valid: false,
        status: validation.status,
        code: 'RUNTIME_CONFIG_OPERATION_TIERS_INVALID',
        message: validation.message,
      };
    }
    parsed.data.operationTierOverrides = validation.data.operationTierOverrides as Record<
      string,
      string
    >;
  }

  const projectModelIds = [...new Set(collectProjectModelIds(parsed.data))];
  if (projectModelIds.length > 0) {
    const foundModelIds = await ModelConfig.distinct('modelId', {
      modelId: { $in: projectModelIds },
      projectId,
      tenantId,
    });
    const availableModelIds = new Set([...foundModelIds, ...(importedProjectModelIds ?? [])]);
    const missingModelIds = projectModelIds.filter((modelId) => !availableModelIds.has(modelId));
    if (missingModelIds.length > 0) {
      return {
        valid: false,
        status: 400,
        code: 'RUNTIME_CONFIG_PROJECT_MODEL_NOT_FOUND',
        message: `Selected model must belong to this project: ${missingModelIds.join(', ')}`,
      };
    }
  }

  const tenantModelIds = [...new Set(collectTenantModelIds(parsed.data))];
  if (tenantModelIds.length > 0) {
    const foundTenantModelIds = await TenantModel.distinct('_id', {
      _id: { $in: tenantModelIds },
      tenantId,
      isActive: true,
      inferenceEnabled: { $ne: false },
    });
    if (foundTenantModelIds.length !== tenantModelIds.length) {
      return {
        valid: false,
        status: 400,
        code: 'RUNTIME_CONFIG_TENANT_MODEL_NOT_FOUND',
        message: 'Selected tenant model must belong to this tenant',
      };
    }
  }

  const promptRef = parsed.data.filler?.promptRef;
  if (promptRef) {
    const promptAvailable = await validatePromptRef({
      tenantId,
      projectId,
      promptId: promptRef.promptId,
      versionId: promptRef.versionId,
      importedPromptVersions,
    });
    if (!promptAvailable) {
      return {
        valid: false,
        status: 400,
        code: 'RUNTIME_CONFIG_PROMPT_VERSION_NOT_FOUND',
        message: 'Selected prompt version must belong to this project and be available',
      };
    }
  }

  return { valid: true, data: parsed.data };
}
