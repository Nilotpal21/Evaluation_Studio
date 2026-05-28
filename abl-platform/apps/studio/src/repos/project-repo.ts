/**
 * Project Repository
 *
 * MongoDB repository for project, agent, and model config operations.
 */

import { randomUUID } from 'node:crypto';
import { ensureDb } from '@/lib/ensure-db';
import { deleteProjectMembersByProjectIds } from './project-member-repo';
import { computeProjectAgentDraftSourceHash } from '@agent-platform/project-io/project-agent-draft-metadata';
import { refreshPersistedStudioProjectAgentDraftMetadata } from '@/lib/abl/project-agent-draft-metadata';
import { buildProjectAgentPath } from '@agent-platform/shared';

function normalizeId<T extends { _id?: string; id?: string }>(doc: T | null): any {
  if (!doc) return null;
  const { _id, ...rest } = doc as any;
  return { ...rest, id: _id || rest.id };
}

function normalizeIds<T extends { _id?: string; id?: string }>(docs: T[]): any[] {
  return docs.map(normalizeId);
}

function shouldRefreshProjectAgentDraftMetadataAfterMutation(
  data: Record<string, unknown>,
): boolean {
  return (
    'dslContent' in data ||
    'name' in data ||
    'agentPath' in data ||
    'systemPromptLibraryRef' in data
  );
}

async function refreshProjectAgentDraftMetadataForProject(
  projectId: string,
  tenantId: string,
): Promise<void> {
  await refreshPersistedStudioProjectAgentDraftMetadata({
    projectId,
    tenantId,
  });
}

function computeProjectAgentMutationSourceHash(input: {
  recordName: string;
  currentDslContent?: string | null;
  nextDslContent?: string | null;
  currentSystemPromptLibraryRef?: unknown;
  nextSystemPromptLibraryRef?: unknown;
  systemPromptLibraryRefWasUpdated: boolean;
}): string | null {
  const dslContent =
    typeof input.nextDslContent === 'string'
      ? input.nextDslContent
      : (input.currentDslContent ?? null);
  const systemPromptLibraryRef = input.systemPromptLibraryRefWasUpdated
    ? (input.nextSystemPromptLibraryRef ?? null)
    : (input.currentSystemPromptLibraryRef ?? null);

  return computeProjectAgentDraftSourceHash({
    recordName: input.recordName,
    dslContent,
    systemPromptLibraryRef,
  });
}

