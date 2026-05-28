/**
 * Organization Service
 *
 * Organization creation and workspace linking.
 */

import { slugify } from './workspace-service';
import {
  findOrganizationBySlug,
  createOrganization as createOrganizationRepo,
  createOrgMember,
  findOrgMember,
} from '@/repos/org-repo';
import {
  findTenantById,
  updateTenant,
  findTenantMember,
  findTenantsForOrganization,
  countTenantMembers,
} from '@/repos/workspace-repo';
import { AppError, ErrorCodes } from '@agent-platform/shared/errors';

export async function createOrganization(params: {
  name: string;
  slug?: string;
  ownerId: string;
  billingEmail: string;
  initialTenantId?: string;
}): Promise<{
  id: string;
  name: string;
  slug: string;
}> {
  let slug = params.slug || slugify(params.name);
  const existing = await findOrganizationBySlug(slug);
  if (existing) {
    slug = `${slug}-${Date.now().toString(36)}`;
  }

  // Create organization
  const newOrg = await createOrganizationRepo({
    name: params.name,
    slug,
    ownerId: params.ownerId,
    billingEmail: params.billingEmail,
  });

  // Create org membership
  await createOrgMember({
    organizationId: newOrg.id,
    userId: params.ownerId,
    role: 'ORG_OWNER',
  });

  // Link initial tenant if provided — verify the requester owns the workspace
  if (params.initialTenantId) {
    const membership = await findTenantMember(params.initialTenantId, params.ownerId);
    if (!membership || membership.role !== 'OWNER') {
      throw new AppError('Only workspace owners can link workspaces to organizations', {
        ...ErrorCodes.FORBIDDEN,
      });
    }

    await updateTenant(params.initialTenantId, {
      organizationId: newOrg.id,
    });
  }

  return { id: newOrg.id, name: newOrg.name, slug: newOrg.slug };
}

export async function linkWorkspaceToOrg(
  tenantId: string,
  orgId: string,
  requestedBy: string,
): Promise<void> {
  // Verify requester is tenant OWNER
  const tenantMembership = await findTenantMember(tenantId, requestedBy);
  if (!tenantMembership || tenantMembership.role !== 'OWNER') {
    throw new AppError('Only workspace owners can link workspaces to organizations', {
      ...ErrorCodes.FORBIDDEN,
    });
  }

  // Verify requester is ORG_OWNER or ORG_ADMIN
  const orgMembership = await findOrgMember(orgId, requestedBy);
  if (!orgMembership || !['ORG_OWNER', 'ORG_ADMIN'].includes(orgMembership.role)) {
    throw new AppError('Only organization owners and admins can link workspaces', {
      ...ErrorCodes.FORBIDDEN,
    });
  }

  // Verify workspace is not already linked to a different organization
  const tenant = await findTenantById(tenantId);
  if (!tenant) {
    throw new AppError('Workspace not found', { ...ErrorCodes.NOT_FOUND });
  }
  if (tenant.organizationId && tenant.organizationId !== orgId) {
    throw new AppError('This workspace is already linked to another organization', {
      ...ErrorCodes.BAD_REQUEST,
    });
  }

  await updateTenant(tenantId, {
    organizationId: orgId,
  });
}

export async function getOrganizationWorkspaces(orgId: string): Promise<
  Array<{
    id: string;
    name: string;
    slug: string;
    status: string;
    memberCount: number;
  }>
> {
  const tenants = await findTenantsForOrganization(orgId);

  // Get member counts for each tenant
  const results = await Promise.all(
    tenants.map(async (t) => {
      const memberCount = await countTenantMembers(t.id);
      return {
        id: t.id,
        name: t.name,
        slug: t.slug,
        status: t.status,
        memberCount,
      };
    }),
  );

  return results;
}
