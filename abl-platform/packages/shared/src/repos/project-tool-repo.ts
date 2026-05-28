/**
 * Project Tool Repository
 *
 * CRUD operations for the `project_tools` collection (DSL-native tools).
 * Every function requires tenantId + projectId for isolation — never use findById().
 *
 * Used by: Studio (CRUD routes), Compiler (batch resolution), Runtime (tool loading)
 */

import type { IProjectTool } from '@agent-platform/database/models';
import { normalizeDocument } from '../utils/normalize.js';
import type { PaginatedResponse } from '../types/repo-types.js';
import {
  isProjectToolType,
  prepareProjectToolDslForPersistence,
  rewriteToolDslSignatureName,
} from '../tools/project-tool-persistence.js';

// ─── Constants ───────────────────────────────────────────────────────────

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

// ─── Types ───────────────────────────────────────────────────────────────

type NormalizedProjectTool = IProjectTool & { id: string };

function normalize(doc: IProjectTool | null): NormalizedProjectTool | null {
  return normalizeDocument(doc) as NormalizedProjectTool | null;
}

// ─── Auth-profile resolution helper ──────────────────────────────────────

/**
 * Extract the `auth_profile: <name>` literal from a tool DSL. The DSL format
 * is line-based YAML-like; the value may be optionally double-quoted. Returns
 * null when the line is absent or unparseable.
 *
 * We don't use parseDslToToolForm here because its return is a tagged union
 * and `authProfileRef` only exists on the http variant, so it forces an
 * awkward narrow + null-check; a single regex covers every tool type
 * uniformly (non-http variants simply never have the line, so the regex
 * returns null).
 */
function extractAuthProfileName(dslContent: string): string | null {
  if (typeof dslContent !== 'string' || dslContent.length === 0) return null;
  const match = dslContent.match(/^[\t ]*auth_profile:[\t ]*"?([^"\r\n]+?)"?[\t ]*$/m);
  if (!match) return null;
  const name = match[1].trim();
  return name.length > 0 ? name : null;
}

/**
 * Resolve a tool's DSL `auth_profile: <name>` reference to the matching
 * AuthProfile._id within the same tenant + project (or the tenant-scoped
 * sibling when the auth-profile row has `projectId: null`).
 *
 * Returns `null` when the DSL has no auth_profile, the parse fails, or the
 * named profile doesn't exist. Resolution failures NEVER block tool save —
 * the DSL remains the source of truth at runtime, and `authProfileId` is
 * purely a denormalized field for efficient consumer-count queries on auth
 * profiles.
 */
async function resolveAuthProfileIdFromDsl(
  tenantId: string,
  projectId: string,
  dslContent: string,
): Promise<string | null> {
  const profileName = extractAuthProfileName(dslContent);
  if (!profileName) return null;

  try {
    const { AuthProfile } = await import('@agent-platform/database/models');
    // Match the auth-profile lookup convention used by the project list route:
    // project-scoped profiles in this project plus tenant-inherited profiles.
    const profile = await AuthProfile.findOne({
      tenantId,
      name: profileName,
      $or: [{ projectId }, { projectId: null }],
    })
      .select({ _id: 1 })
      .lean();
    return profile?._id ? String(profile._id) : null;
  } catch {
    return null;
  }
}

// ─── Find ────────────────────────────────────────────────────────────────

export async function findProjectToolById(
  id: string,
  tenantId: string,
  projectId: string,
): Promise<NormalizedProjectTool | null> {
  const { ProjectTool } = await import('@agent-platform/database/models');
  const doc = await ProjectTool.findOne({ _id: id, tenantId, projectId }).lean();
  return normalize(doc);
}

export async function findProjectToolsByProject(
  tenantId: string,
  projectId: string,
  opts?: {
    toolType?: string;
    search?: string;
    sort?: string;
    order?: 'asc' | 'desc';
    page?: number;
    limit?: number;
  },
): Promise<PaginatedResponse<NormalizedProjectTool>> {
  const { ProjectTool } = await import('@agent-platform/database/models');

  const page = Math.max(1, opts?.page || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, opts?.limit || DEFAULT_PAGE_SIZE));
  const sortField = opts?.sort || 'updatedAt';
  const sortOrder = opts?.order === 'asc' ? 1 : -1;

  const match: Record<string, unknown> = { tenantId, projectId };
  if (opts?.toolType) match['toolType'] = opts.toolType;
  if (opts?.search) {
    const escapedSearch = opts.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    match['name'] = { $regex: escapedSearch, $options: 'i' };
  }

  const [docs, total] = await Promise.all([
    ProjectTool.find(match)
      .sort({ [sortField]: sortOrder })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    ProjectTool.countDocuments(match),
  ]);

  const data = docs.map(normalize).filter((d): d is NormalizedProjectTool => d !== null);

  return {
    data,
    pagination: { page, limit, total, hasMore: page * limit < total },
  };
}

export async function findProjectToolByName(
  tenantId: string,
  projectId: string,
  name: string,
): Promise<NormalizedProjectTool | null> {
  const { ProjectTool } = await import('@agent-platform/database/models');
  const doc = await ProjectTool.findOne({ tenantId, projectId, name }).lean();
  return normalize(doc);
}

