/**
 * Workspace Repository
 *
 * MongoDB repository for workspace/tenant operations.
 */

import { ensureDb } from '@/lib/ensure-db';
import { AppError, ErrorCodes } from '@agent-platform/shared/errors';
import { withTransaction } from '@agent-platform/shared/repos';
import type mongoose from 'mongoose';

const DEFAULT_ACTIVE_TENANT_STATUSES = ['active'];
const DEFAULT_ACTIVE_TENANT_MEMBER_STATUSES = ['active'];

type FindTenantMemberOptions = {
  tenantStatuses?: string[];
  memberStatuses?: string[];
};

type FindTenantMembershipsByUserIdOptions = {
  select?: Record<string, boolean>;
  tenantStatuses?: string[];
  memberStatuses?: string[];
};

function buildTenantMemberStatusFilter(statuses: string[]): Record<string, unknown> {
  const normalized = [...new Set(statuses)];
  const includesActive = normalized.includes('active');
  const explicitStatuses = normalized.filter((status) => status !== 'active');
  const clauses: Record<string, unknown>[] = [];

  if (includesActive) {
    clauses.push({ status: 'active' }, { status: { $exists: false } });
  }

  if (explicitStatuses.length > 0) {
    clauses.push({ status: { $in: explicitStatuses } });
  }

  if (clauses.length === 0) {
    return { status: { $in: normalized } };
  }

  return clauses.length === 1 ? clauses[0] : { $or: clauses };
}

async function seedWorkspaceOperationalDefaults(
  tenantId: string,
  createdBy: string,
  session?: mongoose.ClientSession | null,
): Promise<void> {
  const [{ seedTenantBootstrapDefaults }, { seedTenantPipelineConfigs }] = await Promise.all([
    import('@agent-platform/database'),
    import('@agent-platform/pipeline-engine'),
  ]);

  await seedTenantBootstrapDefaults({ tenantId, createdBy, session });
  await seedTenantPipelineConfigs({ tenantId, createdBy, session });
}

function normalizeTenantMemberDoc(doc: any): any {
  return { ...doc, id: doc._id };
}

async function findAllowedTenantIds(
  tenantIds: string[],
  tenantStatuses: string[],
): Promise<Set<string>> {
  if (tenantIds.length === 0) {
    return new Set();
  }

  const { Tenant } = await import('@agent-platform/database/models');
  const tenants = await Tenant.find({
    _id: { $in: [...new Set(tenantIds)] },
    status: { $in: tenantStatuses },
  })
    .select({ _id: 1 })
    .lean();

  return new Set(tenants.map((tenant: any) => String(tenant._id)));
}

// ─── Tenant Operations ───────────────────────────────────────────────────

// Tenant lookup by its own _id, which IS the tenantId. findOne({_id}) is correct here.
export async function findTenantById(id: string): Promise<any | null> {
  await ensureDb();
  const { Tenant } = await import('@agent-platform/database/models');
  const doc = await Tenant.findOne({ _id: id }).lean();
  if (!doc) return null;
  return { ...doc, id: doc._id };
}

export async function findTenantBySlug(slug: string): Promise<any | null> {
  await ensureDb();
  const { Tenant } = await import('@agent-platform/database/models');
  const doc = await Tenant.findOne({ slug }).lean();
  if (!doc) return null;
  return { ...doc, id: doc._id };
}

export async function createTenant(data: {
  name: string;
  slug: string;
  ownerId: string;
  organizationId?: string | null;
  retentionDays?: number;
  settings?: any;
  status?: string;
}): Promise<any> {
  await ensureDb();
  const { Tenant } = await import('@agent-platform/database/models');
  const doc = await Tenant.create({
    name: data.name,
    slug: data.slug,
    ownerId: data.ownerId,
    organizationId: data.organizationId ?? null,
    retentionDays: data.retentionDays ?? 7,
    settings: data.settings ?? null,
    status: data.status ?? 'active',
  });
  const plain = doc.toObject();
  await seedWorkspaceOperationalDefaults(String(plain._id), data.ownerId);
  return { ...plain, id: plain._id };
}

export async function updateTenant(
  id: string,
  data: {
    name?: string;
    slug?: string;
    ownerId?: string;
    organizationId?: string | null;
    retentionDays?: number;
    settings?: any;
    status?: string;
  },
): Promise<any> {
  await ensureDb();
  const { Tenant } = await import('@agent-platform/database/models');
  // Tenant update by its own _id (which IS the tenantId).
  const doc = await Tenant.findOneAndUpdate(
    { _id: id },
    { $set: data },
    { new: true, runValidators: true },
  ).lean();
  if (!doc) throw new AppError('Tenant not found', { ...ErrorCodes.NOT_FOUND });
  return { ...doc, id: doc._id };
}

