/**
 * LLM Resolution Repository
 *
 * MongoDB queries needed by ModelResolutionService.
 * Used by: services/llm/model-resolution.ts
 */

import { createLogger } from '@abl/compiler/platform';
import {
  formatOperationTierOverrideError,
  getLlmProviderPolicyAliases,
  normalizeOperationTierOverrides,
} from '@agent-platform/shared-kernel';

const log = createLogger('llm-resolution-repo');

const PRIMARY_DEFAULT_TIER_ORDER = ['balanced', 'powerful', 'fast', 'voice'] as const;
const MODEL_RESOLUTION_DSL_READY_STATUSES = new Set(['valid', 'warning']);

function buildProviderLookup(provider: string): string | { $in: string[] } {
  const aliases = getLlmProviderPolicyAliases(provider);
  return aliases.length === 1 ? aliases[0] : { $in: aliases };
}

function isModelResolutionDslReady(agent: { dslValidationStatus?: unknown }): boolean {
  return MODEL_RESOLUTION_DSL_READY_STATUSES.has(String(agent.dslValidationStatus));
}

function normalizeStoredOperationTierOverrides(input: {
  tenantId: string;
  projectId: string;
  source: 'ProjectLLMConfig' | 'ProjectRuntimeConfig';
  overrides: unknown;
}): Record<string, string> | null {
  const validation = normalizeOperationTierOverrides(input.overrides);
  if (validation.ok) {
    return validation.overrides;
  }

  log.warn('Ignoring invalid project operation routing map during model resolution', {
    tenantId: input.tenantId,
    projectId: input.projectId,
    source: input.source,
    error: formatOperationTierOverrideError(validation),
  });
  return null;
}

// ─── Database Availability ────────────────────────────────────────────────

/**
 * Check if a database is accessible for model resolution queries.
 * Returns true — MongoDB is available if selected as backend.
 */
export function isResolutionDatabaseAvailable(): boolean {
  return true;
}

async function projectBelongsToTenant(projectId: string, tenantId?: string): Promise<boolean> {
  if (!tenantId) {
    return true;
  }

  const { Project } = await import('@agent-platform/database/models');
  const project = await Project.findOne({ _id: projectId, tenantId }, { _id: 1 }).lean();
  return Boolean(project);
}

// ─── Level 2: Agent Model Config ──────────────────────────────────────────

