import { randomUUID } from 'node:crypto';
import { createLogger } from '@abl/compiler/platform/logger.js';
import mongoose from 'mongoose';
import { ImportOperation, Project, type IImportOperation } from '@agent-platform/database/models';
import { reconcileGuardrailPolicyUniqueIndexes } from '@agent-platform/database/mongo';
import { buildProjectAgentPath } from '@agent-platform/shared';
import { buildSearchAIBindingFromProps, parseDslProperties } from '@agent-platform/shared/tools';
import type {
  ImportConflictStrategyV2,
  ImportBindingResolutionInput,
  LayerName,
  ImportPreviewV2,
} from '@agent-platform/project-io';
import {
  ChannelsDisassembler,
  ConnectionsDisassembler,
  CoreDisassembler,
  EvalsDisassembler,
  GuardrailsDisassembler,
  PromptsDisassembler,
  SearchDisassembler,
  VocabularyDisassembler,
  WorkflowsDisassembler,
  enrichImportPreview,
  importProjectV2,
  IMPORT_LIFECYCLE_FIELD,
  StagedImporter,
  stripCommonPrefix,
  validatePreviewAcknowledgement,
  type CoreImportApplyCountsV2,
  type CrossRefDbAdapter,
  type ExistingProjectStateV2,
  type ImportDbAdapter,
  type ImportV2Deps,
  type LayerDisassembler,
} from '@agent-platform/project-io/import';
import { loadStudioCoreImportState } from './core-direct-apply-support';
import { createProjectRuntimeConfigSaveValidatorForFiles } from '../project-runtime-config-import-validation';
import { validateProjectToolBindingsForSave } from '../project-tool-binding-validation';

const log = createLogger('studio-layered-import-support');

interface StudioLayeredImportParams {
  projectId: string;
  tenantId: string;
  userId: string;
}

interface RawFindCursor {
  toArray(): Promise<Array<Record<string, unknown>>>;
}

interface RawCollection {
  find(filter: Record<string, unknown>, options?: Record<string, unknown>): RawFindCursor;
  insertMany(records: Array<Record<string, unknown>>): Promise<unknown>;
  deleteMany(filter: Record<string, unknown>): Promise<unknown>;
  updateMany(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<unknown>;
  bulkWrite(
    operations: Array<Record<string, unknown>>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
}

interface LayeredImportAdapterOptions {
  collectionProvider?: (collection: string) => RawCollection;
  idFactory?: () => string;
  now?: () => Date;
  operationId?: string;
  guardrailPolicyIndexRepair?: () => Promise<void>;
}

type StudioLayeredImportDeps = ImportV2Deps & {
  dbAdapter: ImportDbAdapter & CrossRefDbAdapter;
  crossRefDb: CrossRefDbAdapter;
};

type LayeredProjectToolType = 'http' | 'mcp' | 'sandbox' | 'searchai' | 'workflow';

const SHADOW_STAGING_SEGMENT = '__abl_import_staging__';
const SHADOW_SUPERSEDED_SEGMENT = '__abl_import_superseded__';
const ACTIVE_LIFECYCLE_FILTER = {
  $or: [
    { [`${IMPORT_LIFECYCLE_FIELD}.state`]: { $exists: false } },
    { [`${IMPORT_LIFECYCLE_FIELD}.state`]: { $nin: ['staged', 'superseded', 'deleted'] } },
  ],
};
const PORTABLE_UNIQUE_SCOPE_FIELDS: Record<string, string> = {
  connector_configs: 'sourceId',
  domain_vocabularies: 'projectKnowledgeBaseId',
  canonical_schemas: 'knowledgeBaseId',
  crawl_patterns: 'domain',
};
const STAGED_UNIQUE_VALUE_FIELDS: Record<string, string> = {
  crawl_patterns: 'domain',
};

const ACTIVE_RECORD_PROJECTIONS: Record<string, Record<string, number>> = {
  project_agents: { _id: 1, name: 1 },
  project_tools: { _id: 1, name: 1, slug: 1 },
  project_settings: {
    _id: 1,
    enableThinking: 1,
    thinkingBudget: 1,
    thoughtDescription: 1,
    promptOverrides: 1,
    compactionThreshold: 1,
    traceDimensions: 1,
    agentTransfer: 1,
    sessionLifecycle: 1,
    memory: 1,
    publicApiAccess: 1,
    sdkDefaults: 1,
  },
  project_runtime_configs: {},
  project_llm_configs: { _id: 1, operationTierOverrides: 1 },
  model_configs: {
    _id: 1,
    name: 1,
    modelId: 1,
    provider: 1,
    temperature: 1,
    maxTokens: 1,
    topP: 1,
    frequencyPenalty: 1,
    presencePenalty: 1,
    inputCostPer1k: 1,
    outputCostPer1k: 1,
    supportsTools: 1,
    supportsVision: 1,
    supportsStreaming: 1,
    useResponsesApi: 1,
    useStreaming: 1,
    contextWindow: 1,
    tier: 1,
    isDefault: 1,
    priority: 1,
  },
  agent_model_configs: {
    _id: 1,
    agentName: 1,
    defaultModel: 1,
    operationModels: 1,
    temperature: 1,
    maxTokens: 1,
    hyperParameters: 1,
    useResponsesApi: 1,
    useStreaming: 1,
  },
  environment_variables: { _id: 1, key: 1, environment: 1, isSecret: 1, description: 1 },
  project_config_variables: { _id: 1, key: 1, value: 1, description: 1 },
  mcp_server_configs: {
    _id: 1,
    name: 1,
    description: 1,
    transport: 1,
    url: 1,
    authType: 1,
    priority: 1,
    tags: 1,
    connectionTimeoutMs: 1,
    requestTimeoutMs: 1,
    autoReconnect: 1,
    maxReconnectAttempts: 1,
    lastConnectionStatus: 1,
  },
  prompt_library_items: { _id: 1, name: 1 },
  prompt_library_versions: { _id: 1, promptId: 1, versionNumber: 1 },
  connector_connections: { _id: 1, displayName: 1, connectorName: 1 },
  connector_configs: { _id: 1, connectorType: 1 },
  workflows: { _id: 1, name: 1 },
  workflow_versions: { _id: 1, workflowId: 1, version: 1 },
  trigger_registrations: { _id: 1, workflowId: 1, workflowVersionId: 1, triggerName: 1 },
  search_indexes: { _id: 1, slug: 1, name: 1 },
  search_sources: { _id: 1, name: 1, indexId: 1 },
  knowledge_bases: { _id: 1, name: 1, searchIndexId: 1 },
  crawl_patterns: { _id: 1, domain: 1 },
  guardrail_policies: { _id: 1, name: 1 },
  eval_sets: { _id: 1, name: 1 },
  eval_scenarios: { _id: 1, name: 1 },
  eval_personas: { _id: 1, name: 1 },
  eval_evaluators: { _id: 1, name: 1 },
  channel_connections: { _id: 1, displayName: 1 },
  webhook_subscriptions: { _id: 1, channelConnectionId: 1 },
  widget_configs: { _id: 1 },
  domain_vocabularies: { _id: 1, projectKnowledgeBaseId: 1 },
  lookup_entries: { _id: 1, tableName: 1, key: 1 },
  canonical_schemas: { _id: 1, knowledgeBaseId: 1 },
  facts: { _id: 1, scope: 1, key: 1 },
};

function getMongoCollection(collection: string): RawCollection {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('MongoDB connection is not ready');
  }
  return db.collection(collection) as unknown as RawCollection;
}

async function repairGuardrailPolicyIndexesForImport(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('MongoDB connection is not ready');
  }

  await reconcileGuardrailPolicyUniqueIndexes(db);
}

function stagingProjectId(projectId: string, operationId: string): string {
  return `${projectId}:${SHADOW_STAGING_SEGMENT}:${operationId}`;
}

function supersededProjectId(projectId: string, operationId: string): string {
  return `${projectId}:${SHADOW_SUPERSEDED_SEGMENT}:${operationId}`;
}

function shadowUniqueValue(value: string, segment: string, operationId: string): string {
  return `${value}:${segment}:${operationId}`;
}