/**
 * Archive a workspace (soft delete via status). Sets status='archived'.
 * Also archives all active projects in the workspace.
 * Returns null if tenant not found or already archived.
 */
export async function archiveWorkspace(
  id: string,
  userId: string,
): Promise<{ tenant: any; projectsArchived: number } | null> {
  await ensureDb();
  const { Tenant } = await import('@agent-platform/database/models');
  const { Project } = await import('@agent-platform/database/models');

  const doc = await Tenant.findOneAndUpdate(
    { _id: id, status: { $ne: 'archived' } },
    { $set: { status: 'archived' } },
    { new: true, runValidators: true },
  ).lean();
  if (!doc) return null;

  // Cascade: archive all non-archived projects in this workspace
  const now = new Date();
  const projectResult = await Project.updateMany(
    { tenantId: id, archivedAt: null },
    { $set: { archivedAt: now, archivedBy: userId } },
  );

  return {
    tenant: { ...doc, id: doc._id },
    projectsArchived: projectResult.modifiedCount,
  };
}

/**
 * Restore an archived workspace. Sets status='active'.
 * Also restores all projects that were archived by the workspace archive cascade.
 * Returns null if tenant not found or not archived.
 */
export async function restoreWorkspace(
  id: string,
): Promise<{ tenant: any; projectsRestored: number } | null> {
  await ensureDb();
  const { Tenant } = await import('@agent-platform/database/models');
  const { Project } = await import('@agent-platform/database/models');

  const doc = await Tenant.findOneAndUpdate(
    { _id: id, status: 'archived' },
    { $set: { status: 'active' } },
    { new: true, runValidators: true },
  ).lean();
  if (!doc) return null;

  // Cascade: restore projects that belong to this workspace
  const projectResult = await Project.updateMany(
    { tenantId: id, archivedAt: { $ne: null } },
    { $set: { archivedAt: null, archivedBy: null } },
  );

  return {
    tenant: { ...doc, id: doc._id },
    projectsRestored: projectResult.modifiedCount,
  };
}

export async function findTenantsForOrganization(
  orgId: string,
  opts?: { status?: string; limit?: number; offset?: number },
): Promise<any[]> {
  await ensureDb();
  const { Tenant } = await import('@agent-platform/database/models');
  const filter: any = { organizationId: orgId };
  if (opts?.status) {
    filter.status = opts.status;
  }
  let query = Tenant.find(filter).sort({ createdAt: -1 });
  if (opts?.limit) {
    query = query.limit(opts.limit);
  }
  if (opts?.offset) {
    query = query.skip(opts.offset);
  }
  const docs = await query.lean();
  return docs.map((doc: any) => ({ ...doc, id: doc._id }));
}

// ─── Tenant Member Operations ────────────────────────────────────────────

export async function createTenantMember(data: {
  tenantId: string;
  userId: string;
  role: string;
  customRoleId?: string | null;
}): Promise<any> {
  await ensureDb();
  const { TenantMember } = await import('@agent-platform/database/models');
  const doc = await TenantMember.create({
    tenantId: data.tenantId,
    userId: data.userId,
    role: data.role,
    customRoleId: data.customRoleId ?? null,
  });
  const plain = doc.toObject();
  return { ...plain, id: plain._id };
}

export async function findTenantMember(
  tenantId: string,
  userId: string,
  opts?: FindTenantMemberOptions,
): Promise<any | null> {
  await ensureDb();
  const { TenantMember } = await import('@agent-platform/database/models');
  const memberStatuses = opts?.memberStatuses ?? DEFAULT_ACTIVE_TENANT_MEMBER_STATUSES;
  const tenantStatuses = opts?.tenantStatuses ?? DEFAULT_ACTIVE_TENANT_STATUSES;
  const doc = await TenantMember.findOne({
    tenantId,
    userId,
    ...buildTenantMemberStatusFilter(memberStatuses),
  }).lean();
  if (!doc) return null;

  const allowedTenantIds = await findAllowedTenantIds([tenantId], tenantStatuses);
  if (!allowedTenantIds.has(String(tenantId))) {
    return null;
  }

  return normalizeTenantMemberDoc(doc);
}

export async function findTenantMembers(
  tenantId: string,
  opts?: { includeUser?: boolean },
): Promise<any[]> {
  await ensureDb();
  const { TenantMember, User } = await import('@agent-platform/database/models');
  const docs = await TenantMember.find({ tenantId }).lean();

  if (opts?.includeUser) {
    // Manual join: fetch users and merge
    const userIds = docs.map((doc: any) => doc.userId);
    const users = await User.find({ _id: { $in: userIds } }).lean();
    const userMap = new Map(users.map((u: any) => [u._id, { ...u, id: u._id }]));

    return docs.map((doc: any) => ({
      ...doc,
      id: doc._id,
      user: userMap.get(doc.userId) || null,
    }));
  }

  return docs.map((doc: any) => ({ ...doc, id: doc._id }));
}

