/**
 * Project Service
 *
 * Business logic for project and agent management.
 */

import {
  buildProjectAgentPath as buildCanonicalProjectAgentPath,
  slugify,
} from '@agent-platform/shared';
import { rewriteProjectAgentDraftDeclaredName } from '@agent-platform/project-io/project-agent-draft-metadata';
import {
  findProjectBySlug,
  findProjects,
  createProject as createProjectRepo,
  updateProject as updateProjectRepo,
  deleteProject as deleteProjectRepo,
  findProjectByIdAndTenant,
  findProjectAgents,
  findProjectMembershipsByUserId,
  createProjectAgent,
  createProjectMember,
  findProjectAgentByIdAndTenant,
  updateProjectAgent,
  deleteProjectAgent,
} from '@/repos/project-repo';
import { hasPermission, resolveStudioPermissions } from '@/lib/permission-resolver';
import { findTenantMembershipsByUserId } from '@/repos/workspace-repo';
import { AppError, ErrorCodes } from '@agent-platform/shared/errors';

// =============================================================================
// TYPES
// =============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Project = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProjectAgent = any;
type TenantMembership = {
  tenantId: string;
  role?: string | null;
  customRoleId?: string | null;
};

const TENANT_ADMIN_ROLES = new Set(['OWNER', 'ADMIN']);
const TENANT_ADMIN_BYPASS_PERMISSION = 'project:*';
const PROJECT_LIST_QUERY_OPTIONS = {
  include: {
    _count: {
      select: {
        agents: true,
      },
    },
  },
  orderBy: { updatedAt: 'desc' as const },
};

export interface CreateProjectInput {
  name: string;
  slug?: string;
  description?: string;
  ownerId: string;
  tenantId: string;
  channels?: string[];
  language?: string;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  entryAgentName?: string | null;
  messageRetentionDays?: number | null;
  language?: string;
}