function asStringId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isProjectScopedGuardrailPolicyScope(scope: unknown): scope is Record<string, unknown> {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    return false;
  }
  const type = (scope as Record<string, unknown>).type;
  return type === 'project' || type === 'agent';
}

function readProjectAgentName(record: Record<string, unknown>): string {
  const name = asStringId(record.name);
  if (!name) {
    throw new Error('Cannot materialize project agent import record without a name');
  }
  return name;
}

function hasRealtimeVoiceCapability(model: Record<string, unknown>): boolean {
  return Array.isArray(model.capabilities) && model.capabilities.includes('realtime_voice');
}

function buildDefaultDisassemblers(): Map<LayerName, LayerDisassembler> {
  return new Map<LayerName, LayerDisassembler>([
    ['connections', new ConnectionsDisassembler()],
    ['prompts', new PromptsDisassembler()],
    ['core', new CoreDisassembler()],
    ['search', new SearchDisassembler()],
    ['workflows', new WorkflowsDisassembler()],
    ['guardrails', new GuardrailsDisassembler()],
    ['evals', new EvalsDisassembler()],
    ['channels', new ChannelsDisassembler()],
    ['vocabulary', new VocabularyDisassembler()],
  ]);
}

export function createStudioLayeredImportDbAdapter(
  params: Pick<StudioLayeredImportParams, 'projectId' | 'tenantId'>,
  options: LayeredImportAdapterOptions = {},
): ImportDbAdapter & CrossRefDbAdapter {
  const collectionProvider = options.collectionProvider ?? getMongoCollection;
  const idFactory = options.idFactory ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const guardrailPolicyIndexRepair =
    options.guardrailPolicyIndexRepair ?? repairGuardrailPolicyIndexesForImport;
  const idRemap = new Map<string, string>();
  const workflowIdByName = new Map<string, string>();
  const workflowVersionIdByWorkflowAndVersion = new Map<string, string>();
  const knowledgeBaseIdByExportedId = new Map<string, string>();
  const knowledgeBaseIdByName = new Map<string, string>();
  const searchSourceIdByExportedId = new Map<string, string>();
  let currentOperationId: string | null = options.operationId ?? null;

  function collection(name: string): RawCollection {
    return collectionProvider(name);
  }

  function operationIdForRecords(records: Array<Record<string, unknown>>): string {
    for (const record of records) {
      const lifecycle = record[IMPORT_LIFECYCLE_FIELD];
      if (lifecycle && typeof lifecycle === 'object') {
        const operationId = asStringId((lifecycle as Record<string, unknown>).operationId);
        if (operationId) {
          currentOperationId = operationId;
          return operationId;
        }
      }
    }
    if (currentOperationId) {
      return currentOperationId;
    }
    throw new Error('Cannot stage records without import operation metadata');
  }

  function remapReference(value: unknown): unknown {
    const id = asStringId(value);
    return id ? (idRemap.get(id) ?? id) : value;
  }

  function workflowVersionKey(workflowRef: string, version: string): string {
    return `${workflowRef}::${version}`;
  }

  function remappedStringReference(value: unknown): string | null {
    return asStringId(remapReference(value));
  }

  function rememberExportedId(record: Record<string, unknown>, nextId: string): string | null {
    const exportedId = asStringId(record._exportedId);
    if (exportedId) {
      idRemap.set(exportedId, nextId);
    }
    return exportedId;
  }

  function resolveKnowledgeBaseIdForRecord(record: Record<string, unknown>): string | null {
    const tempId =
      asStringId(record._vocabularyKnowledgeBaseId) ?? asStringId(record._schemaKnowledgeBaseId);
    if (tempId) {
      return knowledgeBaseIdByExportedId.get(tempId) ?? null;
    }

    const directId = remappedStringReference(
      record.projectKnowledgeBaseId ?? record.knowledgeBaseId,
    );
    if (directId && knowledgeBaseIdByExportedId.has(directId)) {
      return knowledgeBaseIdByExportedId.get(directId) ?? null;
    }
    if (directId && [...knowledgeBaseIdByExportedId.values()].includes(directId)) {
      return directId;
    }

    const name = asStringId(record.knowledgeBaseName) ?? asStringId(record.name);
    return name ? (knowledgeBaseIdByName.get(name) ?? null) : null;
  }

  function resolveSearchSourceIdForRecord(record: Record<string, unknown>): string | null {
    const tempId = asStringId(record._connectorConfigSourceId);
    if (tempId) {
      return searchSourceIdByExportedId.get(tempId) ?? null;
    }

    const sourceId = remappedStringReference(record.sourceId);
    if (sourceId && searchSourceIdByExportedId.has(sourceId)) {
      return searchSourceIdByExportedId.get(sourceId) ?? null;
    }
    if (sourceId && [...searchSourceIdByExportedId.values()].includes(sourceId)) {
      return sourceId;
    }
    return null;
  }

  function resolveWorkflowIdForRecord(record: Record<string, unknown>): string | null {
    const workflowId = remappedStringReference(record.workflowId);
    if (workflowId) {
      return workflowId;
    }

    const workflowName = asStringId(record._workflowName);
    return workflowName ? (workflowIdByName.get(workflowName) ?? null) : null;
  }

  function resolveWorkflowVersionIdForRecord(record: Record<string, unknown>): string | null {
    const workflowVersionId = remappedStringReference(record.workflowVersionId);
    if (workflowVersionId) {
      return workflowVersionId;
    }

    const workflowVersion = asStringId(record._workflowVersion);
    if (!workflowVersion) {
      return null;
    }

    const workflowName = asStringId(record._workflowName);
    if (workflowName) {
      const byName = workflowVersionIdByWorkflowAndVersion.get(
        workflowVersionKey(workflowName, workflowVersion),
      );
      if (byName) {
        return byName;
      }
    }

    const workflowId = resolveWorkflowIdForRecord(record);
    return workflowId
      ? (workflowVersionIdByWorkflowAndVersion.get(
          workflowVersionKey(workflowId, workflowVersion),
        ) ?? null)
      : null;
  }

  async function resolveDestinationTenantModelIdForProjectModel(
    record: Record<string, unknown>,
  ): Promise<string | null> {
    const provider = typeof record.provider === 'string' ? record.provider.trim() : '';
    const modelId = typeof record.modelId === 'string' ? record.modelId.trim() : '';

    if (!provider || !modelId) {
      return null;
    }

    const { TenantModel } = await import('@agent-platform/database/models');
    const candidates = (await TenantModel.find({
      tenantId: params.tenantId,
      provider,
      modelId,
      isActive: true,
      inferenceEnabled: { $ne: false },
    }).lean()) as Array<Record<string, unknown>>;

    const usable =
      record.tier === 'voice' ? candidates.filter(hasRealtimeVoiceCapability) : candidates;
    if (usable.length !== 1) {
      return null;
    }

    return asStringId(usable[0]._id) ?? asStringId(usable[0].id);
  }

  async function materializeStagedRecord(
    collectionName: string,
    operationId: string,
    record: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const originalId = asStringId(record._id);
    const nextId = idFactory();
    if (originalId) {
      idRemap.set(originalId, nextId);
    }
    rememberExportedId(record, nextId);

    const materialized: Record<string, unknown> = {
      ...record,
      _id: nextId,
      tenantId: params.tenantId,
      projectId: stagingProjectId(params.projectId, operationId),
      createdAt: record.createdAt ?? now(),
      updatedAt: now(),
    };

    if (collectionName === 'prompt_library_versions') {
      materialized.promptId = remapReference(record.promptId);
    }
    if (collectionName === 'project_agents') {
      const promptRef = record.systemPromptLibraryRef;
      if (promptRef && typeof promptRef === 'object') {
        const ref = promptRef as Record<string, unknown>;
        materialized.systemPromptLibraryRef = {
          ...ref,
          promptId: remapReference(ref.promptId),
          versionId: remapReference(ref.versionId),
        };
      }
    }

    if (collectionName === 'project_agents') {
      materialized.agentPath = buildProjectAgentPath(
        String(materialized.projectId),
        readProjectAgentName(materialized),
      );
    }

    if (collectionName === 'workflows') {
      const workflowName = asStringId(materialized.name);
      if (workflowName) {
        workflowIdByName.set(workflowName, nextId);
      }
    }

    if (collectionName === 'search_sources') {
      const exportedSourceId = asStringId(record._exportedId);
      if (exportedSourceId) {
        searchSourceIdByExportedId.set(exportedSourceId, nextId);
      }
    }

    if (collectionName === 'knowledge_bases') {
      const exportedKnowledgeBaseId = asStringId(record._exportedId);
      if (exportedKnowledgeBaseId) {
        knowledgeBaseIdByExportedId.set(exportedKnowledgeBaseId, nextId);
      }
      const knowledgeBaseName = asStringId(materialized.name);
      if (knowledgeBaseName) {
        knowledgeBaseIdByName.set(knowledgeBaseName, nextId);
      }
    }

    if (collectionName === 'domain_vocabularies') {
      const knowledgeBaseId = resolveKnowledgeBaseIdForRecord(record);
      if (!knowledgeBaseId) {
        throw new Error('Cannot stage domain vocabulary because its knowledge base was not staged');
      }
      materialized.projectKnowledgeBaseId = knowledgeBaseId;
    }

    if (collectionName === 'canonical_schemas') {
      const knowledgeBaseId = resolveKnowledgeBaseIdForRecord(record);
      if (!knowledgeBaseId) {
        throw new Error('Cannot stage canonical schema because its knowledge base was not staged');
      }
      materialized.knowledgeBaseId = knowledgeBaseId;
    }

    if (collectionName === 'connector_configs') {
      const sourceId = resolveSearchSourceIdForRecord(record);
      if (!sourceId) {
        throw new Error('Cannot stage connector config because its search source was not staged');
      }
      materialized.sourceId = sourceId;
    }

    if (collectionName === 'model_configs') {
      materialized.tenantModelId = await resolveDestinationTenantModelIdForProjectModel(record);
    }

    if (collectionName === 'channel_connections' && materialized.status === 'active') {
      const lifecycle = materialized[IMPORT_LIFECYCLE_FIELD];
      if (lifecycle && typeof lifecycle === 'object') {
        materialized[IMPORT_LIFECYCLE_FIELD] = {
          ...(lifecycle as Record<string, unknown>),
          originalStatus: 'active',
        };
      }
      materialized.status = 'inactive';
    }

    if (collectionName === 'guardrail_policies') {
      const originalName = asStringId(materialized.name);
      if (originalName) {
        const stagedProjectId = stagingProjectId(params.projectId, operationId);
        const lifecycle =
          materialized[IMPORT_LIFECYCLE_FIELD] &&
          typeof materialized[IMPORT_LIFECYCLE_FIELD] === 'object'
            ? (materialized[IMPORT_LIFECYCLE_FIELD] as Record<string, unknown>)
            : {};
        materialized[IMPORT_LIFECYCLE_FIELD] = {
          ...lifecycle,
          originalName,
        };
        materialized.name = shadowUniqueValue(originalName, SHADOW_STAGING_SEGMENT, operationId);

        if (isProjectScopedGuardrailPolicyScope(materialized.scope)) {
          materialized.scope = {
            ...materialized.scope,
            projectId: stagedProjectId,
          };
        }
      }
    }

    const stagedUniqueField = STAGED_UNIQUE_VALUE_FIELDS[collectionName];
    if (stagedUniqueField) {
      const originalScopeValue = asStringId(materialized[stagedUniqueField]);
      if (originalScopeValue) {
        const lifecycle =
          materialized[IMPORT_LIFECYCLE_FIELD] &&
          typeof materialized[IMPORT_LIFECYCLE_FIELD] === 'object'
            ? (materialized[IMPORT_LIFECYCLE_FIELD] as Record<string, unknown>)
            : {};
        materialized[IMPORT_LIFECYCLE_FIELD] = {
          ...lifecycle,
          originalScopeField: stagedUniqueField,
          originalScopeValue,
        };
        materialized[stagedUniqueField] = shadowUniqueValue(
          originalScopeValue,
          SHADOW_STAGING_SEGMENT,
          operationId,
        );
      }
    }

    if (collectionName === 'workflow_versions') {
      const workflowId = resolveWorkflowIdForRecord(record);
      if (!workflowId) {
        const workflowName = asStringId(record._workflowName) ?? 'unknown';
        const version = asStringId(record.version) ?? 'unknown';
        throw new Error(
          `Cannot stage workflow version "${version}" because workflow "${workflowName}" was not staged`,
        );
      }

      materialized.workflowId = workflowId;

      const version = asStringId(materialized.version);
      const workflowName = asStringId(record._workflowName);
      if (version) {
        workflowVersionIdByWorkflowAndVersion.set(workflowVersionKey(workflowId, version), nextId);
        if (workflowName) {
          workflowVersionIdByWorkflowAndVersion.set(
            workflowVersionKey(workflowName, version),
            nextId,
          );
        }
      }
    }

    if (collectionName === 'trigger_registrations') {
      const workflowId = resolveWorkflowIdForRecord(record);
      if (workflowId) {
        materialized.workflowId = workflowId;
      }

      const workflowVersionId = resolveWorkflowVersionIdForRecord(record);
      if (workflowVersionId) {
        materialized.workflowVersionId = workflowVersionId;
      }
    }

    return materialized;
  }

  async function buildProjectAgentProjectSwapOperations(input: {
    ids: string[];
    fromProjectId: string;
    toProjectId: string;
    filter?: Record<string, unknown>;
    setLifecycle?: Record<string, unknown>;
    unsetLifecycle?: boolean;
  }): Promise<Array<Record<string, unknown>>> {
    if (input.ids.length === 0) {
      return [];
    }

    const records = await collection('project_agents')
      .find(
        {
          _id: { $in: input.ids },
          tenantId: params.tenantId,
          projectId: input.fromProjectId,
        },
        { projection: { _id: 1, name: 1 } },
      )
      .toArray();

    const recordsById = new Map(records.map((record) => [String(record._id), record]));

    return input.ids.map((id) => {
      const record = recordsById.get(id);
      if (!record) {
        throw new Error(`Cannot activate project agent import record ${id}: record not found`);
      }

      const setUpdate: Record<string, unknown> = {
        projectId: input.toProjectId,
        agentPath: buildProjectAgentPath(input.toProjectId, readProjectAgentName(record)),
        updatedAt: now(),
      };

      if (input.setLifecycle) {
        setUpdate[IMPORT_LIFECYCLE_FIELD] = input.setLifecycle;
      }

      const update: Record<string, unknown> = { $set: setUpdate };
      if (input.unsetLifecycle) {
        update.$unset = { [IMPORT_LIFECYCLE_FIELD]: 1 };
      }

      return {
        updateOne: {
          filter: {
            _id: id,
            tenantId: params.tenantId,
            projectId: input.fromProjectId,
            ...(input.filter ?? {}),
          },
          update,
        },
      };
    });
  }

  async function buildChannelConnectionProjectSwapOperations(input: {
    ids: string[];
    fromProjectId: string;
    toProjectId: string;
    filter?: Record<string, unknown>;
    mode: 'activate' | 'supersede' | 'restore';
  }): Promise<Array<Record<string, unknown>>> {
    if (input.ids.length === 0) {
      return [];
    }

    const records = await collection('channel_connections')
      .find(
        {
          _id: { $in: input.ids },
          tenantId: params.tenantId,
          projectId: input.fromProjectId,
        },
        { projection: { _id: 1, status: 1, [IMPORT_LIFECYCLE_FIELD]: 1 } },
      )
      .toArray();
    const recordsById = new Map(records.map((record) => [String(record._id), record]));

    return input.ids.map((id) => {
      const record = recordsById.get(id);
      if (!record) {
        throw new Error(`Cannot ${input.mode} channel import record ${id}: record not found`);
      }

      const lifecycle =
        record[IMPORT_LIFECYCLE_FIELD] && typeof record[IMPORT_LIFECYCLE_FIELD] === 'object'
          ? (record[IMPORT_LIFECYCLE_FIELD] as Record<string, unknown>)
          : {};
      const originalStatus = asStringId(lifecycle.originalStatus) ?? asStringId(record.status);
      const setUpdate: Record<string, unknown> = {
        projectId: input.toProjectId,
        updatedAt: now(),
      };
      const unsetUpdate: Record<string, number> = {};

      if (input.mode === 'activate') {
        setUpdate.status = 'inactive';
        unsetUpdate[IMPORT_LIFECYCLE_FIELD] = 1;
      } else if (input.mode === 'supersede') {
        setUpdate.status = 'inactive';
        setUpdate[IMPORT_LIFECYCLE_FIELD] = {
          operationId: currentOperationId,
          state: 'superseded',
          supersededAt: now().toISOString(),
          ...(originalStatus ? { originalStatus } : {}),
        };
      } else if (input.mode === 'restore') {
        if (originalStatus) {
          setUpdate.status = originalStatus;
        }
        unsetUpdate[IMPORT_LIFECYCLE_FIELD] = 1;
      }

      const update: Record<string, unknown> = { $set: setUpdate };
      if (Object.keys(unsetUpdate).length > 0) {
        update.$unset = unsetUpdate;
      }

      return {
        updateOne: {
          filter: {
            _id: id,
            tenantId: params.tenantId,
            projectId: input.fromProjectId,
            ...(input.filter ?? {}),
          },
          update,
        },
      };
    });
  }

  async function buildPortableUniqueScopeSwapOperations(input: {
    collectionName: string;
    ids: string[];
    toProjectId: string;
    mode: 'supersede' | 'restore';
  }): Promise<Array<Record<string, unknown>>> {
    if (input.ids.length === 0) {
      return [];
    }

    const scopeField = PORTABLE_UNIQUE_SCOPE_FIELDS[input.collectionName];
    if (!scopeField) {
      return [];
    }

    const records = await collection(input.collectionName)
      .find(
        {
          _id: { $in: input.ids },
          tenantId: params.tenantId,
        },
        { projection: { _id: 1, [scopeField]: 1, [IMPORT_LIFECYCLE_FIELD]: 1 } },
      )
      .toArray();
    const recordsById = new Map(records.map((record) => [String(record._id), record]));

    return input.ids.map((id) => {
      const record = recordsById.get(id);
      if (!record) {
        throw new Error(
          `Cannot ${input.mode} ${input.collectionName} import record ${id}: record not found`,
        );
      }

      const lifecycle =
        record[IMPORT_LIFECYCLE_FIELD] && typeof record[IMPORT_LIFECYCLE_FIELD] === 'object'
          ? (record[IMPORT_LIFECYCLE_FIELD] as Record<string, unknown>)
          : {};
      const originalScopeValue =
        asStringId(lifecycle.originalScopeValue) ?? asStringId(record[scopeField]);
      if (!originalScopeValue) {
        throw new Error(
          `Cannot ${input.mode} ${input.collectionName} import record ${id}: ${scopeField} is missing`,
        );
      }

      const setUpdate: Record<string, unknown> = {
        projectId: input.toProjectId,
        updatedAt: now(),
      };
      const unsetUpdate: Record<string, number> = {};

      if (input.mode === 'supersede') {
        setUpdate[scopeField] =
          `${originalScopeValue}:${SHADOW_SUPERSEDED_SEGMENT}:${currentOperationId}`;
        setUpdate[IMPORT_LIFECYCLE_FIELD] = {
          operationId: currentOperationId,
          state: 'superseded',
          supersededAt: now().toISOString(),
          originalScopeField: scopeField,
          originalScopeValue,
        };
      } else {
        setUpdate[scopeField] = originalScopeValue;
        unsetUpdate[IMPORT_LIFECYCLE_FIELD] = 1;
      }

      const update: Record<string, unknown> = { $set: setUpdate };
      if (Object.keys(unsetUpdate).length > 0) {
        update.$unset = unsetUpdate;
      }

      return {
        updateOne: {
          filter: {
            _id: id,
            tenantId: params.tenantId,
          },
          update,
        },
      };
    });
  }

  async function buildStagedUniqueValueActivationOperations(input: {
    collectionName: string;
    ids: string[];
    fromProjectId: string;
    toProjectId: string;
    filter?: Record<string, unknown>;
  }): Promise<Array<Record<string, unknown>>> {
    if (input.ids.length === 0) {
      return [];
    }

    const scopeField = STAGED_UNIQUE_VALUE_FIELDS[input.collectionName];
    if (!scopeField) {
      return [];
    }

    const records = await collection(input.collectionName)
      .find(
        {
          _id: { $in: input.ids },
          tenantId: params.tenantId,
          projectId: input.fromProjectId,
        },
        { projection: { _id: 1, [scopeField]: 1, [IMPORT_LIFECYCLE_FIELD]: 1 } },
      )
      .toArray();
    const recordsById = new Map(records.map((record) => [String(record._id), record]));

    return input.ids.map((id) => {
      const record = recordsById.get(id);
      if (!record) {
        throw new Error(
          `Cannot activate ${input.collectionName} import record ${id}: record not found`,
        );
      }

      const lifecycle =
        record[IMPORT_LIFECYCLE_FIELD] && typeof record[IMPORT_LIFECYCLE_FIELD] === 'object'
          ? (record[IMPORT_LIFECYCLE_FIELD] as Record<string, unknown>)
          : {};
      const originalScopeValue =
        asStringId(lifecycle.originalScopeValue) ?? asStringId(record[scopeField]);
      if (!originalScopeValue) {
        throw new Error(
          `Cannot activate ${input.collectionName} import record ${id}: ${scopeField} is missing`,
        );
      }

      return {
        updateOne: {
          filter: {
            _id: id,
            tenantId: params.tenantId,
            projectId: input.fromProjectId,
            ...(input.filter ?? {}),
          },
          update: {
            $set: {
              projectId: input.toProjectId,
              updatedAt: now(),
              [scopeField]: originalScopeValue,
            },
            $unset: { [IMPORT_LIFECYCLE_FIELD]: 1 },
          },
        },
      };
    });
  }

  async function buildGuardrailPolicyNameSwapOperations(input: {
    ids: string[];
    fromProjectId: string;
    toProjectId: string;
    filter?: Record<string, unknown>;
    mode: 'activate' | 'supersede' | 'restore';
  }): Promise<Array<Record<string, unknown>>> {
    if (input.ids.length === 0) {
      return [];
    }
    const operationId = currentOperationId;
    if (!operationId) {
      throw new Error(`Cannot ${input.mode} guardrail import records without an operation id`);
    }

    const records = await collection('guardrail_policies')
      .find(
        {
          _id: { $in: input.ids },
          tenantId: params.tenantId,
          $or: [{ projectId: input.fromProjectId }, { 'scope.projectId': input.fromProjectId }],
        },
        { projection: { _id: 1, name: 1, scope: 1, [IMPORT_LIFECYCLE_FIELD]: 1 } },
      )
      .toArray();
    const recordsById = new Map(records.map((record) => [String(record._id), record]));

    return input.ids.map((id) => {
      const record = recordsById.get(id);
      if (!record) {
        throw new Error(`Cannot ${input.mode} guardrail import record ${id}: record not found`);
      }

      const lifecycle =
        record[IMPORT_LIFECYCLE_FIELD] && typeof record[IMPORT_LIFECYCLE_FIELD] === 'object'
          ? (record[IMPORT_LIFECYCLE_FIELD] as Record<string, unknown>)
          : {};
      const originalName = asStringId(lifecycle.originalName) ?? asStringId(record.name);
      if (!originalName) {
        throw new Error(`Cannot ${input.mode} guardrail import record ${id}: name is missing`);
      }

      const setUpdate: Record<string, unknown> = {
        projectId: input.toProjectId,
        updatedAt: now(),
      };
      const unsetUpdate: Record<string, number> = {};
      if (isProjectScopedGuardrailPolicyScope(record.scope)) {
        setUpdate['scope.projectId'] = input.toProjectId;
      }

      if (input.mode === 'supersede') {
        setUpdate.name = shadowUniqueValue(originalName, SHADOW_SUPERSEDED_SEGMENT, operationId);
        setUpdate[IMPORT_LIFECYCLE_FIELD] = {
          operationId,
          state: 'superseded',
          supersededAt: now().toISOString(),
          originalName,
        };
      } else {
        setUpdate.name = originalName;
        unsetUpdate[IMPORT_LIFECYCLE_FIELD] = 1;
      }

      const update: Record<string, unknown> = { $set: setUpdate };
      if (Object.keys(unsetUpdate).length > 0) {
        update.$unset = unsetUpdate;
      }

      return {
        updateOne: {
          filter: {
            _id: id,
            tenantId: params.tenantId,
            $or: [{ projectId: input.fromProjectId }, { 'scope.projectId': input.fromProjectId }],
            ...(input.filter ?? {}),
          },
          update,
        },
      };
    });
  }

  return {
    createImportOperation: async (operation) => {
      const created = await ImportOperation.create({
        projectId: params.projectId,
        tenantId: params.tenantId,
        status: 'validating',
        layers: operation.layers,
        expiresAt: operation.expiresAt,
      });
      currentOperationId = String(created._id);
      return { _id: currentOperationId };
    },
    updateImportOperation: async (operationId, projectId, tenantId, update) => {
      await ImportOperation.updateOne({ _id: operationId, projectId, tenantId }, { $set: update });
    },
    insertStagedRecords: async (collectionName, records) => {
      if (records.length === 0) {
        return [];
      }
      const operationId = operationIdForRecords(records);
      const docs: Array<Record<string, unknown>> = [];
      for (const record of records) {
        docs.push(await materializeStagedRecord(collectionName, operationId, record));
      }
      await collection(collectionName).insertMany(docs);
      return docs.map((doc) => String(doc._id));
    },
    deleteRecordsByIds: async (collectionName, ids) => {
      if (ids.length === 0) {
        return;
      }
      const operationId = currentOperationId;
      if (!operationId) {
        throw new Error('Cannot delete import records without an import operation id');
      }

      await collection(collectionName).deleteMany({
        _id: { $in: ids },
        tenantId: params.tenantId,
        projectId: stagingProjectId(params.projectId, operationId),
      });
      await collection(collectionName).updateMany(
        {
          _id: { $in: ids },
          tenantId: params.tenantId,
          projectId: supersededProjectId(params.projectId, operationId),
        },
        {
          $set: {
            updatedAt: now(),
            [IMPORT_LIFECYCLE_FIELD]: {
              operationId,
              state: 'deleted',
              deletedAt: now().toISOString(),
            },
          },
        },
      );
    },
    activateLayer: async (collectionName, stagedIds, supersededIds) => {
      const operationId = currentOperationId;
      if (!operationId) {
        throw new Error('Cannot activate layer before import operation is created');
      }
      if (collectionName === 'guardrail_policies') {
        await guardrailPolicyIndexRepair();
      }
      const operations: Array<Record<string, unknown>> = [];
      const stagedProjectId = stagingProjectId(params.projectId, operationId);
      const supersededProjectIdValue = supersededProjectId(params.projectId, operationId);
      if (supersededIds.length > 0) {
        if (collectionName === 'project_agents') {
          operations.push(
            ...(await buildProjectAgentProjectSwapOperations({
              ids: supersededIds,
              fromProjectId: params.projectId,
              toProjectId: supersededProjectIdValue,
              setLifecycle: {
                operationId,
                state: 'superseded',
                supersededAt: now().toISOString(),
              },
            })),
          );
        } else if (collectionName === 'channel_connections') {
          operations.push(
            ...(await buildChannelConnectionProjectSwapOperations({
              ids: supersededIds,
              fromProjectId: params.projectId,
              toProjectId: supersededProjectIdValue,
              mode: 'supersede',
            })),
          );
        } else if (collectionName === 'guardrail_policies') {
          operations.push(
            ...(await buildGuardrailPolicyNameSwapOperations({
              ids: supersededIds,
              fromProjectId: params.projectId,
              toProjectId: supersededProjectIdValue,
              mode: 'supersede',
            })),
          );
        } else if (PORTABLE_UNIQUE_SCOPE_FIELDS[collectionName]) {
          operations.push(
            ...(await buildPortableUniqueScopeSwapOperations({
              collectionName,
              ids: supersededIds,
              toProjectId: supersededProjectIdValue,
              mode: 'supersede',
            })),
          );
        } else {
          operations.push({
            updateMany: {
              filter: {
                _id: { $in: supersededIds },
                tenantId: params.tenantId,
                projectId: params.projectId,
              },
              update: {
                $set: {
                  projectId: supersededProjectIdValue,
                  updatedAt: now(),
                  [IMPORT_LIFECYCLE_FIELD]: {
                    operationId,
                    state: 'superseded',
                    supersededAt: now().toISOString(),
                  },
                },
              },
            },
          });
        }
      }
      if (stagedIds.length > 0) {
        if (collectionName === 'project_agents') {
          operations.push(
            ...(await buildProjectAgentProjectSwapOperations({
              ids: stagedIds,
              fromProjectId: stagedProjectId,
              toProjectId: params.projectId,
              filter: { [`${IMPORT_LIFECYCLE_FIELD}.state`]: 'staged' },
              unsetLifecycle: true,
            })),
          );
        } else if (collectionName === 'channel_connections') {
          operations.push(
            ...(await buildChannelConnectionProjectSwapOperations({
              ids: stagedIds,
              fromProjectId: stagedProjectId,
              toProjectId: params.projectId,
              filter: { [`${IMPORT_LIFECYCLE_FIELD}.state`]: 'staged' },
              mode: 'activate',
            })),
          );
        } else if (collectionName === 'guardrail_policies') {
          operations.push(
            ...(await buildGuardrailPolicyNameSwapOperations({
              ids: stagedIds,
              fromProjectId: stagedProjectId,
              toProjectId: params.projectId,
              filter: { [`${IMPORT_LIFECYCLE_FIELD}.state`]: 'staged' },
              mode: 'activate',
            })),
          );
        } else if (STAGED_UNIQUE_VALUE_FIELDS[collectionName]) {
          operations.push(
            ...(await buildStagedUniqueValueActivationOperations({
              collectionName,
              ids: stagedIds,
              fromProjectId: stagedProjectId,
              toProjectId: params.projectId,
              filter: { [`${IMPORT_LIFECYCLE_FIELD}.state`]: 'staged' },
            })),
          );
        } else {
          operations.push({
            updateMany: {
              filter: {
                _id: { $in: stagedIds },
                tenantId: params.tenantId,
                projectId: stagedProjectId,
                [`${IMPORT_LIFECYCLE_FIELD}.state`]: 'staged',
              },
              update: {
                $set: {
                  projectId: params.projectId,
                  updatedAt: now(),
                },
                $unset: { [IMPORT_LIFECYCLE_FIELD]: 1 },
              },
            },
          });
        }
      }
      if (operations.length > 0) {
        await collection(collectionName).bulkWrite(operations, { ordered: true });
      }
    },
    rollbackLayer: async (collectionName, stagedIds, supersededIds) => {
      const operationId = currentOperationId;
      if (!operationId) {
        throw new Error('Cannot roll back layer before import operation is created');
      }
      if (stagedIds.length > 0) {
        await collection(collectionName).deleteMany({
          _id: { $in: stagedIds },
          tenantId: params.tenantId,
          projectId: {
            $in: [params.projectId, stagingProjectId(params.projectId, operationId)],
          },
        });
      }
      if (supersededIds.length > 0) {
        if (collectionName === 'project_agents') {
          await collection(collectionName).bulkWrite(
            await buildProjectAgentProjectSwapOperations({
              ids: supersededIds,
              fromProjectId: supersededProjectId(params.projectId, operationId),
              toProjectId: params.projectId,
              unsetLifecycle: true,
            }),
            { ordered: true },
          );
        } else if (collectionName === 'channel_connections') {
          await collection(collectionName).bulkWrite(
            await buildChannelConnectionProjectSwapOperations({
              ids: supersededIds,
              fromProjectId: supersededProjectId(params.projectId, operationId),
              toProjectId: params.projectId,
              mode: 'restore',
            }),
            { ordered: true },
          );
        } else if (collectionName === 'guardrail_policies') {
          await collection(collectionName).bulkWrite(
            await buildGuardrailPolicyNameSwapOperations({
              ids: supersededIds,
              fromProjectId: supersededProjectId(params.projectId, operationId),
              toProjectId: params.projectId,
              mode: 'restore',
            }),
            { ordered: true },
          );
        } else if (PORTABLE_UNIQUE_SCOPE_FIELDS[collectionName]) {
          await collection(collectionName).bulkWrite(
            await buildPortableUniqueScopeSwapOperations({
              collectionName,
              ids: supersededIds,
              toProjectId: params.projectId,
              mode: 'restore',
            }),
            { ordered: true },
          );
        } else {
          await collection(collectionName).updateMany(
            {
              _id: { $in: supersededIds },
              tenantId: params.tenantId,
              projectId: supersededProjectId(params.projectId, operationId),
            },
            {
              $set: {
                projectId: params.projectId,
                updatedAt: now(),
              },
              $unset: { [IMPORT_LIFECYCLE_FIELD]: 1 },
            },
          );
        }
      }
    },
    findActiveRecordIds: async (collectionName, projectId, tenantId, matchField, matchValues) => {
      if (matchValues.length === 0) {
        return [];
      }
      const activeProjectScopeFilter =
        collectionName === 'guardrail_policies'
          ? {
              $and: [
                ACTIVE_LIFECYCLE_FILTER,
                {
                  $or: [
                    { projectId },
                    { 'scope.type': 'project', 'scope.projectId': projectId },
                    { 'scope.type': 'agent', 'scope.projectId': projectId },
                  ],
                },
              ],
            }
          : {
              projectId,
              ...ACTIVE_LIFECYCLE_FILTER,
            };
      const records = await collection(collectionName)
        .find(
          {
            tenantId,
            [matchField]: { $in: matchValues },
            ...activeProjectScopeFilter,
          },
          { projection: { _id: 1, [matchField]: 1 } },
        )
        .toArray();
      return records.map((record) => ({
        _id: String(record._id),
        [matchField]: record[matchField],
      }));
    },
    queryStagedRecords: async (collectionName, filter, projection) => {
      return collection(collectionName).find(filter, { projection }).toArray();
    },
    batchUpdateStagedRecords: async (collectionName, operations) => {
      if (operations.length === 0) {
        return;
      }
      await collection(collectionName).bulkWrite(
        operations.map((operation) => ({
          updateOne: {
            filter: {
              ...operation.filter,
              tenantId: params.tenantId,
            },
            update: operation.update,
          },
        })),
        { ordered: false },
      );
    },
  };
}