export async function updateTenantMember(
  tenantId: string,
  userId: string,
  data: { role?: string; customRoleId?: string | null; status?: string },
): Promise<any> {
  await ensureDb();
  const { TenantMember } = await import('@agent-platform/database/models');
  const doc = await TenantMember.findOneAndUpdate(
    { tenantId, userId },
    { $set: data },
    { new: true, runValidators: true },
  ).lean();
  if (!doc) throw new AppError('TenantMember not found', { ...ErrorCodes.NOT_FOUND });
  return { ...doc, id: doc._id };
}

export async function deleteTenantMember(tenantId: string, userId: string): Promise<void> {
  await ensureDb();
  const { TenantMember } = await import('@agent-platform/database/models');
  await TenantMember.deleteOne({ tenantId, userId });
}

export async function findTenantMembershipsByUserId(
  userId: string,
  opts?: FindTenantMembershipsByUserIdOptions,
): Promise<any[]> {
  await ensureDb();
  const { TenantMember } = await import('@agent-platform/database/models');
  const memberStatuses = opts?.memberStatuses ?? DEFAULT_ACTIVE_TENANT_MEMBER_STATUSES;
  const tenantStatuses = opts?.tenantStatuses ?? DEFAULT_ACTIVE_TENANT_STATUSES;
  const projection = opts?.select ? { ...opts.select, tenantId: true } : undefined;
  let query = TenantMember.find({
    userId,
    ...buildTenantMemberStatusFilter(memberStatuses),
  });

  if (projection) {
    query = query.select(projection);
  }

  const docs = await query.lean();
  const allowedTenantIds = await findAllowedTenantIds(
    docs.map((doc: any) => String(doc.tenantId)),
    tenantStatuses,
  );

  return docs
    .filter((doc: any) => allowedTenantIds.has(String(doc.tenantId)))
    .map((doc: any) => normalizeTenantMemberDoc(doc));
}

export async function countTenantMembers(tenantId: string): Promise<number> {
  await ensureDb();
  const { TenantMember } = await import('@agent-platform/database/models');
  return TenantMember.countDocuments({ tenantId });
}

/**
 * Find a tenant member by userId with role filtering.
 * Used by SSO admin routes to verify OWNER/ADMIN access.
 */
export async function findTenantMemberByUserIdAndRoles(
  userId: string,
  roles: string[],
): Promise<any | null> {
  await ensureDb();
  const { TenantMember } = await import('@agent-platform/database/models');
  const docs = await TenantMember.find({
    userId,
    role: { $in: roles },
    ...buildTenantMemberStatusFilter(DEFAULT_ACTIVE_TENANT_MEMBER_STATUSES),
  })
    .sort({ createdAt: 1 })
    .lean();

  const allowedTenantIds = await findAllowedTenantIds(
    docs.map((doc: any) => String(doc.tenantId)),
    DEFAULT_ACTIVE_TENANT_STATUSES,
  );
  const membership = docs.find((doc: any) => allowedTenantIds.has(String(doc.tenantId)));

  return membership ? normalizeTenantMemberDoc(membership) : null;
}

// ─── Workspace Invitation Operations ─────────────────────────────────────

export async function createInvitation(data: {
  tenantId: string;
  email: string;
  role: string;
  invitedBy: string | null;
  token: string;
  expiresAt: Date;
  status?: string;
}): Promise<any> {
  await ensureDb();
  const { WorkspaceInvitation } = await import('@agent-platform/database/models');
  const doc = await WorkspaceInvitation.create({
    tenantId: data.tenantId,
    email: data.email,
    role: data.role,
    invitedBy: data.invitedBy,
    token: data.token,
    expiresAt: data.expiresAt,
    status: data.status ?? 'pending',
  });
  const plain = doc.toObject();
  return { ...plain, id: plain._id };
}

export async function findInvitationById(id: string, tenantId?: string): Promise<any | null> {
  await ensureDb();
  const { WorkspaceInvitation } = await import('@agent-platform/database/models');
  const query: Record<string, unknown> = { _id: id };
  if (tenantId) query.tenantId = tenantId;
  const doc = await WorkspaceInvitation.findOne(query).lean();
  if (!doc) return null;
  return { ...doc, id: doc._id };
}

export async function findInvitationByToken(token: string): Promise<any | null> {
  await ensureDb();
  const { WorkspaceInvitation } = await import('@agent-platform/database/models');
  const doc = await WorkspaceInvitation.findOne({ token }).lean();
  if (!doc) return null;
  return { ...doc, id: doc._id };
}