export interface CreateAgentInput {
  projectId: string;
  tenantId: string;
  name: string;
  agentPath?: string;
  description?: string;
  dslContent?: string | null;
  ownerId?: string | null;
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

async function hasTenantWideProjectAccess(
  userId: string,
  membership: TenantMembership,
): Promise<boolean> {
  if (typeof membership.role === 'string' && TENANT_ADMIN_ROLES.has(membership.role)) {
    return true;
  }

  if (typeof membership.role !== 'string' || membership.role.length === 0) {
    return false;
  }

  const permissions = await resolveStudioPermissions(
    membership.tenantId,
    userId,
    membership.role,
    membership.customRoleId ?? null,
  );

  return hasPermission(permissions, TENANT_ADMIN_BYPASS_PERMISSION);
}

// =============================================================================
// SLUG HELPERS
// =============================================================================

/**
 * Ensure slug is unique within the tenant scope.
 * Checks uniqueness per-tenant (composite unique).
 */
async function ensureUniqueSlug(
  baseSlug: string,
  tenantId: string,
  excludeId?: string,
): Promise<string> {
  let slug = baseSlug;
  let suffix = 0;

  while (true) {
    const existing = await findProjectBySlug(slug, tenantId);

    if (!existing || existing.id === excludeId) {
      return slug;
    }

    suffix++;
    slug = `${baseSlug}-${suffix}`;
  }
}

// =============================================================================
// PROJECT FUNCTIONS
// =============================================================================

/**
 * Create a new project
 */
export async function createProject(input: CreateProjectInput): Promise<Project> {
  const baseSlug = input.slug || slugify(input.name);
  const slug = await ensureUniqueSlug(baseSlug, input.tenantId);

  const project = await createProjectRepo({
    name: input.name,
    slug,
    description: input.description,
    ownerId: input.ownerId,
    ...(input.tenantId && { tenantId: input.tenantId }),
    ...(input.channels && { channels: input.channels }),
    ...(input.language && { language: input.language }),
  });

  // Auto-create default namespace for the new project
  try {
    const { VariableNamespace } = await import('@agent-platform/database/models');
    const { DEFAULT_VARIABLE_NAMESPACE_NAME, DEFAULT_VARIABLE_NAMESPACE_DISPLAY_NAME } =
      await import('@abl/compiler/platform/constants.js');
    await VariableNamespace.create({
      tenantId: input.tenantId,
      projectId: project.id,
      name: DEFAULT_VARIABLE_NAMESPACE_NAME,
      displayName: DEFAULT_VARIABLE_NAMESPACE_DISPLAY_NAME,
      isDefault: true,
      order: 0,
      createdBy: input.ownerId,
    });
  } catch (err) {
    // Non-blocking: don't fail project creation if namespace creation fails
    const { createLogger } = await import('@abl/compiler/platform/logger.js');
    const logger = createLogger('project-service');
    logger.error('Failed to create default namespace for project', {
      projectId: project.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Auto-add the creator as a project admin member
  try {
    await createProjectMember({
      projectId: project.id,
      userId: input.ownerId,
      role: 'admin',
      customRoleId: null,
    });
  } catch (err) {
    // Non-blocking: don't fail project creation if member creation fails
    const { createLogger } = await import('@abl/compiler/platform/logger.js');
    const logger = createLogger('project-service');
    logger.error('Failed to auto-add creator as project member', {
      projectId: project.id,
      userId: input.ownerId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return project;
}

/**
 * Get a project by ID (tenant-scoped)
 */
export async function getProjectById(id: string, tenantId: string): Promise<Project | null> {
  return findProjectByIdAndTenant(id, tenantId);
}

/**
 * Get a project by slug (tenant-scoped)
 */
export async function getProjectBySlug(slug: string, tenantId: string): Promise<Project | null> {
  return findProjectBySlug(slug, tenantId);
}

/**
 * Check if a project with the given name exists in the tenant
 */
export async function projectExistsByName(name: string, tenantId: string): Promise<boolean> {
  const results = await findProjects({ name, tenantId }, { take: 1 });
  return results.length > 0;
}

/**
 * Get all projects for a user
 */
export async function getUserProjects(userId: string): Promise<Project[]> {
  return findProjects({ ownerId: userId }, { orderBy: { updatedAt: 'desc' } });
}

/**
 * Update a project (tenant-scoped)
 */
export async function updateProject(
  id: string,
  input: UpdateProjectInput,
  tenantId: string,
): Promise<Project> {
  return updateProjectRepo(id, input, tenantId);
}

/**
 * Delete a project (tenant-scoped)
 */
export async function deleteProject(id: string, tenantId: string): Promise<void> {
  await deleteProjectRepo(id, tenantId);
}

/**
 * Get project with agent count and session count (tenant-scoped)
 */
export async function getProjectWithCounts(id: string, tenantId: string) {
  const project = await findProjects(
    { id, tenantId },
    {
      include: {
        _count: {
          select: {
            agents: true,
          },
        },
      },
    },
  );

  return project[0] || null;
}

/**
 * Get all projects with counts for a user.
 * When tenantId is provided, results are scoped to that tenant.
 * Otherwise, returns projects the user owns, projects in admin-managed tenants,
 * or projects explicitly shared with them.
 */
export async function getUserProjectsWithCounts(userId: string, tenantId?: string) {
  const tenantMemberships = await findTenantMembershipsByUserId(userId, {
    select: { tenantId: true, role: true, customRoleId: true },
  });
  const tenantIds = uniqueValues(
    tenantMemberships.map((membership: TenantMembership) => membership.tenantId),
  );

  if (tenantId) {
    if (!tenantIds.includes(tenantId)) {
      return [];
    }

    const tenantMembership = tenantMemberships.find(
      (membership: TenantMembership) => membership.tenantId === tenantId,
    );
    if (!tenantMembership) {
      return [];
    }

    if (await hasTenantWideProjectAccess(userId, tenantMembership)) {
      return findProjects({ tenantId }, PROJECT_LIST_QUERY_OPTIONS);
    }

    const sharedProjectIds = uniqueValues(
      (await findProjectMembershipsByUserId(userId)).map(
        (membership: { projectId: string }) => membership.projectId,
      ),
    );

    if (sharedProjectIds.length === 0) {
      return findProjects({ tenantId, ownerId: userId }, PROJECT_LIST_QUERY_OPTIONS);
    }

    return findProjects(
      {
        tenantId,
        OR: [{ ownerId: userId }, { id: { in: sharedProjectIds } }],
      },
      PROJECT_LIST_QUERY_OPTIONS,
    );
  }

  const membershipAccess = await Promise.all(
    tenantMemberships.map(async (membership: TenantMembership) => ({
      membership,
      hasTenantWideAccess: await hasTenantWideProjectAccess(userId, membership),
    })),
  );
  const adminTenantIds = uniqueValues(
    membershipAccess
      .filter((entry) => entry.hasTenantWideAccess)
      .map((entry) => entry.membership.tenantId),
  );
  const memberTenantIds = uniqueValues(
    membershipAccess
      .filter((entry) => !entry.hasTenantWideAccess)
      .map((entry) => entry.membership.tenantId),
  );
  const sharedProjectIds =
    memberTenantIds.length > 0
      ? uniqueValues(
          (await findProjectMembershipsByUserId(userId)).map(
            (membership: { projectId: string }) => membership.projectId,
          ),
        )
      : [];

  const projectFilters: Array<Record<string, unknown>> = [{ ownerId: userId }];

  if (adminTenantIds.length > 0) {
    projectFilters.push({ tenantId: { in: adminTenantIds } });
  }

  if (memberTenantIds.length > 0 && sharedProjectIds.length > 0) {
    projectFilters.push({
      tenantId: { in: memberTenantIds },
      id: { in: sharedProjectIds },
    });
  }

  return findProjects({ OR: projectFilters }, PROJECT_LIST_QUERY_OPTIONS);
}

// =============================================================================
// PROJECT AGENT FUNCTIONS
// =============================================================================

/**
 * Add an agent to a project
 */
export function buildProjectAgentPath(projectId: string, agentName: string): string {
  return buildCanonicalProjectAgentPath(projectId, agentName);
}

export async function addAgentToProject(input: CreateAgentInput): Promise<ProjectAgent> {
  const normalizedName = input.name.trim();
  const project = await findProjectByIdAndTenant(input.projectId, input.tenantId);
  if (!project) {
    throw new AppError(`Project ${input.projectId} not found for tenant`, {
      ...ErrorCodes.NOT_FOUND,
    });
  }

  return createProjectAgent({
    projectId: input.projectId,
    tenantId: input.tenantId,
    name: normalizedName,
    agentPath: buildProjectAgentPath(input.projectId, normalizedName),
    ...(input.description !== undefined && { description: input.description }),
    ...(input.dslContent !== undefined && { dslContent: input.dslContent }),
    ...(input.ownerId !== undefined && { ownerId: input.ownerId }),
  });
}

/**
 * Get agents in a project (tenant-scoped)
 */
export async function getProjectAgents(
  projectId: string,
  tenantId: string,
): Promise<ProjectAgent[]> {
  // Verify project belongs to tenant before returning agents
  const project = await findProjectByIdAndTenant(projectId, tenantId);
  if (!project) return [];
  return findProjectAgents(projectId, tenantId);
}

/**
 * Get a specific agent by ID (tenant-scoped)
 */
export async function getAgentById(id: string, tenantId: string): Promise<ProjectAgent | null> {
  return findProjectAgentByIdAndTenant(id, tenantId);
}

/**
 * Update an agent (tenant-scoped)
 */
export async function updateAgent(
  id: string,
  input: {
    name?: string;
    description?: string;
    systemPromptLibraryRef?:
      | ({ promptId: string; versionId: string; resolvedHash?: string } & Record<string, unknown>)
      | null;
  },
  tenantId: string,
): Promise<ProjectAgent> {
  const update: {
    name?: string;
    agentPath?: string;
    description?: string;
    dslContent?: string;
    systemPromptLibraryRef?:
      | ({ promptId: string; versionId: string; resolvedHash?: string } & Record<string, unknown>)
      | null;
  } = { ...input };

  if (typeof input.name === 'string') {
    const normalizedName = input.name.trim();
    update.name = normalizedName;
    const existing = await findProjectAgentByIdAndTenant(id, tenantId);
    if (!existing) return null;
    update.agentPath = buildProjectAgentPath(existing.projectId, normalizedName);
    const rewrite = rewriteProjectAgentDraftDeclaredName({
      recordName: existing.name,
      nextName: normalizedName,
      dslContent: typeof existing.dslContent === 'string' ? existing.dslContent : null,
    });
    if (!rewrite.ok) {
      throw new AppError(rewrite.message ?? 'Agent DSL identity does not match the record name', {
        ...ErrorCodes.CONFLICT,
        code: rewrite.code ?? ErrorCodes.CONFLICT.code,
      });
    }
    if (typeof rewrite.dslContent === 'string' && rewrite.dslContent !== existing.dslContent) {
      update.dslContent = rewrite.dslContent;
    }
  }

  return updateProjectAgent(id, update, tenantId);
}

/**
 * Remove an agent from a project (tenant-scoped)
 */
export async function removeAgentFromProject(id: string, tenantId: string): Promise<void> {
  await deleteProjectAgent(id, tenantId);
}

// =============================================================================
// SESSION FUNCTIONS
// =============================================================================

/**
 * Create a session linked to a project and user (tenant-scoped)
 */
export async function createSession(
  projectId: string,
  agentName: string,
  userId: string,
  tenantId: string,
): Promise<any> {
  const project = await findProjectByIdAndTenant(projectId, tenantId);
  if (!project) {
    throw new AppError(`Project ${projectId} not found for tenant`, {
      ...ErrorCodes.INTERNAL_ERROR,
    });
  }

  const { Session } = await import('@agent-platform/database/models');
  const doc = await Session.create({
    tenantId,
    projectId,
    initiatedById: userId,
    currentAgent: agentName,
    agentVersion: '1.0.0',
    channel: 'web_chat',
  });
  const plain = doc.toObject();
  return { ...plain, id: plain._id };
}

/**
 * Get sessions for a project
 */
export async function getProjectSessions(
  projectId: string,
  options: {
    limit?: number;
    offset?: number;
    tenantId?: string;
    userId?: string;
    isAdmin?: boolean;
  } = {},
): Promise<any[]> {
  const { limit = 50, offset = 0, tenantId, userId, isAdmin } = options;

  const { Session } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = { projectId };
  if (tenantId) filter.tenantId = tenantId;

  // User-level isolation: non-admin users see only their own sessions
  if (userId && !isAdmin) {
    filter.initiatedById = userId;
  }

  const docs = await Session.find(filter)
    .sort({ lastActivityAt: -1 })
    .skip(offset)
    .limit(limit)
    .lean();
  return docs.map((doc: any) => ({ ...doc, id: doc._id }));
}

/**
 * Get sessions for a user
 */
export async function getUserSessions(
  userId: string,
  options: { limit?: number; offset?: number; tenantId?: string } = {},
): Promise<any[]> {
  const { limit = 50, offset = 0, tenantId } = options;

  const { Session } = await import('@agent-platform/database/models');
  const filter: Record<string, unknown> = { initiatedById: userId };
  if (tenantId) filter.tenantId = tenantId;

  const docs = await Session.find(filter)
    .sort({ lastActivityAt: -1 })
    .skip(offset)
    .limit(limit)
    .lean();
  return docs.map((doc: any) => ({ ...doc, id: doc._id }));
}

/**
 * Update session last active time
 */
export async function updateSessionActivity(id: string, tenantId: string): Promise<void> {
  const { Session } = await import('@agent-platform/database/models');
  await Session.findOneAndUpdate({ _id: id, tenantId }, { $set: { lastActivityAt: new Date() } });
}