export async function findAgentModelConfig(
  projectId: string,
  agentName: string,
  tenantId?: string,
): Promise<any | null> {
  if (!(await projectBelongsToTenant(projectId, tenantId))) return null;

  const { AgentModelConfig } = await import('@agent-platform/database/models');
  const baseFilter = { projectId, ...(tenantId ? { tenantId } : {}) };
  // Try exact match first, then case-insensitive (Studio stores slug "sales_agent",
  // but runtime resolves by DSL name "Sales_Agent")
  let doc = await AgentModelConfig.findOne({ ...baseFilter, agentName }).lean();
  if (!doc) {
    doc = await AgentModelConfig.findOne({
      ...baseFilter,
      agentName: {
        $regex: new RegExp(`^${agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      },
    }).lean();
  }
  if (!doc) return null;
  return { ...doc, id: doc._id, operationModels: JSON.stringify(doc.operationModels || {}) };
}

/**
 * Fallback lookup: the runtime uses IR/DSL agent names (e.g., "TravelDesk_Supervisor")
 * but the Studio stores configs using the project agent slug (e.g., "supervisor").
 *
 * This function resolves the mapping by checking the project_agents' dslContent
 * for the DSL agent name declaration (e.g., "SUPERVISOR: TravelDesk_Supervisor").
 */
export async function findAgentModelConfigByDslName(
  projectId: string,
  dslAgentName: string,
  tenantId?: string,
): Promise<any | null> {
  if (!(await projectBelongsToTenant(projectId, tenantId))) return null;

  const { ProjectAgent, AgentModelConfig } = await import('@agent-platform/database/models');

  // Find all project agents and check their DSL content for the matching name
  const agents = await ProjectAgent.find(
    { projectId, ...(tenantId ? { tenantId } : {}) },
    { name: 1, dslContent: 1, dslValidationStatus: 1 },
  ).lean();

  // Pattern matches: "AGENT: Name" or "SUPERVISOR: Name" at start of line
  const namePattern = /^(?:AGENT|SUPERVISOR):\s*(\S+)/m;

  for (const agent of agents) {
    if (!agent.dslContent) continue;
    if (!isModelResolutionDslReady(agent)) continue;
    const match = (agent.dslContent as string).match(namePattern);
    if (match && match[1] === dslAgentName) {
      // Found the project agent slug — look up its model config
      const doc = await AgentModelConfig.findOne({
        projectId,
        ...(tenantId ? { tenantId } : {}),
        agentName: agent.name,
      }).lean();
      if (doc) {
        return { ...doc, id: doc._id, operationModels: JSON.stringify(doc.operationModels || {}) };
      }
    }
  }

  return null;
}

/**
 * Find a project ModelConfig by its modelId (used by Level 2 to resolve
 * agent overrides through the project's configured models + TenantModel links).
 */
export async function findModelConfigByModelId(
  projectId: string,
  modelId: string,
  tenantId?: string,
): Promise<any | null> {
  if (!(await projectBelongsToTenant(projectId, tenantId))) return null;

  const { ModelConfig } = await import('@agent-platform/database/models');
  const filter = tenantId ? { projectId, tenantId, modelId } : { projectId, modelId };
  // modelId is not unique on ModelConfig — sort to make selection deterministic,
  // including _id as a stable tie-breaker, and limit(2) so we can detect duplicates.
  const docs = await ModelConfig.find(filter)
    .sort({ isDefault: -1, priority: -1, updatedAt: -1, _id: 1 })
    .limit(2)
    .lean();

  const doc = docs[0];
  if (!doc) return null;

  if (docs.length > 1) {
    log.warn('Multiple ModelConfigs found for modelId; using highest priority/default match', {
      projectId,
      tenantId,
      modelId,
      chosenModelConfigId: doc._id,
      candidateModelConfigIds: docs.map((candidate: { _id: unknown }) => String(candidate._id)),
    });
  }

  return { ...doc, id: doc._id };
}

// ─── Level 3: Project Model Config ───────────────────────────────────────

export async function findModelConfigForTier(
  projectId: string,
  tier: string,
  tenantId?: string,
): Promise<any | null> {
  if (!(await projectBelongsToTenant(projectId, tenantId))) return null;

  const { ModelConfig } = await import('@agent-platform/database/models');
  const baseFilter = tenantId ? { projectId, tenantId, tier } : { projectId, tier };
  let doc = await ModelConfig.findOne({ ...baseFilter, isDefault: true })
    .sort({ priority: -1 })
    .lean();

  if (!doc) {
    doc = await ModelConfig.findOne(baseFilter).sort({ priority: -1 }).lean();
  }

  if (!doc) return null;
  return { ...doc, id: doc._id };
}

export async function findAnyModelConfig(
  projectId: string,
  tenantId?: string,
): Promise<any | null> {
  if (!(await projectBelongsToTenant(projectId, tenantId))) return null;

  const { ModelConfig } = await import('@agent-platform/database/models');
  const filter = tenantId ? { projectId, tenantId } : { projectId };
  let doc: any | null = null;
  for (const tier of PRIMARY_DEFAULT_TIER_ORDER) {
    doc = await ModelConfig.findOne({ ...filter, isDefault: true, tier })
      .sort({ priority: -1 })
      .lean();
    if (doc) break;
  }
  if (!doc) {
    doc = await ModelConfig.findOne({ ...filter, isDefault: true })
      .sort({ priority: -1 })
      .lean();
  }
  if (!doc) {
    doc = await ModelConfig.findOne(filter).sort({ priority: -1 }).lean();
  }
  if (!doc) return null;
  return { ...doc, id: doc._id };
}

// ─── Level 4: Tenant Model with Active Primary Connection ────────────────

/**
 * Filter connections to the best candidate for inference.
 * Prefers active + primary; falls back to any active connection
 * when no primary is explicitly set (common for single-connection models).
 */
function filterPrimaryConnection(doc: any): any {
  const all = doc.connections || [];
  const activePrimary = all.filter((c: any) => c.isActive && c.isPrimary);
  if (activePrimary.length > 0) {
    return { ...doc, id: doc._id, connections: activePrimary.slice(0, 1) };
  }
  const anyActive = all.filter((c: any) => c.isActive);
  if (anyActive.length > 0) {
    log.warn('TenantModel has no primary connection — falling back to first active connection', {
      tenantModelId: doc._id,
      totalConnections: all.length,
      activeConnections: anyActive.length,
    });
    return { ...doc, id: doc._id, connections: anyActive.slice(0, 1) };
  }
  return { ...doc, id: doc._id, connections: [] };
}

export async function findTenantModelByIdWithPrimaryConnection(
  id: string,
  tenantId: string,
): Promise<any | null> {
  const { TenantModel } = await import('@agent-platform/database/models');
  const doc = await TenantModel.findOne({ _id: id, tenantId }).lean();
  if (!doc) return null;
  return filterPrimaryConnection(doc);
}

/**
 * Find default TenantModel for a tenant+tier.
 * Tries isDefault=true first, falls back to any active model for the tier.
 */
export async function findDefaultTenantModelForTier(
  tenantId: string,
  tier: string,
): Promise<any | null> {
  const { TenantModel } = await import('@agent-platform/database/models');
  let doc = await TenantModel.findOne({
    tenantId,
    tier,
    isDefault: true,
    isActive: true,
    inferenceEnabled: true,
  }).lean();
  if (!doc) {
    doc = await TenantModel.findOne({
      tenantId,
      tier,
      isActive: true,
      inferenceEnabled: true,
    }).lean();
  }
  if (!doc) return null;
  return filterPrimaryConnection(doc);
}

/**
 * Find any default TenantModel for a tenant, regardless of tier.
 * Used as a tier-agnostic fallback when no tier-specific model is configured.
 * Tries isDefault=true first, falls back to any active inference-enabled model.
 */
export async function findAnyDefaultTenantModel(tenantId: string): Promise<any | null> {
  const { TenantModel } = await import('@agent-platform/database/models');
  let doc: any | null = null;
  for (const tier of PRIMARY_DEFAULT_TIER_ORDER) {
    doc = await TenantModel.findOne({
      tenantId,
      tier,
      isDefault: true,
      isActive: true,
      inferenceEnabled: true,
    }).lean();
    if (doc) break;
  }
  if (!doc) {
    doc = await TenantModel.findOne({
      tenantId,
      isDefault: true,
      isActive: true,
      inferenceEnabled: true,
    }).lean();
  }
  if (!doc) {
    doc = await TenantModel.findOne({
      tenantId,
      isActive: true,
      inferenceEnabled: true,
    }).lean();
  }
  if (!doc) return null;
  return filterPrimaryConnection(doc);
}

/**
 * Find TenantModel by provider for credential resolution.
 * Prefers the default model, then any model with active connections.
 */
export async function findTenantModelByProvider(
  tenantId: string,
  provider: string,
): Promise<any | null> {
  const { TenantModel } = await import('@agent-platform/database/models');
  const baseFilter = {
    tenantId,
    provider: buildProviderLookup(provider),
    isActive: true,
    inferenceEnabled: true,
  };

  // 1. Prefer the default model for this provider
  let doc = await TenantModel.findOne({ ...baseFilter, isDefault: true }).lean();

  // 2. Fall back to any model with at least one active connection
  if (!doc) {
    doc = await TenantModel.findOne({
      ...baseFilter,
      'connections.isActive': true,
      'connections.credentialId': { $exists: true, $ne: null },
    }).lean();
  }

  // 3. Last resort: any model for this provider
  if (!doc) {
    doc = await TenantModel.findOne(baseFilter).lean();
  }

  if (!doc) return null;
  return filterPrimaryConnection(doc);
}

// ─── Voice Model Resolution ───────────────────────────────────────────────

/**
 * Find a TenantModel with realtime_voice capability for credential + model resolution.
 * Prefers isDefault=true, falls back to any active voice-capable model.
 */
export async function findDefaultTenantModelForVoice(tenantId: string): Promise<any | null> {
  const { TenantModel } = await import('@agent-platform/database/models');
  // Try default voice-capable model first
  let doc = await TenantModel.findOne({
    tenantId,
    capabilities: 'realtime_voice',
    isActive: true,
    inferenceEnabled: true,
    isDefault: true,
  }).lean();
  if (!doc) {
    // Fallback: any active voice-capable model
    doc = await TenantModel.findOne({
      tenantId,
      capabilities: 'realtime_voice',
      isActive: true,
      inferenceEnabled: true,
    }).lean();
  }
  if (!doc) return null;
  return filterPrimaryConnection(doc);
}

// ─── Tenant LLM Policy ───────────────────────────────────────────────────

export async function findTenantLLMPolicy(tenantId: string): Promise<any | null> {
  const { TenantLLMPolicy } = await import('@agent-platform/database/models');
  const doc = await TenantLLMPolicy.findOne({ tenantId }).lean();
  if (!doc) return null;
  return {
    ...doc,
    id: doc._id,
    allowedProviders: doc.allowedProviders || [],
  };
}

// ─── Project Operation Routing Map ───────────────────────────────────────

export async function findProjectOperationTierOverrides(
  tenantId: string,
  projectId: string,
): Promise<Record<string, string> | Map<string, string> | null> {
  const { ProjectLLMConfig, ProjectRuntimeConfig } =
    await import('@agent-platform/database/models');
  const canonical = await ProjectLLMConfig.findOne(
    { tenantId, projectId },
    { operationTierOverrides: 1 },
  ).lean();
  if (canonical?.operationTierOverrides) {
    return normalizeStoredOperationTierOverrides({
      tenantId,
      projectId,
      source: 'ProjectLLMConfig',
      overrides: canonical.operationTierOverrides,
    });
  }

  const compatibility = await ProjectRuntimeConfig.findOne(
    { tenantId, projectId },
    { operationTierOverrides: 1 },
  ).lean();
  if (!compatibility?.operationTierOverrides) {
    return null;
  }
  return normalizeStoredOperationTierOverrides({
    tenantId,
    projectId,
    source: 'ProjectRuntimeConfig',
    overrides: compatibility.operationTierOverrides,
  });
}

// ─── Project EnableThinking Default ──────────────────────────────────────

export async function findProjectEnableThinking(
  projectId: string,
  settingsVersionId?: string,
  tenantId?: string,
): Promise<
  | {
      enableThinking?: boolean;
      thinkingBudget?: number | null;
      thoughtDescription?: string | null;
      compactionThreshold?: number | null;
    }
  | undefined
> {
  // If a pinned settings version is provided, use it first
  if (settingsVersionId && tenantId) {
    const { ProjectSettingsVersion } = await import('@agent-platform/database/models');
    const ver = await ProjectSettingsVersion.findOne(
      { _id: settingsVersionId, tenantId },
      { settings: 1 },
    ).lean();
    if (ver?.settings) {
      return {
        enableThinking: ver.settings.enableThinking,
        thinkingBudget: ver.settings.thinkingBudget ?? null,
        thoughtDescription: ver.settings.thoughtDescription ?? null,
        compactionThreshold: ver.settings.compactionThreshold ?? null,
      };
    }
  }

  // Try active version for this project
  if (tenantId) {
    const { ProjectSettingsVersion } = await import('@agent-platform/database/models');
    const active = await ProjectSettingsVersion.findOne(
      { projectId, tenantId, status: 'active' },
      { settings: 1 },
    ).lean();
    if (active?.settings) {
      return {
        enableThinking: active.settings.enableThinking,
        thinkingBudget: active.settings.thinkingBudget ?? null,
        thoughtDescription: active.settings.thoughtDescription ?? null,
        compactionThreshold: active.settings.compactionThreshold ?? null,
      };
    }
  }

  // Fall back to working copy (ProjectSettings)
  const { ProjectSettings } = await import('@agent-platform/database/models');
  const doc = await ProjectSettings.findOne(
    { projectId },
    { enableThinking: 1, thinkingBudget: 1, thoughtDescription: 1, compactionThreshold: 1 },
  ).lean();
  if (doc) {
    return {
      enableThinking: doc.enableThinking ?? undefined,
      thinkingBudget: doc.thinkingBudget ?? null,
      thoughtDescription: doc.thoughtDescription ?? null,
      compactionThreshold: doc.compactionThreshold ?? null,
    };
  }

  return undefined;
}

// ─── LLM Credentials ─────────────────────────────────────────────────────

export async function findDefaultUserCredential(
  userId: string,
  provider: string,
): Promise<any | null> {
  const { LLMCredential } = await import('@agent-platform/database/models');
  const providerLookup = buildProviderLookup(provider);
  // No .lean() — the encryption plugin decrypts encryptedApiKey/encryptedEndpoint
  // in a post-find hook. .lean() may skip hooks depending on Mongoose version.
  // Prefer isDefault=true, fall back to any active credential for this user+provider
  let cred = await LLMCredential.findOne({
    credentialScope: 'user',
    ownerId: userId,
    provider: providerLookup,
    isActive: true,
    isDefault: true,
  });
  if (!cred) {
    cred = await LLMCredential.findOne({
      credentialScope: 'user',
      ownerId: userId,
      provider: providerLookup,
      isActive: true,
    }).sort({ updatedAt: -1 });
  }
  return cred;
}

export async function findDefaultTenantCredential(
  tenantId: string,
  provider: string,
): Promise<any | null> {
  const { LLMCredential } = await import('@agent-platform/database/models');
  const providerLookup = buildProviderLookup(provider);
  // No .lean() — the encryption plugin decrypts encryptedApiKey/encryptedEndpoint
  // in a post-find hook. .lean() may skip hooks depending on Mongoose version.
  // Prefer isDefault=true, fall back to any active credential for this tenant+provider
  let cred = await LLMCredential.findOne({
    credentialScope: 'tenant',
    ownerId: tenantId,
    provider: providerLookup,
    isActive: true,
    isDefault: true,
  });
  if (!cred) {
    cred = await LLMCredential.findOne({
      credentialScope: 'tenant',
      ownerId: tenantId,
      provider: providerLookup,
      isActive: true,
    }).sort({ updatedAt: -1 });
  }
  return cred;
}

export async function findCredentialById(
  credentialId: string,
  tenantId: string,
  access?: {
    actorUserId?: string;
    includeTenantCredentials?: boolean;
  },
): Promise<any | null> {
  const { LLMCredential } = await import('@agent-platform/database/models');
  // No .lean() — the encryption plugin decrypts encryptedApiKey/encryptedEndpoint
  // in a post-find hook. .lean() may skip hooks depending on Mongoose version,
  // returning raw encrypted blobs instead of decrypted values.
  const filter: Record<string, unknown> = { _id: credentialId, tenantId };

  if (access) {
    const allowedOwners: Record<string, unknown>[] = [];
    if (access.includeTenantCredentials !== false) {
      allowedOwners.push({
        credentialScope: 'tenant',
        ownerId: tenantId,
      });
    }
    if (access.actorUserId) {
      allowedOwners.push({
        credentialScope: 'user',
        ownerId: access.actorUserId,
      });
    }

    if (allowedOwners.length === 0) {
      return null;
    }

    filter.$or = allowedOwners;
  }

  return LLMCredential.findOne(filter);
}