export async function findInvitationByTokenWithRelations(token: string): Promise<any | null> {
  await ensureDb();
  const { WorkspaceInvitation, Tenant, User } = await import('@agent-platform/database/models');
  const doc = await WorkspaceInvitation.findOne({ token }).lean();
  if (!doc) return null;

  // Manual join: fetch tenant and inviter
  // Tenant lookup by its own _id (which IS the tenantId). findOne({_id}) is correct here.
  // User lookup for display name only — userId comes from the invitation record, not user input.
  const [tenant, inviter] = await Promise.all([
    Tenant.findOne({ _id: doc.tenantId }).select('name').lean(),
    doc.invitedBy ? User.findOne({ _id: doc.invitedBy }).select('name email').lean() : null,
  ]);

  return {
    ...doc,
    id: doc._id,
    tenant: tenant ? { ...tenant, id: tenant._id } : null,
    inviter: inviter ? { ...inviter, id: inviter._id } : null,
  };
}

export async function findInvitationByEmail(tenantId: string, email: string): Promise<any | null> {
  await ensureDb();
  const { WorkspaceInvitation } = await import('@agent-platform/database/models');
  const doc = await WorkspaceInvitation.findOne({ tenantId, email }).lean();
  if (!doc) return null;
  return { ...doc, id: doc._id };
}

export async function findInvitations(
  tenantId: string,
  opts?: { includeInviter?: boolean },
): Promise<any[]> {
  await ensureDb();
  const { WorkspaceInvitation, User } = await import('@agent-platform/database/models');
  const docs = await WorkspaceInvitation.find({ tenantId }).sort({ createdAt: -1 }).lean();

  if (opts?.includeInviter) {
    // Manual join: fetch inviters
    const inviterIds = docs
      .map((doc: any) => doc.invitedBy)
      .filter((id: any): id is string => id !== null);
    const inviters = await User.find({ _id: { $in: inviterIds } })
      .select('name email')
      .lean();
    const inviterMap = new Map(inviters.map((u: any) => [u._id, { ...u, id: u._id }]));

    return docs.map((doc: any) => ({
      ...doc,
      id: doc._id,
      inviter: doc.invitedBy ? inviterMap.get(doc.invitedBy) || null : null,
    }));
  }

  return docs.map((doc: any) => ({ ...doc, id: doc._id }));
}

export async function updateInvitation(
  id: string,
  tenantId: string,
  data: {
    status?: string;
    acceptedAt?: Date | null;
    acceptedBy?: string | null;
  },
): Promise<any> {
  await ensureDb();
  const { WorkspaceInvitation } = await import('@agent-platform/database/models');
  const doc = await WorkspaceInvitation.findOneAndUpdate(
    { _id: id, tenantId },
    { $set: data },
    { new: true, runValidators: true },
  ).lean();
  if (!doc) throw new AppError('WorkspaceInvitation not found', { ...ErrorCodes.NOT_FOUND });
  return { ...doc, id: doc._id };
}

export async function deleteInvitation(id: string, tenantId: string): Promise<void> {
  await ensureDb();
  const { WorkspaceInvitation } = await import('@agent-platform/database/models');
  await WorkspaceInvitation.findOneAndDelete({ _id: id, tenantId });
}

// ─── Transaction Operations ──────────────────────────────────────────────

export async function createWorkspaceWithOwner(
  tenantData: {
    name: string;
    slug: string;
    ownerId: string;
    organizationId?: string | null;
    retentionDays?: number;
    settings?: any;
    status?: string;
  },
  memberData: {
    role: string;
    customRoleId?: string | null;
  },
): Promise<any> {
  await ensureDb();
  const { Tenant, TenantMember } = await import('@agent-platform/database/models');

  return withTransaction(async (session) => {
    const opts = session ? { session } : {};

    // Create tenant
    const [tenantDoc] = await Tenant.create(
      [
        {
          name: tenantData.name,
          slug: tenantData.slug,
          ownerId: tenantData.ownerId,
          organizationId: tenantData.organizationId ?? null,
          retentionDays: tenantData.retentionDays ?? 7,
          settings: tenantData.settings ?? null,
          status: tenantData.status ?? 'active',
        },
      ],
      opts,
    );
    const tenant = tenantDoc.toObject();

    // Create tenant member
    const [memberDoc] = await TenantMember.create(
      [
        {
          tenantId: tenant._id,
          userId: tenantData.ownerId,
          role: memberData.role,
          customRoleId: memberData.customRoleId ?? null,
        },
      ],
      opts,
    );
    const member = memberDoc.toObject();

    await seedWorkspaceOperationalDefaults(String(tenant._id), tenantData.ownerId, session);

    return {
      tenant: { ...tenant, id: tenant._id },
      member: { ...member, id: member._id },
    };
  });
}
