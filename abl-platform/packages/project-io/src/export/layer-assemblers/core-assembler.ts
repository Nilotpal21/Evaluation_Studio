import type { LayerAssembler, LayerQueryContext } from './types.js';
import type { LayerAssemblyResult } from '../../types.js';
import { mapProjectRuntimeConfigDocumentToIR, type CompilerOptions } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform/logger.js';
import {
  ProjectAgent,
  ProjectTool,
  ProjectSettings,
  ProjectRuntimeConfig,
  ProjectLLMConfig,
  Project,
  ModelConfig,
  AgentModelConfig,
  EnvironmentVariable,
  ProjectConfigVariable,
  MCPServerConfig,
} from '@agent-platform/database';
import { TenantModel } from '@agent-platform/database/models';
import {
  agentFilePath,
  assignCollisionSafePath,
  profileFilePath,
  toolFilePath,
} from '../folder-builder.js';
import { sanitizeName, stripInternalFields } from './assembler-utils.js';
import { canonicalizeToolFileContent } from '../../tool-file-format.js';
import {
  materializeAgentExport,
  materializeProjectAgentExports,
  type ProjectAwareAgentExportSource,
} from '../agent-export-materializer.js';
import { isYamlFormat } from '@abl/core';
import type { AgentArchiveFormat } from '../../types.js';
import {
  isLocaleAssetConfigKey,
  localeAssetConfigKeyToRelativePath,
  localeAssetRelativePathToFilePath,
} from '../../locale-files.js';
import {
  behaviorProfileConfigKeyToName,
  isBehaviorProfileConfigKey,
} from '../../behavior-profile-files.js';
import {
  MCP_SERVER_CONFIG_EXPORT_SELECT,
  mcpServerConfigFilePath,
  serializeMcpServerConfigForFile,
  type ProjectIOMcpServerConfig,
} from '../../mcp-server-config-io.js';
import { PROJECT_RUNTIME_CONFIG_DEFAULTS } from '@agent-platform/shared/validation';
import { validateProjectModelPolicyConfigWrite } from '../../import/runtime-config-save-validation.js';
const log = createLogger('core-assembler');
const AGENT_SELECT =
  'name description dslContent ownerId ownerTeamId version status systemPromptLibraryRef';
const TOOL_SELECT = 'name slug dslContent';
const PROJECT_SETTINGS_EXPORT_SELECT =
  'enableThinking thinkingBudget thoughtDescription promptOverrides compactionThreshold traceDimensions agentTransfer sessionLifecycle memory publicApiAccess sdkDefaults';
const PROJECT_RUNTIME_CONFIG_EXPORT_SELECT =
  'operationTierOverrides extraction multi_intent inference conversion pii_redaction lookup_tables compaction pipeline filler';
const PROJECT_LLM_CONFIG_EXPORT_SELECT = 'operationTierOverrides';
const PROJECT_MODEL_CONFIG_EXPORT_SELECT =
  'name modelId provider temperature maxTokens topP frequencyPenalty presencePenalty hyperParameters inputCostPer1k outputCostPer1k supportsTools supportsVision supportsStreaming useResponsesApi useStreaming contextWindow tier isDefault priority';
const AGENT_MODEL_CONFIG_EXPORT_SELECT =
  'agentName defaultModel operationModels temperature maxTokens hyperParameters useResponsesApi useStreaming';
const ENVIRONMENT_VARIABLE_EXPORT_SELECT = 'key description isSecret environment';
const PROJECT_CONFIG_VARIABLE_EXPORT_SELECT = 'key value description';
const PROJECT_MODEL_CONFIG_REDACTED_KEYS = ['tenantModelId', 'credentialId', 'authProfileId'];

interface PortableTenantModelRef {
  provider: string;
  modelId: string;
  tier?: string;
  capabilities?: string[];
  displayName?: string;
}