type StudioLayeredImportRevertResult =
  | {
      success: true;
      operationId: string;
      applied: CoreImportApplyCountsV2;
    }
  | {
      success: false;
      status: number;
      error: {
        code:
          | 'OPERATION_NOT_FOUND'
          | 'OPERATION_NOT_LAYERED'
          | 'OPERATION_NOT_REVERSIBLE'
          | 'LAYERED_REVERT_FAILED';
        message: string;
      };
    };

const MODEL_POLICY_COLLECTIONS = new Set([
  'project_runtime_configs',
  'project_llm_configs',
  'model_configs',
  'agent_model_configs',
]);

function totalIds(recordIds: Record<string, string[]> | undefined): number {
  return Object.values(recordIds ?? {}).reduce((sum, ids) => sum + ids.length, 0);
}

function idsForCollection(
  recordIds: Record<string, string[]> | undefined,
  collectionName: string,
): number {
  return recordIds?.[collectionName]?.length ?? 0;
}

function countModelPolicyRollbackMutations(
  stagedRecordIds: Record<string, string[]> | undefined,
  supersededRecordIds: Record<string, string[]> | undefined,
): number {
  let count = 0;
  for (const collectionName of MODEL_POLICY_COLLECTIONS) {
    count += idsForCollection(stagedRecordIds, collectionName);
    count += idsForCollection(supersededRecordIds, collectionName);
  }
  return count;
}