function nextAgentVersionString(): string {
  return `draft-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

async function compileAgentVersionIrContent(dslContent: string): Promise<string> {
  try {
    const { parseAgentBasedABL } = await import('@abl/core');
    const { compileABLtoIR } = await import('@abl/compiler');
    const parsed = parseAgentBasedABL(dslContent);
    if (!parsed.document || parsed.errors.length > 0) {
      return JSON.stringify({ parseErrors: parsed.errors });
    }
    const compiled = compileABLtoIR([parsed.document], {
      mode: 'preview',
      skipCrossAgentValidation: true,
    });
    return JSON.stringify(compiled);
  } catch (err: unknown) {
    return JSON.stringify({ compileError: err instanceof Error ? err.message : String(err) });
  }
}

async function createAgentVersionSnapshot(input: {
  agentId: string;
  dslContent: string;
  sourceHash: string;
  createdBy: string;
  changelog: string;
}): Promise<void> {
  const { AgentVersion } = await import('@agent-platform/database/models');
  await AgentVersion.create({
    agentId: input.agentId,
    version: nextAgentVersionString(),
    status: 'draft',
    dslContent: input.dslContent,
    irContent: await compileAgentVersionIrContent(input.dslContent),
    sourceHash: input.sourceHash,
    changelog: input.changelog,
    createdBy: input.createdBy,
    toolSnapshot: null,
  });
}

function canonicalProjectAgentPath(projectId: unknown, agentName: unknown): string {
  return buildProjectAgentPath(String(projectId ?? ''), String(agentName ?? ''));
}

// =============================================================================
// PROJECT FUNCTIONS
// =============================================================================

/**
 * Find a project by ID and tenant (scoped lookup)
 */
export async function findProjectByIdAndTenant(id: string, tenantId: string): Promise<any | null> {
  await ensureDb();
  const { Project } = await import('@agent-platform/database/models');
  const doc = await Project.findOne({ _id: id, tenantId }).lean();
  return normalizeId(doc);
}

/**
 * Find a project by slug (tenant-scoped)
 */
export async function findProjectBySlug(slug: string, tenantId: string): Promise<any | null> {
  await ensureDb();
  const { Project } = await import('@agent-platform/database/models');
  const doc = await Project.findOne({ slug, tenantId }).lean();
  return normalizeId(doc);
}

/**
 * Find projects with optional filters and includes
 */
export async function findProjects(
  where: any,
  opts?: { include?: any; orderBy?: any; take?: number; skip?: number },
): Promise<any[]> {
  await ensureDb();
  const { Project } = await import('@agent-platform/database/models');

  // Convert where clause to MongoDB filter
  const filter: any = {};
  if (where.ownerId) filter.ownerId = where.ownerId;
  if (where.tenantId) filter.tenantId = where.tenantId;
  if (where.id) {
    if (where.id !== null && typeof where.id === 'object' && Array.isArray(where.id.in)) {
      filter._id = { $in: where.id.in };
    } else {
      filter._id = where.id;
    }
  }
  if (where.slug) filter.slug = where.slug;
  if (where.name) filter.name = where.name;

  // Handle OR conditions
  if (where.OR) {
    filter.$or = where.OR.map((cond: any) => {
      const orFilter: any = {};
      if (cond.ownerId) orFilter.ownerId = cond.ownerId;
      if (cond.tenantId) {
        if (cond.tenantId.in) {
          orFilter.tenantId = { $in: cond.tenantId.in };
        } else {
          orFilter.tenantId = cond.tenantId;
        }
      }
      if (cond.id) {
        if (cond.id !== null && typeof cond.id === 'object' && Array.isArray(cond.id.in)) {
          orFilter._id = { $in: cond.id.in };
        } else {
          orFilter._id = cond.id;
        }
      }
      return orFilter;
    });
  }

  let query = Project.find(filter);

  // Apply sorting
  if (opts?.orderBy) {
    const sort: any = {};
    if (opts.orderBy.updatedAt) {
      sort.updatedAt = opts.orderBy.updatedAt === 'desc' ? -1 : 1;
    }
    if (opts.orderBy.createdAt) {
      sort.createdAt = opts.orderBy.createdAt === 'desc' ? -1 : 1;
    }
    query = query.sort(sort);
  }

  // Apply pagination
  if (opts?.skip) query = query.skip(opts.skip);
  if (opts?.take) query = query.limit(opts.take);

  const docs = await query.lean();
  let results = normalizeIds(docs);

  // Handle includes separately
  if (opts?.include?._count) {
    const { ProjectAgent } = await import('@agent-platform/database/models');

    for (const result of results) {
      const agentCount = await ProjectAgent.countDocuments({ projectId: result.id });
      result._count = { agents: agentCount };
    }
  }

  return results;
}

/**
 * Create a new project
 */
export async function createProject(data: any): Promise<any> {
  await ensureDb();
  const { Project } = await import('@agent-platform/database/models');
  const doc = await Project.create(data);
  return normalizeId(doc.toObject());
}

/**
 * Update a project by ID (tenant-scoped)
 */
export async function updateProject(id: string, data: any, tenantId: string): Promise<any> {
  await ensureDb();
  const { Project } = await import('@agent-platform/database/models');
  const doc = await Project.findOneAndUpdate(
    { _id: id, tenantId },
    { $set: data },
    { new: true },
  ).lean();
  return normalizeId(doc);
}

/**
 * Archive a project (soft delete). Sets archivedAt/archivedBy.
 * Returns null if project not found or already archived.
 */
export async function archiveProject(
  id: string,
  tenantId: string,
  userId: string,
): Promise<any | null> {
  await ensureDb();
  const { Project } = await import('@agent-platform/database/models');
  const doc = await Project.findOneAndUpdate(
    { _id: id, tenantId, archivedAt: null },
    { $set: { archivedAt: new Date(), archivedBy: userId } },
    { new: true },
  ).lean();
  return normalizeId(doc);
}

/**
 * Restore an archived project. Clears archivedAt/archivedBy.
 * Returns null if project not found or not archived.
 */
export async function restoreProject(id: string, tenantId: string): Promise<any | null> {
  await ensureDb();
  const { Project } = await import('@agent-platform/database/models');
  const doc = await Project.findOneAndUpdate(
    { _id: id, tenantId, archivedAt: { $ne: null } },
    { $set: { archivedAt: null, archivedBy: null } },
    { new: true },
  ).lean();
  return normalizeId(doc);
}

/**
 * Delete a project by ID (tenant-scoped) with full cascade.
 * Verifies tenant ownership before cascading to children:
 * Sessions -> Messages -> Usage -> Attachments -> Events -> Agents -> etc.
 */
export async function deleteProject(id: string, tenantId: string): Promise<void> {
  await ensureDb();
  // Verify project belongs to tenant before cascade
  const { Project } = await import('@agent-platform/database/models');
  const project = await Project.findOne({ _id: id, tenantId }, { _id: 1 }).lean();
  if (!project) return;

  const { deleteProject: cascadeDeleteProject } = await import('@agent-platform/database/cascade');
  await cascadeDeleteProject(id);
}

/**
 * Count projects matching criteria
 */
export async function countProjects(where: any): Promise<number> {
  await ensureDb();
  const { Project } = await import('@agent-platform/database/models');

  // Convert where clause to MongoDB filter
  const filter: any = {};
  if (where.ownerId) filter.ownerId = where.ownerId;
  if (where.tenantId) filter.tenantId = where.tenantId;

  return Project.countDocuments(filter);
}

// =============================================================================
// PROJECT AGENT FUNCTIONS
// =============================================================================

/**
 * Find a project agent by ID (tenant-scoped via parent project join).
 * Note: This uses two queries (agent lookup, then project verification),
 * which has a narrow TOCTOU window if agents can be reassigned between
 * projects. This is read-only (information disclosure risk only); write
 * paths use projectId-scoped mutations to close the race.
 */
export async function findProjectAgentByIdAndTenant(
  id: string,
  tenantId: string,
): Promise<any | null> {
  await ensureDb();
  const { ProjectAgent, Project } = await import('@agent-platform/database/models');
  const agent = await ProjectAgent.findOne({ _id: id, tenantId }).lean();
  if (!agent) return null;
  const project = await Project.findOne(
    { _id: (agent as any).projectId, tenantId },
    { _id: 1 },
  ).lean();
  if (!project) return null;
  return normalizeId(agent);
}

/**
 * Find a project agent by projectId and name (tenant-scoped)
 */
export async function findProjectAgent(
  projectId: string,
  agentName: string,
  tenantId: string,
): Promise<any | null> {
  await ensureDb();
  const { ProjectAgent, Project } = await import('@agent-platform/database/models');
  // Verify project belongs to tenant
  const project = await Project.findOne({ _id: projectId, tenantId }, { _id: 1 }).lean();
  if (!project) return null;
  const doc = await ProjectAgent.findOne({ projectId, tenantId, name: agentName }).lean();
  return normalizeId(doc);
}

/**
 * Find all agents for a project
 */
export async function findProjectAgents(projectId: string, tenantId?: string): Promise<any[]> {
  await ensureDb();
  const { ProjectAgent } = await import('@agent-platform/database/models');
  const docs = await ProjectAgent.find({
    projectId,
    ...(tenantId ? { tenantId } : {}),
  })
    .sort({ name: 1 })
    .lean();
  return normalizeIds(docs);
}

/**
 * Create a new project agent
 */
export async function createProjectAgent(data: any): Promise<any> {
  await ensureDb();
  const { ProjectAgent } = await import('@agent-platform/database/models');
  const createData = { ...data };
  const agentVersionCreatedBy =
    typeof createData.agentVersionCreatedBy === 'string'
      ? createData.agentVersionCreatedBy
      : String(createData.ownerId ?? 'system');
  delete createData.agentVersionCreatedBy;
  if (typeof createData.name === 'string') {
    createData.name = createData.name.trim();
  }
  createData.agentPath = canonicalProjectAgentPath(createData.projectId, createData.name);
  const shouldRefreshDraftMetadata =
    shouldRefreshProjectAgentDraftMetadataAfterMutation(createData);
  if (typeof createData.dslContent === 'string' && createData.sourceHash === undefined) {
    createData.sourceHash = computeProjectAgentDraftSourceHash({
      recordName: String(createData.name ?? ''),
      dslContent: createData.dslContent,
      systemPromptLibraryRef: createData.systemPromptLibraryRef ?? null,
    });
  }
  const doc = await ProjectAgent.create(createData);
  if (typeof createData.dslContent === 'string') {
    await createAgentVersionSnapshot({
      agentId: String(doc._id),
      dslContent: createData.dslContent,
      sourceHash: String(createData.sourceHash ?? ''),
      createdBy: agentVersionCreatedBy,
      changelog: 'Created project agent DSL snapshot',
    });
  }
  if (!shouldRefreshDraftMetadata) {
    return normalizeId(doc.toObject());
  }

  await refreshProjectAgentDraftMetadataForProject(
    String(createData.projectId),
    String(createData.tenantId),
  );

  const refreshed = await ProjectAgent.findOne({
    _id: doc._id,
    projectId: createData.projectId,
    tenantId: createData.tenantId,
  }).lean();
  return normalizeId(refreshed ?? doc.toObject());
}

/**
 * Update a project agent by ID (tenant-scoped via parent project join).
 * Loads agent with findOne, verifies tenant via parent project, then updates atomically.
 */
export async function updateProjectAgent(id: string, data: any, tenantId: string): Promise<any> {
  await ensureDb();
  const { ProjectAgent, Project } = await import('@agent-platform/database/models');
  const agent = await ProjectAgent.findOne({ _id: id, tenantId }).lean();
  if (!agent) return null;
  const projectId = (agent as any).projectId;
  const project = await Project.findOne({ _id: projectId, tenantId }, { _id: 1 }).lean();
  if (!project) return null;
  const updateData = { ...data };
  const hasNameUpdate = typeof updateData.name === 'string';
  const hasAgentPathUpdate = Object.prototype.hasOwnProperty.call(updateData, 'agentPath');
  if (hasNameUpdate) {
    updateData.name = updateData.name.trim();
  }
  if (hasNameUpdate || hasAgentPathUpdate) {
    updateData.agentPath = canonicalProjectAgentPath(
      projectId,
      hasNameUpdate ? updateData.name : (agent as any).name,
    );
  }
  const agentVersionCreatedBy =
    typeof updateData.agentVersionCreatedBy === 'string'
      ? updateData.agentVersionCreatedBy
      : String((agent as any).ownerId ?? 'system');
  delete updateData.agentVersionCreatedBy;
  const shouldRefreshDraftMetadata =
    shouldRefreshProjectAgentDraftMetadataAfterMutation(updateData);
  if (updateData.sourceHash === undefined) {
    const systemPromptLibraryRefWasUpdated = Object.prototype.hasOwnProperty.call(
      updateData,
      'systemPromptLibraryRef',
    );
    const nextSourceHash = computeProjectAgentMutationSourceHash({
      recordName:
        typeof updateData.name === 'string' && updateData.name.length > 0
          ? updateData.name
          : String((agent as any).name ?? ''),
      currentDslContent:
        typeof (agent as any).dslContent === 'string' ? (agent as any).dslContent : null,
      nextDslContent: typeof updateData.dslContent === 'string' ? updateData.dslContent : null,
      currentSystemPromptLibraryRef: (agent as any).systemPromptLibraryRef ?? null,
      nextSystemPromptLibraryRef: updateData.systemPromptLibraryRef,
      systemPromptLibraryRefWasUpdated,
    });
    if (nextSourceHash !== null) {
      updateData.sourceHash = nextSourceHash;
    }
  }
  // Scope mutation to projectId to prevent TOCTOU if agent is reassigned between queries
  const doc = await ProjectAgent.findOneAndUpdate(
    { _id: id, projectId, tenantId },
    { $set: updateData },
    { new: true },
  ).lean();
  if (doc && typeof updateData.dslContent === 'string') {
    await createAgentVersionSnapshot({
      agentId: String((doc as any)._id ?? id),
      dslContent: updateData.dslContent,
      sourceHash: String((doc as any).sourceHash ?? updateData.sourceHash ?? ''),
      createdBy: agentVersionCreatedBy,
      changelog: 'Updated project agent DSL snapshot',
    });
  }
  if (!doc || !shouldRefreshDraftMetadata) {
    return normalizeId(doc);
  }

  await refreshProjectAgentDraftMetadataForProject(String(projectId), tenantId);

  const refreshed = await ProjectAgent.findOne({ _id: id, projectId, tenantId }).lean();
  return normalizeId(refreshed ?? doc);
}

/**
 * Delete a project agent by ID (tenant-scoped via parent project join).
 * Loads agent with findOne, verifies tenant via parent project, then deletes.
 */
export async function deleteProjectAgent(id: string, tenantId: string): Promise<void> {
  await ensureDb();
  const { ProjectAgent, Project } = await import('@agent-platform/database/models');
  const agent = await ProjectAgent.findOne({ _id: id, tenantId }).lean();
  if (!agent) return;
  const projectId = (agent as any).projectId;
  const project = await Project.findOne({ _id: projectId, tenantId }, { _id: 1 }).lean();
  if (!project) return;
  // Scope mutation to projectId to prevent TOCTOU if agent is reassigned between queries
  await ProjectAgent.deleteOne({ _id: id, projectId, tenantId });
  await refreshProjectAgentDraftMetadataForProject(String(projectId), tenantId);
}

// =============================================================================
// MODEL CONFIG FUNCTIONS
// =============================================================================

/**
 * Find model config(s) for a project, optionally filtered by agent name
 */
export async function findModelConfig(projectId: string, agentName?: string): Promise<any | null> {
  await ensureDb();
  const { ModelConfig } = await import('@agent-platform/database/models');
  const where: any = { projectId };
  if (agentName) where.name = agentName;
  const doc = await ModelConfig.findOne(where).lean();
  return normalizeId(doc);
}

/**
 * Find model configs matching criteria
 */
export async function findModelConfigs(where: any): Promise<any[]> {
  await ensureDb();
  const { ModelConfig } = await import('@agent-platform/database/models');

  // Convert where clause to MongoDB filter
  const filter: any = {};
  if (Array.isArray(where.scopedProjects) && where.scopedProjects.length > 0) {
    filter.$or = where.scopedProjects
      .map((entry: any) => ({
        projectId: entry.projectId,
        tenantId: entry.tenantId,
      }))
      .filter((entry: any) => entry.projectId && entry.tenantId);
  }
  if (where.projectId) {
    if (
      where.projectId !== null &&
      typeof where.projectId === 'object' &&
      Array.isArray(where.projectId.in)
    ) {
      filter.projectId = { $in: where.projectId.in };
    } else {
      filter.projectId = where.projectId;
    }
  }
  if (where.name) filter.name = where.name;
  if (where.tenantId && !filter.$or) filter.tenantId = where.tenantId;
  if (where.tier) filter.tier = where.tier;
  if (where.isDefault !== undefined) filter.isDefault = where.isDefault;

  const docs = await ModelConfig.find(filter).lean();
  return normalizeIds(docs);
}

/**
 * Create a new model config
 */
export async function createModelConfig(data: any): Promise<any> {
  await ensureDb();
  const { ModelConfig } = await import('@agent-platform/database/models');
  const doc = await ModelConfig.create(data);
  return normalizeId(doc.toObject());
}

/**
 * Update a model config by ID (tenant-scoped via parent project join).
 * Loads config with findOne, verifies tenant via parent project, then updates atomically.
 */
export async function updateModelConfig(id: string, data: any, tenantId: string): Promise<any> {
  await ensureDb();
  const { ModelConfig, Project } = await import('@agent-platform/database/models');
  const config = await ModelConfig.findOne({ _id: id, tenantId }).lean();
  if (!config) return null;
  const projectId = (config as any).projectId;
  const project = await Project.findOne({ _id: projectId, tenantId }, { _id: 1 }).lean();
  if (!project) return null;
  // Scope mutation to projectId to prevent TOCTOU if config is reassigned between queries
  const doc = await ModelConfig.findOneAndUpdate(
    { _id: id, projectId, tenantId },
    { $set: data },
    { new: true },
  ).lean();
  return normalizeId(doc);
}

/**
 * Delete a model config by ID (tenant-scoped via parent project join).
 * Loads config with findOne, verifies tenant via parent project, then deletes.
 */
export async function deleteModelConfig(id: string, tenantId: string): Promise<void> {
  await ensureDb();
  const { ModelConfig, Project } = await import('@agent-platform/database/models');
  const config = await ModelConfig.findOne({ _id: id, tenantId }).lean();
  if (!config) return;
  const projectId = (config as any).projectId;
  const project = await Project.findOne({ _id: projectId, tenantId }, { _id: 1 }).lean();
  if (!project) return;
  // Scope mutation to projectId to prevent TOCTOU if config is reassigned between queries
  await ModelConfig.deleteOne({ _id: id, projectId, tenantId });
}

// =============================================================================
// TENANT-SCOPED AGENT QUERIES (cross-project, for API routes)
// =============================================================================

/**
 * Find all project agents for a tenant, with project info attached.
 * Used by GET /api/agents.
 */
export async function findProjectAgentsByTenantId(
  tenantId: string,
  projectIds?: string[],
): Promise<any[]> {
  await ensureDb();
  const { Project, ProjectAgent } = await import('@agent-platform/database/models');

  if (!tenantId || (projectIds && projectIds.length === 0)) {
    return [];
  }

  const agentFilter: Record<string, unknown> = { tenantId };
  if (projectIds) {
    agentFilter.projectId = { $in: projectIds };
  }

  const agents = await ProjectAgent.find(agentFilter).sort({ name: 1 }).lean();

  // Enrich with project names
  const enrichedProjectIds = [...new Set(agents.map((a: any) => String(a.projectId)))];
  const projects = await Project.find({ _id: { $in: enrichedProjectIds }, tenantId })
    .select('_id name')
    .lean();
  const projectMap = new Map(
    projects.map((p: any) => [String(p._id), { id: String(p._id), name: p.name }]),
  );

  return agents.map((a: any) => {
    const proj = projectMap.get(String(a.projectId));
    return {
      ...a,
      id: a._id,
      project: proj || { id: String(a.projectId), name: 'Unknown' },
    };
  });
}

/**
 * Find a single project agent by name (project-scoped).
 * Used by GET /api/agents/:name.
 */
export async function findProjectAgentByName(
  name: string,
  tenantId: string,
  projectId: string,
): Promise<any | null> {
  await ensureDb();
  const { ProjectAgent } = await import('@agent-platform/database/models');

  const doc = await ProjectAgent.findOne({ name, tenantId, projectId }).lean();
  return normalizeId(doc);
}

/**
 * Find a model config by ID (tenant-scoped via parent project join).
 * Loads config with findOne, verifies tenant via parent project.
 * Used by GET/PATCH/DELETE /api/models/:id.
 */
export async function findModelConfigByIdAndTenant(
  id: string,
  tenantId: string,
): Promise<any | null> {
  await ensureDb();
  const { ModelConfig, Project } = await import('@agent-platform/database/models');
  const config = await ModelConfig.findOne({ _id: id, tenantId }).lean();
  if (!config) return null;
  const project = await Project.findOne(
    { _id: (config as any).projectId, tenantId },
    { _id: 1 },
  ).lean();
  if (!project) return null;
  return normalizeId(config);
}

/**
 * Clear isDefault on model configs in a project tier except the given ID.
 * Used by PATCH /api/models/:id when setting isDefault=true.
 */
export async function clearDefaultModelConfigs(
  projectId: string,
  excludeId: string,
  tier?: string,
  tenantId?: string,
): Promise<void> {
  await ensureDb();
  const { ModelConfig } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = { projectId, _id: { $ne: excludeId } };
  if (tenantId) {
    filter.tenantId = tenantId;
  }
  if (tier) {
    filter.tier = tier;
  }
  await ModelConfig.updateMany(filter, { $set: { isDefault: false } });
}

// =============================================================================
// PROJECT MEMBER FUNCTIONS
// =============================================================================

/**
 * Find all members of a project, with user details.
 */
export {
  createProjectMember,
  deleteProjectMember,
  findProjectMember,
  findProjectMembershipsByUserId,
  findProjectMembers,
  updateProjectMember,
} from './project-member-repo';

/**
 * Remove a user from all projects within a tenant.
 * Used during workspace member offboarding to prevent orphaned memberships.
 * Returns the count of project memberships removed.
 */
export async function removeUserFromTenantProjects(
  tenantId: string,
  userId: string,
): Promise<number> {
  await ensureDb();
  const { Project } = await import('@agent-platform/database/models');

  // Find all project IDs belonging to this tenant
  const projects = await Project.find({ tenantId }, { _id: 1 }).lean();
  if (projects.length === 0) return 0;

  const projectIds = projects.map((p: any) => p._id);
  return deleteProjectMembersByProjectIds(projectIds, userId);
}

// =============================================================================
// AGENT MODEL CONFIG FUNCTIONS
// =============================================================================

/**
 * Find agent model config for a specific project/agent combination
 */
export async function findAgentModelConfig(
  projectId: string,
  agentName: string,
  tenantId?: string,
): Promise<any | null> {
  await ensureDb();
  const { AgentModelConfig } = await import('@agent-platform/database/models');
  const doc = await AgentModelConfig.findOne({
    projectId,
    agentName,
    ...(tenantId ? { tenantId } : {}),
  }).lean();
  return normalizeId(doc);
}

/**
 * Upsert (create or update) agent model config
 */
export async function upsertAgentModelConfig(data: {
  tenantId?: string;
  projectId: string;
  agentName: string;
  [key: string]: any;
}): Promise<any> {
  await ensureDb();
  const { AgentModelConfig } = await import('@agent-platform/database/models');

  // Separate fields for MongoDB upsert pattern
  const { tenantId, projectId, agentName, ...updates } = data;

  const doc = await AgentModelConfig.findOneAndUpdate(
    { projectId, agentName, ...(tenantId ? { tenantId } : {}) },
    {
      $set: updates,
      $setOnInsert: { projectId, agentName, ...(tenantId ? { tenantId } : {}) },
    },
    { upsert: true, new: true },
  ).lean();

  return normalizeId(doc);
}
