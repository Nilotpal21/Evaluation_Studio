/**
 * Project Repository
 *
 * MongoDB functions for project, project agent,
 * and agent version operations.
 *
 * Used by: routes/project-agents.ts, routes/versions.ts, routes/agents.ts,
 *          routes/agent-model-config.ts, services/version-service.ts
 */

import { TTLCache } from '../utils/ttl-cache.js';
import {
  evaluateRuntimeProjectAgentDrafts,
  mergeProjectAgentDraftStates,
} from '../services/session/project-agent-draft-metadata.js';
import type { ProjectToolType } from '@agent-platform/database/models';

// =============================================================================
// Hot-path caches — project and member lookups happen on every request
// (via rbac middleware). Cache avoids repeated MongoDB round-trips.
//
// Invalidation: The runtime never mutates Project or ProjectMember records
// (Studio/Admin own those). TTL expiry (60s) is sufficient for consistency.
// If a project or member is changed in Studio, the runtime sees the update
// within 60 seconds at most.
// =============================================================================

const projectCache = new TTLCache<Record<string, unknown> | null>({
  maxSize: 500,
  ttlMs: 5_000,
});

const memberCache = new TTLCache<Record<string, unknown> | null>({
  maxSize: 1000,
  ttlMs: 5_000,
});

// =============================================================================
// 0. Tenant verification helper
// =============================================================================

async function verifyAgentTenant(agentId: string, tenantId: string): Promise<boolean> {
  const { ProjectAgent } = await import('@agent-platform/database/models');
  const agent = await ProjectAgent.findOne({ _id: agentId, tenantId }, { _id: 1 }).lean();
  return !!agent;
}

// =============================================================================
// 1. findProjectByIdAndTenant (cached)
// =============================================================================

export async function findProjectByIdAndTenant(id: string, tenantId: string) {
  const cacheKey = `${id}:${tenantId}`;
  const cached = projectCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const { Project } = await import('@agent-platform/database/models');
  const doc = await Project.findOne({ _id: id, tenantId }).lean();
  const result = doc ?? null;
  projectCache.set(cacheKey, result);
  return result;
}

// =============================================================================
// 1b. findProjectMember (cached)
// =============================================================================

/**
 * Look up a user's project membership record.
 * Returns null if the user is not a member of the project.
 */
export async function findProjectMember(projectId: string, userId: string) {
  const cacheKey = `${projectId}:${userId}`;
  const cached = memberCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const { ProjectMember } = await import('@agent-platform/database/models');
  const doc = await ProjectMember.findOne({ projectId, userId }).lean();
  const result = doc ?? null;
  memberCache.set(cacheKey, result);
  return result;
}

// =============================================================================
// 2. findProjectWithAgents
// =============================================================================

type ProjectAgentReference = { name: string };

type ProjectWithAgentsForEntryResolution = {
  entryAgentName?: string | null;
  agents: ProjectAgentReference[];
};

export function resolveProjectEntryAgentName(
  project: ProjectWithAgentsForEntryResolution,
  requestedAgentName?: string | null,
): string {
  if (requestedAgentName) {
    const requestedAgent = project.agents.find((agent) => agent.name === requestedAgentName);
    if (requestedAgent) {
      return requestedAgent.name;
    }
  }

  if (project.entryAgentName) {
    const configuredEntryAgent = project.agents.find(
      (agent) => agent.name === project.entryAgentName,
    );
    if (configuredEntryAgent) {
      return configuredEntryAgent.name;
    }
  }

  return project.agents[0].name;
}

export async function findProjectWithAgents(id: string, tenantId: string) {
  const { Project, ProjectAgent } = await import('@agent-platform/database/models');
  const project = await Project.findOne({ _id: id, tenantId }).lean();
  if (!project) return null;
  const agents = await ProjectAgent.find({ projectId: id, tenantId }).sort({ createdAt: 1 }).lean();
  return { ...project, agents };
}

export async function findProjectRuntimeConfig(
  projectId: string,
  tenantId: string,
): Promise<Record<string, unknown> | null> {
  const { ProjectRuntimeConfig } = await import('@agent-platform/database/models');
  const runtimeConfig = await ProjectRuntimeConfig.findOne({ projectId, tenantId }).lean();
  return runtimeConfig ?? null;
}