// ─── Create ──────────────────────────────────────────────────────────────

export async function createProjectTool(data: {
  tenantId: string;
  projectId: string;
  name: string;
  slug: string;
  toolType: string;
  description: string | null;
  dslContent: string;
  sourceHash: string;
  variableNamespaceIds?: string[];
  createdBy: string;
}): Promise<NormalizedProjectTool> {
  const { ProjectTool } = await import('@agent-platform/database/models');

  if (data.slug.length < 2) {
    throw new Error('Tool slug must be at least 2 characters');
  }

  if (!isProjectToolType(data.toolType)) {
    throw new Error(`Unsupported project tool type "${data.toolType}"`);
  }

  const prepared = prepareProjectToolDslForPersistence({
    tenantId: data.tenantId,
    projectId: data.projectId,
    name: data.name,
    toolType: data.toolType,
    dslContent: data.dslContent,
  });
  if (!prepared.valid) {
    throw new Error(prepared.message);
  }

  const authProfileId = await resolveAuthProfileIdFromDsl(
    data.tenantId,
    data.projectId,
    prepared.dslContent,
  );

  const doc = await ProjectTool.create({
    tenantId: data.tenantId,
    projectId: data.projectId,
    name: data.name,
    slug: data.slug,
    toolType: data.toolType,
    description: data.description,
    dslContent: prepared.dslContent,
    sourceHash: prepared.sourceHash,
    variableNamespaceIds: data.variableNamespaceIds ?? [],
    authProfileId,
    createdBy: data.createdBy,
  });

  const normalized = normalize(doc.toObject());
  if (!normalized) {
    throw new Error('Failed to normalize newly created project tool - data integrity error');
  }
  return normalized;
}

// ─── Update ──────────────────────────────────────────────────────────────

export async function updateProjectTool(
  id: string,
  tenantId: string,
  projectId: string,
  data: {
    name?: string;
    description?: string | null;
    dslContent?: string;
    sourceHash?: string;
    variableNamespaceIds?: string[];
    lastEditedBy?: string;
  },
): Promise<NormalizedProjectTool | null> {
  const { ProjectTool } = await import('@agent-platform/database/models');

  // Build $set payload — only include fields that were explicitly provided
  const setData: Record<string, unknown> = {};
  if (data.name !== undefined) setData.name = data.name;
  if (data.description !== undefined) setData.description = data.description;
  if (data.variableNamespaceIds !== undefined)
    setData.variableNamespaceIds = data.variableNamespaceIds;
  if (data.lastEditedBy !== undefined) setData.lastEditedBy = data.lastEditedBy;

  const shouldValidateDsl =
    data.name !== undefined || data.dslContent !== undefined || data.sourceHash !== undefined;
  if (shouldValidateDsl) {
    const existing = await ProjectTool.findOne({ _id: id, tenantId, projectId }).lean();
    if (!existing) return null;
    if (!isProjectToolType(existing.toolType)) {
      throw new Error(`Unsupported project tool type "${existing.toolType}"`);
    }

    const nextName = data.name ?? existing.name;
    const nextDslContent =
      data.dslContent ??
      (data.name !== undefined && data.name !== existing.name
        ? rewriteToolDslSignatureName(existing.dslContent, data.name)
        : existing.dslContent);
    const prepared = prepareProjectToolDslForPersistence({
      tenantId,
      projectId,
      name: nextName,
      toolType: existing.toolType,
      dslContent: nextDslContent,
    });
    if (!prepared.valid) {
      throw new Error(prepared.message);
    }

    setData.dslContent = prepared.dslContent;
    setData.sourceHash = prepared.sourceHash;

    // Re-resolve authProfileId from the new DSL so the denormalized field
    // stays in sync with auth_profile changes (added, removed, or renamed).
    setData.authProfileId = await resolveAuthProfileIdFromDsl(
      tenantId,
      projectId,
      prepared.dslContent,
    );
  }

  const doc = await ProjectTool.findOneAndUpdate(
    { _id: id, tenantId, projectId },
    { $set: setData },
    { new: true },
  ).lean();

  return normalize(doc);
}

// ─── Delete ──────────────────────────────────────────────────────────────

export async function deleteProjectTool(
  id: string,
  tenantId: string,
  projectId: string,
): Promise<boolean> {
  const { ProjectTool } = await import('@agent-platform/database/models');
  const result = await ProjectTool.findOneAndDelete({ _id: id, tenantId, projectId });
  return result !== null;
}

// ─── Count ───────────────────────────────────────────────────────────────

export async function countProjectToolsByProject(
  tenantId: string,
  projectId: string,
): Promise<number> {
  const { ProjectTool } = await import('@agent-platform/database/models');
  return ProjectTool.countDocuments({ tenantId, projectId });
}

// ─── Batch ───────────────────────────────────────────────────────────────

export async function findProjectToolsByNames(
  tenantId: string,
  projectId: string,
  names: string[],
): Promise<NormalizedProjectTool[]> {
  const { ProjectTool } = await import('@agent-platform/database/models');

  if (names.length === 0) return [];

  const docs = await ProjectTool.find({
    tenantId,
    projectId,
    name: { $in: names },
  }).lean();

  return docs.map(normalize).filter((d): d is NormalizedProjectTool => d !== null);
}