function buildLayeredRevertCounts(
  operation: Pick<IImportOperation, 'stagedRecordIds' | 'supersededRecordIds'>,
): CoreImportApplyCountsV2 {
  return {
    created: 0,
    updated: totalIds(operation.supersededRecordIds),
    deleted: totalIds(operation.stagedRecordIds),
    toolsCreated: 0,
    toolsUpdated: idsForCollection(operation.supersededRecordIds, 'project_tools'),
    toolsDeleted: idsForCollection(operation.stagedRecordIds, 'project_tools'),
    localesCreated: 0,
    localesUpdated: idsForCollection(operation.supersededRecordIds, 'project_config_variables'),
    localesDeleted: idsForCollection(operation.stagedRecordIds, 'project_config_variables'),
    profilesCreated: 0,
    profilesUpdated: idsForCollection(operation.supersededRecordIds, 'behavior_profiles'),
    profilesDeleted: idsForCollection(operation.stagedRecordIds, 'behavior_profiles'),
    modelPoliciesUpserted: countModelPolicyRollbackMutations(
      operation.stagedRecordIds,
      operation.supersededRecordIds,
    ),
    modelPoliciesDeleted: 0,
  };
}

function hasLayeredRecordIds(
  operation: Pick<IImportOperation, 'stagedRecordIds' | 'supersededRecordIds'>,
): boolean {
  return totalIds(operation.stagedRecordIds) + totalIds(operation.supersededRecordIds) > 0;
}