function toPlainObject(doc: unknown): Record<string, unknown> {
  if (
    doc &&
    typeof doc === 'object' &&
    'toObject' in doc &&
    typeof (doc as { toObject?: unknown }).toObject === 'function'
  ) {
    return (doc as { toObject: () => Record<string, unknown> }).toObject();
  }
  return doc as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectRuntimeTenantModelIds(config: Record<string, unknown>): string[] {
  return ['pipeline', 'filler']
    .map((key) => {
      const section = config[key];
      if (!isRecord(section) || section.modelSource !== 'tenant') {
        return null;
      }
      return typeof section.tenantModelId === 'string' && section.tenantModelId.length > 0
        ? section.tenantModelId
        : null;
    })
    .filter((id): id is string => id !== null);
}

function normalizeOperationTierOverridesForExport(value: unknown): Record<string, string> {
  if (value instanceof Map) {
    return Object.fromEntries(value);
  }
  return isRecord(value) ? (value as Record<string, string>) : {};
}

function buildPortableTenantModelRef(
  model: Record<string, unknown> | undefined,
): PortableTenantModelRef | null {
  if (!model || typeof model.provider !== 'string' || typeof model.modelId !== 'string') {
    return null;
  }

  return {
    provider: model.provider,
    modelId: model.modelId,
    ...(typeof model.tier === 'string' ? { tier: model.tier } : {}),
    ...(Array.isArray(model.capabilities)
      ? { capabilities: model.capabilities.filter((cap): cap is string => typeof cap === 'string') }
      : {}),
    ...(typeof model.displayName === 'string' ? { displayName: model.displayName } : {}),
  };
}

function normalizeRuntimeModelBindingForExport(input: {
  sectionName: string;
  section: unknown;
  tenantModelsById: Map<string, Record<string, unknown>>;
  warnings: string[];
}): unknown {
  if (!isRecord(input.section)) {
    return input.section;
  }

  const result = { ...input.section };
  delete result.tenantModelRef;

  if (result.modelSource !== 'tenant') {
    return result;
  }

  const tenantModelId =
    typeof result.tenantModelId === 'string' && result.tenantModelId.length > 0
      ? result.tenantModelId
      : null;
  delete result.tenantModelId;

  if (!tenantModelId) {
    return result;
  }

  const ref = buildPortableTenantModelRef(input.tenantModelsById.get(tenantModelId));
  if (!ref) {
    result.modelSource = 'default';
    input.warnings.push(
      `Runtime ${input.sectionName} tenant model binding could not be exported portably; falling back to default model source`,
    );
    return result;
  }

  result.tenantModelRef = ref;
  return result;
}

function normalizeRuntimeConfigEffectiveShape(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = {
    ...config,
    operationTierOverrides: normalizeOperationTierOverridesForExport(config.operationTierOverrides),
    extraction: {
      ...PROJECT_RUNTIME_CONFIG_DEFAULTS.extraction,
      ...(isRecord(config.extraction) ? config.extraction : {}),
    },
    multi_intent: {
      ...PROJECT_RUNTIME_CONFIG_DEFAULTS.multi_intent,
      ...(isRecord(config.multi_intent) ? config.multi_intent : {}),
    },
    inference: {
      ...PROJECT_RUNTIME_CONFIG_DEFAULTS.inference,
      ...(isRecord(config.inference) ? config.inference : {}),
    },
    conversion: {
      ...PROJECT_RUNTIME_CONFIG_DEFAULTS.conversion,
      ...(isRecord(config.conversion) ? config.conversion : {}),
    },
    pii_redaction: {
      ...PROJECT_RUNTIME_CONFIG_DEFAULTS.pii_redaction,
      ...(isRecord(config.pii_redaction) ? config.pii_redaction : {}),
    },
    lookup_tables: Array.isArray(config.lookup_tables) ? config.lookup_tables : [],
    filler: {
      ...PROJECT_RUNTIME_CONFIG_DEFAULTS.filler,
      ...(isRecord(config.filler) ? config.filler : {}),
    },
  };

  if ((normalized.filler as Record<string, unknown>).modelSource === 'default') {
    (normalized.filler as Record<string, unknown>).modelSource = 'system';
  }
  if ((normalized.extraction as Record<string, unknown>).nlu_provider !== 'advanced') {
    delete (normalized.extraction as Record<string, unknown>).advanced_sidecar_url;
  }
  return normalized;
}

function hasOperationTierOverrides(config: Record<string, unknown> | null | undefined): boolean {
  return Boolean(config && Object.prototype.hasOwnProperty.call(config, 'operationTierOverrides'));
}

async function serializeRuntimeConfigForExport(input: {
  runtimeConfig: Record<string, unknown>;
  llmConfig?: Record<string, unknown> | null;
  tenantId: string;
  warnings: string[];
}): Promise<Record<string, unknown>> {
  const clean = normalizeRuntimeConfigEffectiveShape(stripInternalFields(input.runtimeConfig));
  if (hasOperationTierOverrides(input.llmConfig)) {
    delete clean.operationTierOverrides;
  }
  const tenantModelIds = [...new Set(collectRuntimeTenantModelIds(clean))];
  if (tenantModelIds.length === 0) {
    return clean;
  }

  const tenantModels = (await TenantModel.find({
    _id: { $in: tenantModelIds },
    tenantId: input.tenantId,
  }).lean()) as Record<string, unknown>[];
  const tenantModelsById = new Map(
    tenantModels.map((model) => [String(model._id), model] as const),
  );

  return {
    ...clean,
    pipeline: normalizeRuntimeModelBindingForExport({
      sectionName: 'pipeline',
      section: clean.pipeline,
      tenantModelsById,
      warnings: input.warnings,
    }),
    filler: normalizeRuntimeModelBindingForExport({
      sectionName: 'filler',
      section: clean.filler,
      tenantModelsById,
      warnings: input.warnings,
    }),
  };
}

function serializeLlmConfigForExport(input: {
  llmConfig: Record<string, unknown>;
  warnings: string[];
}): Record<string, unknown> {
  const { llmConfig, warnings } = input;
  const clean = stripInternalFields(llmConfig, ['apiKey', 'encryptedApiKey']);
  if (Object.prototype.hasOwnProperty.call(clean, 'operationTierOverrides')) {
    const validation = validateProjectModelPolicyConfigWrite({
      data: { operationTierOverrides: clean.operationTierOverrides },
    });
    if (validation.valid) {
      clean.operationTierOverrides = normalizeOperationTierOverridesForExport(
        validation.data.operationTierOverrides,
      );
    } else {
      delete clean.operationTierOverrides;
      warnings.push(
        `Skipped invalid LLM operation-tier overrides during export: ${validation.message}`,
      );
    }
  }
  return clean;
}

function inferSourceAgentFormat(dslContent: string): AgentArchiveFormat {
  return isYamlFormat(dslContent) ? 'yaml' : 'abl';
}

async function loadProjectModelConfigs(projectId: string, tenantId: string) {
  const project = await Project.findOne({ _id: projectId, tenantId }).lean();
  if (!project) {
    return [];
  }
  return ModelConfig.find({ projectId, tenantId })
    .lean()
    .select(PROJECT_MODEL_CONFIG_EXPORT_SELECT);
}

async function countProjectModelConfigs(projectId: string, tenantId: string): Promise<number> {
  const project = await Project.findOne({ _id: projectId, tenantId }).lean();
  if (!project) {
    return 0;
  }
  return ModelConfig.countDocuments({ projectId, tenantId });
}

export class CoreAssembler implements LayerAssembler {
  readonly layer = 'core' as const;

  async assemble(ctx: LayerQueryContext): Promise<LayerAssemblyResult> {
    const { projectId, tenantId, dslFormat = 'source' } = ctx;
    const files = new Map<string, string>();
    const warnings: string[] = [];
    const metadata: NonNullable<LayerAssemblyResult['metadata']> = {
      agents: [],
      tools: [],
      profiles: [],
    };
    let entityCount = 0;

    // Wave 1: All core queries in parallel
    const [
      agents,
      tools,
      settings,
      runtimeConfig,
      llmConfig,
      projectModelConfigs,
      modelConfigs,
      envVars,
      configVars,
      mcpServers,
    ] = await Promise.all([
      ProjectAgent.find({ projectId, tenantId }).lean().select(AGENT_SELECT),
      ProjectTool.find({ projectId, tenantId }).lean().select(TOOL_SELECT),
      ProjectSettings.findOne({ projectId, tenantId })
        .lean()
        .select(PROJECT_SETTINGS_EXPORT_SELECT),
      ProjectRuntimeConfig.findOne({ projectId, tenantId })
        .lean()
        .select(PROJECT_RUNTIME_CONFIG_EXPORT_SELECT),
      ProjectLLMConfig.findOne({ projectId, tenantId })
        .lean()
        .select(PROJECT_LLM_CONFIG_EXPORT_SELECT),
      loadProjectModelConfigs(projectId, tenantId),
      AgentModelConfig.find({ projectId, tenantId })
        .lean()
        .select(AGENT_MODEL_CONFIG_EXPORT_SELECT),
      EnvironmentVariable.find({ projectId, tenantId })
        .lean()
        .select(ENVIRONMENT_VARIABLE_EXPORT_SELECT),
      ProjectConfigVariable.find({ projectId, tenantId })
        .lean()
        .select(PROJECT_CONFIG_VARIABLE_EXPORT_SELECT),
      MCPServerConfig.find({ projectId, tenantId }).lean().select(MCP_SERVER_CONFIG_EXPORT_SELECT),
    ]);
    const exportableAgents = agents as ProjectAwareAgentExportSource[];

    const configVariableMap: Record<string, string> = {};
    for (const configVar of configVars as Array<Record<string, unknown>>) {
      if (typeof configVar.key === 'string' && typeof configVar.value === 'string') {
        configVariableMap[configVar.key] = configVar.value;
      }
    }
    const materializationCompilerOptions: CompilerOptions = {};
    if (Object.keys(configVariableMap).length > 0) {
      materializationCompilerOptions.config_variables = configVariableMap;
    }
    if (runtimeConfig) {
      materializationCompilerOptions.project_runtime_config =
        mapProjectRuntimeConfigDocumentToIR(runtimeConfig);
    }

    const projectAwareMaterializedAgents =
      dslFormat === 'yaml'
        ? await materializeProjectAgentExports({
            projectId,
            tenantId,
            agents: exportableAgents.map((agent) => ({
              name: agent.name,
              dslContent: agent.dslContent,
              systemPromptLibraryRef: agent.systemPromptLibraryRef ?? null,
            })),
            ...(Object.keys(configVariableMap).length > 0
              ? { configVariables: configVariableMap }
              : {}),
            ...(Object.keys(materializationCompilerOptions).length > 0
              ? { compilerOptions: materializationCompilerOptions }
              : {}),
          })
        : null;

    // Agents
    for (const agent of exportableAgents) {
      const materialized =
        dslFormat === 'yaml'
          ? (projectAwareMaterializedAgents?.get(agent.name) ??
            materializeAgentExport(agent.name, agent.dslContent))
          : {
              content: agent.dslContent,
              format: inferSourceAgentFormat(agent.dslContent),
              warnings: [],
            };
      const path = assignCollisionSafePath(agentFilePath(agent.name, materialized.format), files);
      files.set(path, materialized.content);
      metadata.agents?.push({
        name: agent.name,
        path,
        format: materialized.format,
      });
      warnings.push(...materialized.warnings);
      entityCount++;
    }

    // Standalone tools (ProjectTool documents) — exported as separate .tools.abl files.
    //
    // These are shared tool definitions stored as standalone project documents.
    // Inline tools (defined within agent DSL TOOLS blocks) are exported as part
    // of the agent file itself — they are the canonical inline definitions.
    // Standalone tools represent the project's shared toolbox and may overlap
    // with inline definitions. This duplication is intentional: both are included
    // to preserve the project's complete toolbox. The importer should handle
    // deduplication if needed.
    for (const tool of tools) {
      const path = assignCollisionSafePath(toolFilePath(tool.name), files);
      const canonicalTool = canonicalizeToolFileContent(tool.dslContent);
      files.set(path, canonicalTool.content);
      metadata.tools?.push({ name: tool.name, path });
      if (canonicalTool.normalized) {
        warnings.push(`Normalized standalone tool "${tool.name}" into canonical TOOLS: format`);
      }
      if (canonicalTool.validationErrors.length > 0) {
        warnings.push(
          `Tool "${tool.name}" still has ${canonicalTool.validationErrors.length} canonical validation warning(s) after export`,
        );
      }
      entityCount++;
    }

    // Project settings
    if (settings) {
      const clean = stripInternalFields(toPlainObject(settings));
      files.set('config/project-settings.json', JSON.stringify(clean, null, 2));
    }

    // Runtime config
    if (runtimeConfig) {
      const clean = await serializeRuntimeConfigForExport({
        runtimeConfig: toPlainObject(runtimeConfig),
        llmConfig: llmConfig ? toPlainObject(llmConfig) : null,
        tenantId,
        warnings,
      });
      files.set('config/runtime-config.json', JSON.stringify(clean, null, 2));
    }

    // LLM config (strip API keys)
    if (llmConfig) {
      const clean = serializeLlmConfigForExport({ llmConfig: toPlainObject(llmConfig), warnings });
      files.set('config/llm-config.json', JSON.stringify(clean, null, 2));
    }

    // Project model configs (strip tenant-local binding references; destination import resolves them)
    for (const config of projectModelConfigs) {
      const clean = stripInternalFields(
        config as Record<string, unknown>,
        PROJECT_MODEL_CONFIG_REDACTED_KEYS,
      );
      const name = typeof clean.name === 'string' ? clean.name : null;
      if (!name) {
        warnings.push('Skipped unnamed project model config during export');
        continue;
      }
      const path = assignCollisionSafePath(
        `config/project-model-configs/${sanitizeName(name)}.model-config.json`,
        files,
      );
      files.set(path, JSON.stringify(clean, null, 2));
      entityCount++;
    }

    // Agent model configs
    for (const config of modelConfigs) {
      const clean = stripInternalFields(config as Record<string, unknown>);
      const path = assignCollisionSafePath(
        `config/agent-model-configs/${sanitizeName(config.agentName)}.model-config.json`,
        files,
      );
      files.set(path, JSON.stringify(clean, null, 2));
    }

    // Environment variables (references only — no values)
    if (envVars.length > 0) {
      const refs = envVars.map((v: Record<string, unknown>) => ({
        key: v.key as string,
        description: (v.description as string) ?? null,
        isSecret: (v.isSecret as boolean) ?? false,
        environment: (v.environment as string) ?? null,
      }));
      files.set('environment/env-vars.json', JSON.stringify(refs, null, 2));
    }

    // Config variables (plaintext project config, safe to round-trip)
    let exportedProfileCount = 0;
    if (configVars.length > 0) {
      const refs: Array<{ key: string; value: string; description: string | null }> = [];

      for (const configVar of configVars as Record<string, unknown>[]) {
        const key = configVar.key as string | undefined;
        if (!key) {
          continue;
        }

        if (isLocaleAssetConfigKey(key)) {
          const relativePath = localeAssetConfigKeyToRelativePath(key);
          if (!relativePath) {
            warnings.push(`Skipped invalid locale asset config variable "${key}" during export`);
            continue;
          }

          const content = typeof configVar.value === 'string' ? configVar.value : '';
          files.set(localeAssetRelativePathToFilePath(relativePath), content);
          continue;
        }

        if (isBehaviorProfileConfigKey(key)) {
          const profileName = behaviorProfileConfigKeyToName(key);
          if (!profileName) {
            warnings.push(
              `Skipped invalid behavior profile config variable "${key}" during export`,
            );
            continue;
          }

          const content = typeof configVar.value === 'string' ? configVar.value : '';
          const path = assignCollisionSafePath(profileFilePath(profileName), files);
          files.set(path, content);
          metadata.profiles?.push({ name: profileName, path });
          exportedProfileCount++;
          continue;
        }

        refs.push({
          key,
          value: typeof configVar.value === 'string' ? configVar.value : '',
          description: (configVar.description as string) ?? null,
        });
      }

      if (refs.length > 0) {
        refs.sort((left, right) => left.key.localeCompare(right.key));
        files.set('environment/config-vars.json', JSON.stringify(refs, null, 2));
      }
    }

    // MCP server configs (strip auth)
    for (const server of mcpServers) {
      const exportableServer = server as Partial<ProjectIOMcpServerConfig> &
        Pick<ProjectIOMcpServerConfig, 'name' | 'transport'>;
      const path = assignCollisionSafePath(mcpServerConfigFilePath(exportableServer.name), files);
      files.set(path, serializeMcpServerConfigForFile(exportableServer));
      entityCount++;
    }

    entityCount += exportedProfileCount;

    log.info('Core layer assembled', {
      projectId,
      agents: agents.length,
      tools: tools.length,
      profiles: exportedProfileCount,
    });
    return { layer: 'core', files, entityCount, warnings, metadata };
  }

  async countEntities(ctx: LayerQueryContext): Promise<number> {
    const [agentCount, toolCount, mcpServerCount, projectModelCount, profileCount] =
      await Promise.all([
        ProjectAgent.countDocuments({ projectId: ctx.projectId, tenantId: ctx.tenantId }),
        ProjectTool.countDocuments({ projectId: ctx.projectId, tenantId: ctx.tenantId }),
        MCPServerConfig.countDocuments({ projectId: ctx.projectId, tenantId: ctx.tenantId }),
        countProjectModelConfigs(ctx.projectId, ctx.tenantId),
        ProjectConfigVariable.countDocuments({
          projectId: ctx.projectId,
          tenantId: ctx.tenantId,
          key: /^profile:/,
        }),
      ]);
    return agentCount + toolCount + mcpServerCount + projectModelCount + profileCount;
  }
}