export async function findProjectLLMConfig(
  projectId: string,
  tenantId: string,
): Promise<Record<string, unknown> | null> {
  const { ProjectLLMConfig } = await import('@agent-platform/database/models');
  const llmConfig = await ProjectLLMConfig.findOne({ projectId, tenantId }).lean();
  return llmConfig ?? null;
}

// =============================================================================
// 3. findProjectAgentByPath
// =============================================================================

export async function findProjectAgentByPath(
  agentPath: string,
  tenantId?: string,
  options?: { projectId?: string },
) {
  if (!tenantId) return null;
  const { ProjectAgent } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = { agentPath, tenantId };
  if (options?.projectId) {
    filter.projectId = options.projectId;
  }
  const doc = await ProjectAgent.findOne(filter).lean();
  return doc ?? null;
}

// =============================================================================
// 4. findProjectAgentByName
// =============================================================================

export async function findProjectAgentByName(
  name: string,
  options?: { tenantId?: string; projectId?: string },
) {
  if (!options?.tenantId) return null;
  const { ProjectAgent } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = { name, tenantId: options.tenantId };
  if (options.projectId) {
    filter.projectId = options.projectId;
  }
  const doc = await ProjectAgent.findOne(filter).select('-irContent').lean();
  return doc ?? null;
}

// =============================================================================
// 5. findProjectAgentsForProject
// =============================================================================

