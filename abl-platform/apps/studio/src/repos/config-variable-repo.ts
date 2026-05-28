/**
 * Config Variable Repository
 *
 * MongoDB repository for project-level config variables (compile-time {{config.KEY}}).
 */

import { ensureDb } from '@/lib/ensure-db';
import { refreshProjectAgentDraftMetadataForConfigMutation } from '@/lib/project-config-draft-invalidation';

// =============================================================================
// HELPER: Normalize MongoDB _id to id
// =============================================================================

function normalizeId<T extends { _id?: string; id?: string }>(doc: T | null): any {
  if (!doc) return null;
  const { _id, ...rest } = doc as any;
  return { ...rest, id: _id || rest.id };
}

function normalizeIds<T extends { _id?: string; id?: string }>(docs: T[]): any[] {
  return docs.map(normalizeId);
}

// =============================================================================
// CONFIG VARIABLE FUNCTIONS
// =============================================================================

/**
 * Find all config variables for a project
 */
export async function findConfigVariablesByProject(
  projectId: string,
  tenantId: string,
): Promise<any[]> {
  await ensureDb();
  const { ProjectConfigVariable } = await import('@agent-platform/database/models');
  const docs = await ProjectConfigVariable.find({ projectId, tenantId }).sort({ key: 1 }).lean();
  return normalizeIds(docs);
}

/**
 * Find a config variable by ID (tenant-scoped)
 */
// TODO(isolation): make projectId required after all callers updated
export async function findConfigVariableById(
  id: string,
  tenantId: string,
  projectId?: string,
): Promise<any | null> {
  await ensureDb();
  const { ProjectConfigVariable } = await import('@agent-platform/database/models');
  const query: Record<string, unknown> = { _id: id, tenantId };
  if (projectId) query.projectId = projectId;
  const doc = await ProjectConfigVariable.findOne(query).lean();
  return normalizeId(doc);
}

/**
 * Find a config variable by project and key
 */
export async function findConfigVariableByKey(
  projectId: string,
  key: string,
  tenantId: string,
): Promise<any | null> {
  await ensureDb();
  const { ProjectConfigVariable } = await import('@agent-platform/database/models');
  const doc = await ProjectConfigVariable.findOne({ projectId, key, tenantId }).lean();
  return normalizeId(doc);
}

/**
 * Create a new config variable
 */
export async function createConfigVariable(data: {
  tenantId: string;
  projectId: string;
  key: string;
  value: string;
  description?: string;
  createdBy: string;
}): Promise<any> {
  await ensureDb();
  const { ProjectConfigVariable } = await import('@agent-platform/database/models');
  const doc = await ProjectConfigVariable.create(data);
  await refreshProjectAgentDraftMetadataForConfigMutation({
    projectId: String(data.projectId),
    tenantId: String(data.tenantId),
  });
  return normalizeId(doc.toObject());
}

/**
 * Update a config variable by ID (tenant-scoped)
 */
export async function updateConfigVariable(
  id: string,
  tenantId: string,
  data: { value?: string; description?: string | null; updatedBy: string },
  projectId?: string,
): Promise<any> {
  await ensureDb();
  const { ProjectConfigVariable } = await import('@agent-platform/database/models');
  // Build $set payload — only include fields that were explicitly provided
  const updates: Record<string, unknown> = { updatedBy: data.updatedBy };
  if (data.value !== undefined) updates.value = data.value;
  if ('description' in data) updates.description = data.description;
  const query: Record<string, unknown> = { _id: id, tenantId };
  if (projectId) query.projectId = projectId;
  const doc = await ProjectConfigVariable.findOneAndUpdate(
    query,
    { $set: updates },
    { new: true },
  ).lean();
  const refreshedProjectId =
    typeof doc?.projectId === 'string' ? doc.projectId : (projectId ?? null);
  if (doc && refreshedProjectId) {
    await refreshProjectAgentDraftMetadataForConfigMutation({
      projectId: refreshedProjectId,
      tenantId,
    });
  }
  return normalizeId(doc);
}

/**
 * Delete a config variable by ID (tenant-scoped)
 */
export async function deleteConfigVariable(
  id: string,
  tenantId: string,
  projectId?: string,
): Promise<void> {
  await ensureDb();
  const { ProjectConfigVariable } = await import('@agent-platform/database/models');
  const query: Record<string, unknown> = { _id: id, tenantId };
  if (projectId) query.projectId = projectId;
  const deleted = await ProjectConfigVariable.findOneAndDelete(query);
  const refreshedProjectId =
    typeof deleted?.projectId === 'string' ? deleted.projectId : (projectId ?? null);
  if (deleted && refreshedProjectId) {
    await refreshProjectAgentDraftMetadataForConfigMutation({
      projectId: refreshedProjectId,
      tenantId,
    });
  }
}

/**
 * Delete all config variables for a project (cleanup on project deletion)
 */
export async function deleteConfigVariablesByProject(
  projectId: string,
  tenantId: string,
): Promise<void> {
  await ensureDb();
  const { ProjectConfigVariable } = await import('@agent-platform/database/models');
  await ProjectConfigVariable.deleteMany({ projectId, tenantId });
}

/**
 * Count config variables for a project
 */
export async function countConfigVariables(projectId: string, tenantId: string): Promise<number> {
  await ensureDb();
  const { ProjectConfigVariable } = await import('@agent-platform/database/models');
  return ProjectConfigVariable.countDocuments({ projectId, tenantId });
}