function activatedLayersForRollback(operation: Pick<IImportOperation, 'layers'>): string[] {
  return Object.entries(operation.layers ?? {})
    .filter(([, layer]) => layer.status === 'activated')
    .map(([layer]) => layer);
}

export async function revertStudioLayeredImportOperation(input: {
  projectId: string;
  tenantId: string;
  operationId: string;
  collectionProvider?: (collection: string) => RawCollection;
  now?: () => Date;
}): Promise<StudioLayeredImportRevertResult> {
  const operation = (await ImportOperation.findOne({
    _id: input.operationId,
    projectId: input.projectId,
    tenantId: input.tenantId,
  }).lean()) as IImportOperation | null;

  if (!operation) {
    return {
      success: false,
      status: 404,
      error: {
        code: 'OPERATION_NOT_FOUND',
        message: 'Import operation not found',
      },
    };
  }

  if (!hasLayeredRecordIds(operation)) {
    return {
      success: false,
      status: 400,
      error: {
        code: 'OPERATION_NOT_LAYERED',
        message: 'Import operation has no layered records to revert',
      },
    };
  }

  if (operation.status === 'reverted') {
    return {
      success: true,
      operationId: input.operationId,
      applied: buildLayeredRevertCounts({ stagedRecordIds: {}, supersededRecordIds: {} }),
    };
  }

  if (operation.status !== 'completed') {
    return {
      success: false,
      status: 409,
      error: {
        code: 'OPERATION_NOT_REVERSIBLE',
        message: 'Import operation is not in a reversible state',
      },
    };
  }

  const activatedLayers = activatedLayersForRollback(operation);
  if (activatedLayers.length === 0) {
    return {
      success: false,
      status: 409,
      error: {
        code: 'OPERATION_NOT_REVERSIBLE',
        message: 'Import operation has no activated layers to revert',
      },
    };
  }

  const adapter = createStudioLayeredImportDbAdapter(
    {
      projectId: input.projectId,
      tenantId: input.tenantId,
    },
    {
      collectionProvider: input.collectionProvider,
      now: input.now,
      operationId: input.operationId,
    },
  );
  const importer = new StagedImporter(adapter);

  try {
    await ImportOperation.updateOne(
      { _id: input.operationId, projectId: input.projectId, tenantId: input.tenantId },
      { $set: { status: 'rolling_back' } },
    );
    await importer.rollback(
      input.operationId,
      input.projectId,
      input.tenantId,
      operation.stagedRecordIds ?? {},
      operation.supersededRecordIds ?? {},
      activatedLayers,
    );
    await ImportOperation.updateOne(
      { _id: input.operationId, projectId: input.projectId, tenantId: input.tenantId },
      { $set: { status: 'reverted' } },
    );

    return {
      success: true,
      operationId: input.operationId,
      applied: buildLayeredRevertCounts(operation),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ImportOperation.updateOne(
      { _id: input.operationId, projectId: input.projectId, tenantId: input.tenantId },
      {
        $set: {
          status: 'failed',
          error: {
            phase: 'rollback',
            layer: 'all',
            message,
          },
        },
      },
    );
    return {
      success: false,
      status: 500,
      error: {
        code: 'LAYERED_REVERT_FAILED',
        message: 'Layered import revert failed',
      },
    };
  }
}

export async function loadStudioLayeredImportExistingState(params: {
  projectId: string;
  tenantId: string;
  collectionProvider?: (collection: string) => RawCollection;
}): Promise<ExistingProjectStateV2> {
  const { existingState } = await loadStudioCoreImportState(params.projectId, params.tenantId);
  const collectionProvider = params.collectionProvider ?? getMongoCollection;
  const projectScopedFilter = {
    projectId: params.projectId,
    tenantId: params.tenantId,
    ...ACTIVE_LIFECYCLE_FILTER,
  };
  const projectKnowledgeBases = await collectionProvider('knowledge_bases')
    .find(projectScopedFilter, { projection: { _id: 1 } })
    .toArray();
  const projectKnowledgeBaseIds = projectKnowledgeBases.map((record) => String(record._id));
  const projectSearchIndexes = await collectionProvider('search_indexes')
    .find(projectScopedFilter, { projection: { _id: 1 } })
    .toArray();
  const projectSearchIndexIds = projectSearchIndexes.map((record) => String(record._id));
  const projectSearchSources =
    projectSearchIndexIds.length > 0
      ? await collectionProvider('search_sources')
          .find(
            {
              tenantId: params.tenantId,
              indexId: { $in: projectSearchIndexIds },
              ...ACTIVE_LIFECYCLE_FILTER,
            },
            { projection: { _id: 1 } },
          )
          .toArray()
      : [];
  const projectSearchSourceIds = projectSearchSources.map((record) => String(record._id));

  function buildActiveFilter(collectionName: string): Record<string, unknown> | null {
    if (collectionName === 'search_sources') {
      return projectSearchIndexIds.length > 0
        ? {
            tenantId: params.tenantId,
            indexId: { $in: projectSearchIndexIds },
            ...ACTIVE_LIFECYCLE_FILTER,
          }
        : null;
    }
    if (collectionName === 'connector_configs') {
      return projectSearchSourceIds.length > 0
        ? {
            tenantId: params.tenantId,
            sourceId: { $in: projectSearchSourceIds },
            ...ACTIVE_LIFECYCLE_FILTER,
          }
        : null;
    }
    if (collectionName === 'domain_vocabularies') {
      return projectKnowledgeBaseIds.length > 0
        ? {
            tenantId: params.tenantId,
            projectKnowledgeBaseId: { $in: projectKnowledgeBaseIds },
            ...ACTIVE_LIFECYCLE_FILTER,
          }
        : null;
    }
    if (collectionName === 'canonical_schemas') {
      return projectKnowledgeBaseIds.length > 0
        ? {
            tenantId: params.tenantId,
            knowledgeBaseId: { $in: projectKnowledgeBaseIds },
            ...ACTIVE_LIFECYCLE_FILTER,
          }
        : null;
    }
    if (collectionName === 'crawl_patterns') {
      return {
        tenantId: params.tenantId,
        ...ACTIVE_LIFECYCLE_FILTER,
      };
    }
    if (collectionName === 'guardrail_policies') {
      return {
        tenantId: params.tenantId,
        $and: [
          ACTIVE_LIFECYCLE_FILTER,
          {
            $or: [
              { projectId: params.projectId },
              { 'scope.type': 'project', 'scope.projectId': params.projectId },
              { 'scope.type': 'agent', 'scope.projectId': params.projectId },
            ],
          },
        ],
      };
    }
    return projectScopedFilter;
  }

  const entries = await Promise.all(
    Object.entries(ACTIVE_RECORD_PROJECTIONS).map(async ([collectionName, projection]) => {
      const filter = buildActiveFilter(collectionName);
      if (!filter) {
        return [collectionName, [] as Array<{ _id: string; [key: string]: unknown }>] as const;
      }
      const records = await collectionProvider(collectionName)
        .find(filter, { projection })
        .toArray();
      return [
        collectionName,
        records.map((record) => ({
          ...record,
          _id: String(record._id),
        })),
      ] as const;
    }),
  );

  return {
    ...existingState,
    activeRecords: new Map(entries),
  };
}

export function createStudioLayeredImportDeps(
  params: Pick<StudioLayeredImportParams, 'projectId' | 'tenantId'>,
  options: LayeredImportAdapterOptions = {},
): StudioLayeredImportDeps {
  const dbAdapter = createStudioLayeredImportDbAdapter(params, options);
  return {
    disassemblers: buildDefaultDisassemblers(),
    dbAdapter,
    crossRefDb: dbAdapter,
  };
}

function countRuntimeConfigMutationFiles(files?: ReadonlyMap<string, string>): number {
  if (!files) {
    return 0;
  }

  let count = 0;
  for (const filePath of files.keys()) {
    if (
      filePath.endsWith('config/runtime-config.json') ||
      filePath.endsWith('config/llm-config.json') ||
      /(?:^|\/)config\/project-model-configs\/[^/]+\.model-config\.json$/.test(filePath) ||
      /(?:^|\/)config\/agent-model-configs\/[^/]+\.model-config\.json$/.test(filePath)
    ) {
      count++;
    }
  }
  return count;
}

export function buildLayeredAppliedCounts(
  preview: ImportPreviewV2,
  files?: ReadonlyMap<string, string>,
  conflictStrategy: ImportConflictStrategyV2 = 'merge',
): CoreImportApplyCountsV2 {
  const runtimeConfigFileMutations = countRuntimeConfigMutationFiles(files);
  const replaceMayDeleteRuntimeConfig =
    conflictStrategy === 'replace' && preview.layers.includes('core');

  return {
    created: preview.agentChanges.added.length,
    updated: preview.agentChanges.modified.length,
    deleted: preview.agentChanges.removed.length,
    toolsCreated: preview.toolChanges.added.length,
    toolsUpdated: preview.toolChanges.modified.length,
    toolsDeleted: preview.toolChanges.removed.length,
    localesCreated: preview.localeChanges?.added.length ?? 0,
    localesUpdated: preview.localeChanges?.modified.length ?? 0,
    localesDeleted: preview.localeChanges?.removed.length ?? 0,
    profilesCreated: preview.profileChanges?.added.length ?? 0,
    profilesUpdated: preview.profileChanges?.modified.length ?? 0,
    profilesDeleted: preview.profileChanges?.removed.length ?? 0,
    evalsCreated: preview.layerChanges.evals?.added ?? 0,
    evalsUpdated: preview.layerChanges.evals?.modified ?? 0,
    evalsDeleted: preview.layerChanges.evals?.removed ?? 0,
    modelPoliciesUpserted: runtimeConfigFileMutations,
    modelPoliciesDeleted: replaceMayDeleteRuntimeConfig ? 1 : 0,
  };
}

function isLayeredProjectToolType(toolType: unknown): toolType is LayeredProjectToolType {
  return (
    toolType === 'http' ||
    toolType === 'mcp' ||
    toolType === 'sandbox' ||
    toolType === 'searchai' ||
    toolType === 'workflow'
  );
}

function quoteDslScalar(value: string): string {
  return JSON.stringify(value);
}

function upsertIndentedDslProperty(dslContent: string, key: string, value: string): string {
  const lines = dslContent.split('\n');
  const propertyPattern = new RegExp(`^(\\s*)${key}\\s*:\\s*.*$`);
  const nextLine = (indent: string) => `${indent}${key}: ${quoteDslScalar(value)}`;

  for (let i = 1; i < lines.length; i += 1) {
    const match = lines[i].match(propertyPattern);
    if (match) {
      lines[i] = nextLine(match[1] ?? '  ');
      return lines.join('\n');
    }
  }

  const typeLineIndex = lines.findIndex((line, index) => index > 0 && /^\s*type\s*:/.test(line));
  const insertIndex = typeLineIndex >= 0 ? typeLineIndex + 1 : Math.min(lines.length, 1);
  const indent = typeLineIndex >= 0 ? (lines[typeLineIndex].match(/^\s*/)?.[0] ?? '  ') : '  ';
  lines.splice(insertIndex, 0, nextLine(indent));
  return lines.join('\n');
}

async function normalizeImportedSearchAiToolDslForTarget(input: {
  tenantId: string;
  projectId: string;
  toolType: LayeredProjectToolType;
  dslContent: string;
}): Promise<string> {
  if (input.toolType !== 'searchai') {
    return input.dslContent;
  }

  let dslContent = upsertIndentedDslProperty(input.dslContent, 'tenant_id', input.tenantId);

  try {
    const binding = buildSearchAIBindingFromProps(parseDslProperties(dslContent));
    if (!binding.kbName) {
      return dslContent;
    }

    const { KnowledgeBase, SearchIndex } = await import('@agent-platform/database/models');
    const knowledgeBase = await KnowledgeBase.findOne({
      tenantId: input.tenantId,
      projectId: input.projectId,
      name: binding.kbName,
    })
      .select({ searchIndexId: 1 })
      .lean();
    const searchIndexId =
      typeof knowledgeBase?.searchIndexId === 'string' && knowledgeBase.searchIndexId.length > 0
        ? knowledgeBase.searchIndexId
        : await SearchIndex.findOne({
            tenantId: input.tenantId,
            projectId: input.projectId,
            name: binding.kbName,
          })
            .select({ _id: 1 })
            .lean()
            .then((index: { _id?: unknown } | null) => (index?._id ? String(index._id) : null));

    if (searchIndexId) {
      dslContent = upsertIndentedDslProperty(dslContent, 'index_id', searchIndexId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug('Unable to normalize imported SearchAI tool by target knowledge base name', {
      error: message,
    });
  }

  return dslContent;
}

async function validateLayeredToolBindingForSave(input: {
  tenantId: string;
  projectId: string;
  toolType: string;
  dslContent: string;
}) {
  if (!isLayeredProjectToolType(input.toolType)) {
    return {
      valid: false as const,
      status: 400,
      code: 'TOOL_TYPE_INVALID',
      message: `Unsupported imported tool type: ${input.toolType}`,
    };
  }

  const normalizedDslContent = await normalizeImportedSearchAiToolDslForTarget({
    ...input,
    toolType: input.toolType,
  });
  const validation = await validateProjectToolBindingsForSave({
    ...input,
    toolType: input.toolType,
    dslContent: normalizedDslContent,
  });

  if (!validation.valid || normalizedDslContent === input.dslContent) {
    return validation;
  }

  return {
    ...validation,
    dslContent: normalizedDslContent,
  };
}

export async function previewStudioLayeredImportV2(input: {
  files: Map<string, string>;
  projectId: string;
  tenantId: string;
  userId: string;
  layers?: LayerName[];
  conflictStrategy?: ImportConflictStrategyV2;
  bindingResolutions?: Record<string, ImportBindingResolutionInput>;
}) {
  const normalizedFiles = stripCommonPrefix(input.files).files;
  const existingState = await loadStudioLayeredImportExistingState({
    projectId: input.projectId,
    tenantId: input.tenantId,
  });
  const result = await importProjectV2(
    normalizedFiles,
    existingState,
    {
      projectId: input.projectId,
      tenantId: input.tenantId,
      userId: input.userId,
      ...(input.layers ? { layers: input.layers } : {}),
      ...(input.bindingResolutions ? { bindingResolutions: input.bindingResolutions } : {}),
      conflictStrategy: input.conflictStrategy ?? 'merge',
      dryRun: true,
      validateToolBindingForSave: validateLayeredToolBindingForSave,
      validateRuntimeConfigForSave:
        createProjectRuntimeConfigSaveValidatorForFiles(normalizedFiles),
    },
    createStudioLayeredImportDeps(input),
  );

  if (result.preview) {
    result.preview = enrichImportPreview(result.preview, normalizedFiles);
  }

  return result;
}

export async function applyStudioLayeredImportV2(input: {
  files: Map<string, string>;
  projectId: string;
  tenantId: string;
  userId: string;
  layers?: LayerName[];
  conflictStrategy?: ImportConflictStrategyV2;
  previewDigest?: string | null;
  acknowledgedIssueIds?: string[];
  bindingResolutions?: Record<string, ImportBindingResolutionInput>;
}) {
  const previewResult = await previewStudioLayeredImportV2(input);
  if (!previewResult.success || !previewResult.preview) {
    return {
      success: false as const,
      stage: 'prepare' as const,
      error: previewResult.error ?? {
        code: 'VALIDATION_FAILED',
        message: 'Import validation failed',
      },
      preview: previewResult.preview,
      warnings: previewResult.warnings,
      operationId: previewResult.operationId,
    };
  }

  if (previewResult.preview.hasBlockingIssues) {
    return {
      success: false as const,
      stage: 'preview' as const,
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Import preview contains blocking issues',
      },
      preview: previewResult.preview,
      warnings: previewResult.warnings,
      operationId: previewResult.operationId,
    };
  }

  const acknowledgement = validatePreviewAcknowledgement(
    previewResult.preview,
    input.previewDigest,
    input.acknowledgedIssueIds,
  );
  if (!acknowledgement.ok) {
    return {
      success: false as const,
      stage: 'acknowledgement' as const,
      error: {
        code: acknowledgement.code,
        message: acknowledgement.message,
      },
      preview: previewResult.preview,
      warnings: previewResult.warnings,
      operationId: previewResult.operationId,
    };
  }

  const existingState = await loadStudioLayeredImportExistingState({
    projectId: input.projectId,
    tenantId: input.tenantId,
  });
  const normalizedFiles = stripCommonPrefix(input.files).files;
  const result = await importProjectV2(
    normalizedFiles,
    existingState,
    {
      projectId: input.projectId,
      tenantId: input.tenantId,
      userId: input.userId,
      ...(input.layers ? { layers: input.layers } : {}),
      ...(input.bindingResolutions ? { bindingResolutions: input.bindingResolutions } : {}),
      conflictStrategy: input.conflictStrategy ?? 'merge',
      dryRun: false,
      validateToolBindingForSave: validateLayeredToolBindingForSave,
      validateRuntimeConfigForSave:
        createProjectRuntimeConfigSaveValidatorForFiles(normalizedFiles),
    },
    createStudioLayeredImportDeps(input),
  );
  if (result.preview) {
    result.preview = enrichImportPreview(result.preview, normalizedFiles);
  }

  if (!result.success) {
    return {
      success: false as const,
      stage: result.phase === 'failed' ? 'apply' : result.phase,
      error: result.error ?? {
        code: 'IMPORT_APPLY_FAILED',
        message: 'Import failed during apply',
      },
      preview: result.preview ?? previewResult.preview,
      warnings: result.warnings,
      operationId: result.operationId,
    };
  }

  const entryAgentName = (result.preview ?? previewResult.preview).entryAgentResolution.resolved;
  await Project.findOneAndUpdate(
    { _id: input.projectId, tenantId: input.tenantId },
    entryAgentName ? { $set: { entryAgentName } } : { $unset: { entryAgentName: 1 } },
  );

  return {
    success: true as const,
    preview: result.preview ?? previewResult.preview,
    warnings: result.warnings,
    applied: buildLayeredAppliedCounts(
      result.preview ?? previewResult.preview,
      input.files,
      input.conflictStrategy ?? 'merge',
    ),
    entryAgentName,
    operationId: result.operationId,
  };
}