export async function findProjectAgentsForProject(
  projectId: string,
  options?: { includeVersionCount?: boolean; includeDSLContent?: boolean; tenantId?: string },
) {
  const { ProjectAgent, AgentVersion } = await import('@agent-platform/database/models');
  const selectFields = options?.includeDSLContent ? '-irContent' : '-dslContent -irContent';
  const filter: Record<string, string> = { projectId };
  if (options?.tenantId) filter.tenantId = options.tenantId;
  const agents = await ProjectAgent.find(filter).select(selectFields).sort({ name: 1 }).lean();

  if (options?.includeVersionCount) {
    const agentIds = agents.map((a: any) => a.id ?? a._id);
    const counts = await AgentVersion.aggregate([
      { $match: { agentId: { $in: agentIds } } },
      { $group: { _id: '$agentId', count: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map((c: any) => [c._id, c.count]));
    return agents.map((a: any) => ({
      ...a,
      _count: { versions: countMap.get(a.id ?? a._id) ?? 0 },
    }));
  }

  return agents;
}

// =============================================================================
// 6. findProjectAgentForProject
// =============================================================================

export async function findProjectAgentForProject(
  projectId: string,
  agentName: string,
  tenantId?: string,
  options?: { includeTenantId?: boolean; includeVersionCount?: boolean },
) {
  if (tenantId) {
    const { Project } = await import('@agent-platform/database/models');
    const project = await Project.findOne({ _id: projectId, tenantId }, { _id: 1 }).lean();
    if (!project) return null;
  }
  const { ProjectAgent, AgentVersion } = await import('@agent-platform/database/models');
  const agentFilter: Record<string, string> = { projectId, name: agentName };
  if (tenantId) {
    agentFilter.tenantId = tenantId;
  }
  const agent = await ProjectAgent.findOne(agentFilter).lean();
  if (!agent) return null;

  let project: { tenantId: string | null } | undefined;
  if (options?.includeTenantId) {
    const { Project } = await import('@agent-platform/database/models');
    const projectFilter: Record<string, string> = { _id: projectId };
    if (tenantId) {
      projectFilter.tenantId = tenantId;
    }
    const p = await Project.findOne(projectFilter, { tenantId: 1 }).lean();
    project = p ? { tenantId: (p as any).tenantId } : undefined;
  }

  let versionCount: number | undefined;
  if (options?.includeVersionCount) {
    versionCount = await AgentVersion.countDocuments({
      agentId: (agent as any).id ?? (agent as any)._id,
    });
  }

  return {
    ...agent,
    ...(project !== undefined ? { project } : {}),
    ...(versionCount !== undefined ? { _count: { versions: versionCount } } : {}),
  };
}

// =============================================================================
// 7. findProjectAgentsWithTenant
// =============================================================================

export async function findProjectAgentsWithTenant(options: { tenantId?: string }) {
  if (!options.tenantId) return [];

  const { ProjectAgent, Project } = await import('@agent-platform/database/models');

  const agents = await ProjectAgent.find({ tenantId: options.tenantId }).sort({ name: 1 }).lean();

  // Enrich with project name for display
  const projectIds = [...new Set(agents.map((a: any) => a.projectId))];
  const projects = await Project.find({ _id: { $in: projectIds } }, { _id: 1, name: 1 }).lean();
  const projectMap = new Map(
    projects.map((p: any) => [p.id ?? p._id, { name: p.name, id: p.id ?? p._id }]),
  );

  return agents.map((a: any) => ({
    ...a,
    project: projectMap.get(a.projectId) ?? { name: '', id: a.projectId },
  }));
}

// =============================================================================
// 8. updateProjectAgentDsl
// =============================================================================

export async function updateProjectAgentDsl(
  agentId: string,
  dslContent: string,
  tenantId?: string,
) {
  const { ProjectAgent } = await import('@agent-platform/database/models');
  const filter: Record<string, string> = { _id: agentId };
  if (tenantId) {
    filter.tenantId = tenantId;
  }

  const agent = await ProjectAgent.findOne(filter).lean();
  if (!agent) {
    return null;
  }

  const projectId = String((agent as any).projectId ?? '');
  const resolvedTenantId = String((agent as any).tenantId ?? tenantId ?? '');
  const currentAgents = (await ProjectAgent.find({
    projectId,
    tenantId: resolvedTenantId,
  }).lean()) as Array<{
    _id: string;
    name: string;
    dslContent: string | null;
    systemPromptLibraryRef?: {
      promptId: string;
      versionId: string;
      resolvedHash?: string;
    } | null;
  }>;

  const metadataByAgent = await evaluateRuntimeProjectAgentDrafts({
    projectId,
    tenantId: resolvedTenantId,
    agents: mergeProjectAgentDraftStates(currentAgents, [
      {
        recordName: String((agent as any).name ?? ''),
        dslContent,
        systemPromptLibraryRef: (agent as any).systemPromptLibraryRef ?? null,
      },
    ]),
    diagnosticSource: 'runtime-dsl-save',
    configVariables: await loadConfigVariablesMap(projectId, resolvedTenantId),
  });

  await ProjectAgent.bulkWrite(
    currentAgents.map((currentAgent) => {
      const metadata = metadataByAgent.get(String(currentAgent.name));
      return {
        updateOne: {
          filter: {
            _id: currentAgent._id,
            projectId,
            tenantId: resolvedTenantId,
          },
          update: {
            $set: {
              ...(String(currentAgent._id) === String((agent as any)._id) ? { dslContent } : {}),
              sourceHash: metadata?.sourceHash ?? null,
              dslValidationStatus: metadata?.dslValidationStatus ?? null,
              dslDiagnostics: metadata?.dslDiagnostics ?? [],
            },
          },
        },
      };
    }),
  );

  const doc = await ProjectAgent.findOne(filter).lean();
  return doc ?? null;
}

// =============================================================================
// 9. findAgentVersion
// =============================================================================

export async function findAgentVersion(agentId: string, version: string, tenantId?: string) {
  if (tenantId) {
    const verified = await verifyAgentTenant(agentId, tenantId);
    if (!verified) return null;
  }
  const { AgentVersion } = await import('@agent-platform/database/models');
  const doc = await AgentVersion.findOne({ agentId, version }).lean();
  return doc ?? null;
}

// =============================================================================
// 10. listAgentVersions / countAgentVersions
// =============================================================================

export async function listAgentVersions(
  agentId: string,
  opts?: { skip?: number; take?: number; tenantId?: string },
) {
  if (opts?.tenantId) {
    const verified = await verifyAgentTenant(agentId, opts.tenantId);
    if (!verified) return [];
  }
  const skip = opts?.skip ?? 0;
  const take = opts?.take ?? 50;

  const { AgentVersion } = await import('@agent-platform/database/models');
  const docs = await AgentVersion.find({ agentId })
    .select('-irContent -dslContent')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(take)
    .lean();
  return docs;
}

export async function countAgentVersions(agentId: string): Promise<number> {
  const { AgentVersion } = await import('@agent-platform/database/models');
  return AgentVersion.countDocuments({ agentId });
}

// =============================================================================
// 11. createAgentVersion
// =============================================================================

export async function createAgentVersion(data: {
  agentId: string;
  version: string;
  dslContent: string;
  irContent?: string;
  sourceHash?: string;
  changelog?: string;
  createdBy: string;
  status?: string;
  tenantId?: string;
  toolSnapshot?: Array<{
    name: string;
    projectToolId: string;
    sourceHash: string;
    runtimeMetadataHash?: string;
    toolType: ProjectToolType;
    description: string | null;
    dslContent: string;
  }>;
}) {
  if (data.tenantId) {
    const verified = await verifyAgentTenant(data.agentId, data.tenantId);
    if (!verified) return null;
  }
  const { AgentVersion } = await import('@agent-platform/database/models');
  const doc = await AgentVersion.create({
    agentId: data.agentId,
    version: data.version,
    status: data.status ?? 'draft',
    dslContent: data.dslContent,
    irContent: data.irContent ?? '',
    sourceHash: data.sourceHash ?? '',
    changelog: data.changelog ?? null,
    createdBy: data.createdBy,
    toolSnapshot: data.toolSnapshot ?? null,
  });
  // Return lean-compatible object with `id`
  const obj = doc.toObject();
  if (obj._id != null && (obj as any).id == null) {
    (obj as any).id = obj._id;
  }
  return obj as any;
}

// =============================================================================
// 12. findLatestAgentVersion
// =============================================================================

export async function findLatestAgentVersion(agentId: string, tenantId?: string) {
  if (tenantId) {
    const verified = await verifyAgentTenant(agentId, tenantId);
    if (!verified) return null;
  }
  const { AgentVersion } = await import('@agent-platform/database/models');
  const doc = await AgentVersion.findOne({ agentId }).sort({ createdAt: -1 }).lean();
  return doc ?? null;
}

// =============================================================================
// 13. getAllAgentVersionNumbers
// =============================================================================

export async function getAllAgentVersionNumbers(agentId: string): Promise<string[]> {
  const { AgentVersion } = await import('@agent-platform/database/models');
  const docs = await AgentVersion.find({ agentId }, { version: 1 }).lean();
  return docs.map((d: any) => d.version);
}

// =============================================================================
// 14. promoteAgentVersion
// =============================================================================

export async function promoteAgentVersion(params: {
  id: string;
  currentStatus: string;
  newStatus: string;
  promotedBy: string;
  tenantId?: string;
}): Promise<{ count: number }> {
  const { id, currentStatus, newStatus, promotedBy, tenantId } = params;
  const now = new Date();

  // Verify tenant ownership before promoting
  if (tenantId) {
    const { AgentVersion } = await import('@agent-platform/database/models');
    const version = await AgentVersion.findOne({ _id: id }, { agentId: 1 }).lean();
    if (!version) return { count: 0 };
    const verified = await verifyAgentTenant((version as any).agentId, tenantId);
    if (!verified) return { count: 0 };
  }

  const { AgentVersion } = await import('@agent-platform/database/models');
  const result = await AgentVersion.updateOne(
    { _id: id, status: currentStatus },
    { $set: { status: newStatus, promotedAt: now, promotedBy } },
  );
  return { count: result.modifiedCount };
}

// =============================================================================
// 15. updateProjectAgentActiveVersions
// =============================================================================

export async function updateProjectAgentActiveVersions(
  agentId: string,
  activeVersions: Record<string, string>,
  tenantId: string,
  projectId: string,
) {
  // Verify tenant ownership before updating active versions
  const verified = await verifyAgentTenant(agentId, tenantId);
  if (!verified) return null;
  const { ProjectAgent } = await import('@agent-platform/database/models');
  return ProjectAgent.findOneAndUpdate(
    { _id: agentId, tenantId, projectId },
    { $set: { activeVersions } },
  );
}

// =============================================================================
// 16. findAgentModelConfig
// =============================================================================

export async function findAgentModelConfig(
  projectId: string,
  agentName: string,
  tenantId?: string,
) {
  if (tenantId) {
    const { Project } = await import('@agent-platform/database/models');
    const project = await Project.findOne({ _id: projectId, tenantId }, { _id: 1 }).lean();
    if (!project) return null;
  }
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
  return doc ?? null;
}

// =============================================================================
// 17. upsertAgentModelConfig
// =============================================================================

export async function upsertAgentModelConfig(params: {
  projectId: string;
  agentName: string;
  defaultModel?: string | null;
  operationModels?: Record<string, string> | null;
  temperature?: number | null;
  maxTokens?: number | null;
  hyperParameters?: Record<string, unknown> | null;
  useResponsesApi?: boolean | null;
  useStreaming?: boolean | null;
  tenantId?: string;
}) {
  const {
    projectId,
    agentName,
    defaultModel,
    operationModels,
    temperature,
    maxTokens,
    hyperParameters,
    useResponsesApi,
    useStreaming,
    tenantId,
  } = params;

  if (tenantId) {
    const { Project } = await import('@agent-platform/database/models');
    const project = await Project.findOne({ _id: projectId, tenantId }, { _id: 1 }).lean();
    if (!project) return null;
  }

  const setFields: Record<string, unknown> = {};
  if (defaultModel !== undefined) {
    setFields.defaultModel = defaultModel ?? null;
  }
  if (operationModels !== undefined) {
    setFields.operationModels = operationModels ?? null;
  }
  if (temperature !== undefined) {
    setFields.temperature = temperature ?? null;
  }
  if (maxTokens !== undefined) {
    setFields.maxTokens = maxTokens ?? null;
  }
  if (hyperParameters !== undefined) {
    setFields.hyperParameters = hyperParameters ?? null;
  }
  if (useResponsesApi !== undefined) {
    setFields.useResponsesApi = useResponsesApi ?? null;
  }
  if (useStreaming !== undefined) {
    setFields.useStreaming = useStreaming ?? null;
  }

  if (Object.keys(setFields).length === 0) {
    return findAgentModelConfig(projectId, agentName, tenantId);
  }

  const { AgentModelConfig } = await import('@agent-platform/database/models');
  const filter = { projectId, agentName, ...(tenantId ? { tenantId } : {}) };
  const setOnInsert = { projectId, agentName, ...(tenantId ? { tenantId } : {}) };
  const doc = await AgentModelConfig.findOneAndUpdate(
    filter,
    {
      $set: setFields,
      $setOnInsert: setOnInsert,
    },
    { upsert: true, new: true },
  ).lean();
  return doc;
}

// =============================================================================
// 18. loadConfigVariablesMap
// =============================================================================

/**
 * Load project config variables as a key-value map for compile-time resolution.
 * Returns an empty object when the project has no config variables.
 */
export async function loadConfigVariablesMap(
  projectId: string,
  tenantId: string,
): Promise<Record<string, string>> {
  const { ProjectConfigVariable } = await import('@agent-platform/database/models');
  const docs = await ProjectConfigVariable.find(
    { projectId, tenantId },
    { key: 1, value: 1 },
  ).lean();
  const map: Record<string, string> = {};
  for (const doc of docs) {
    map[(doc as any).key] = (doc as any).value;
  }
  return map;
}

// =============================================================================
// 19. loadEnvVariablesMap
// =============================================================================

/**
 * Load project environment variables as a key-value map for compile-time resolution.
 * Loads base (null environment) and dev environment variables, with dev overriding base.
 * Returns decrypted plaintext values suitable for {{env.KEY}} substitution.
 */
export async function loadEnvVariablesMap(
  projectId: string,
  tenantId: string,
  environment: string | null = null,
): Promise<Record<string, string>> {
  const { EnvironmentVariable } = await import('@agent-platform/database/models');
  const docs = await EnvironmentVariable.find({
    projectId,
    tenantId,
    environment: { $in: [environment, null] },
  }).lean();
  // Deduplicate: environment-specific overrides base (null)
  const map: Record<string, string> = {};
  const envSpecific: Record<string, string> = {};
  for (const doc of docs as any[]) {
    if (doc.environment === null) {
      map[doc.key] = doc.encryptedValue;
    } else {
      envSpecific[doc.key] = doc.encryptedValue;
    }
  }
  // Env-specific wins
  Object.assign(map, envSpecific);
  return map;
}
