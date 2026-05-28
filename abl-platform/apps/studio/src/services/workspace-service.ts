/**
 * Workspace Service
 *
 * Workspace (tenant) creation and management.
 */

import { slugify } from '@agent-platform/shared';
import { findTenantBySlug, createWorkspaceWithOwner } from '@/repos/workspace-repo';
import { buildDefaultWorkspaceName } from '@/lib/workspace-name';

export { slugify };

export async function generateUniqueSlug(name: string): Promise<string> {
  let slug = slugify(name);

  const existing = await findTenantBySlug(slug);
  if (existing) {
    slug = `${slug}-${Date.now().toString(36)}`;
  }

  return slug;
}

export async function createWorkspace(params: {
  name: string;
  slug?: string;
  ownerId: string;
}): Promise<{ id: string; name: string; slug: string }> {
  const slug = params.slug || (await generateUniqueSlug(params.name));

  const result = await createWorkspaceWithOwner(
    {
      name: params.name,
      slug,
      ownerId: params.ownerId,
    },
    {
      role: 'OWNER',
    },
  );

  return {
    id: result.tenant.id,
    name: result.tenant.name,
    slug: result.tenant.slug,
  };
}

export async function createDefaultWorkspace(
  userId: string,
  userName?: string,
): Promise<{
  id: string;
  name: string;
  slug: string;
}> {
  const name = buildDefaultWorkspaceName(userName);
  return createWorkspace({ name, ownerId: userId });
}
