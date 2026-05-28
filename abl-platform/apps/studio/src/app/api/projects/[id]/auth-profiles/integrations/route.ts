/**
 * GET /api/projects/:pid/auth-profiles/integrations
 *
 * Returns vendor-grouped integration profiles. Left-joins the static
 * integration catalog so vendors with zero profiles still appear.
 * Custom-only profiles are excluded.
 *
 * Updated per 2026-05-09 meeting delta (FR-10): catalog left-join.
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { ensureDb } from '@/lib/ensure-db';
import { buildAuthProfileVisibilityFilter } from '@/app/api/auth-profiles/_auth-profile-route-utils';

interface IntegrationProfile {
  id: string;
  name: string;
  isAuthorized: boolean;
  status: string;
  usageMode: string;
  authType: string;
}

interface VendorGroup {
  connector: string;
  displayName: string;
  iconKey?: string;
  profileCount: number;
  profiles: IntegrationProfile[];
  configureHref: string;
}

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.AUTH_PROFILE_READ },
  async ({ params, tenantId, user }) => {
    await ensureDb();
    const { AuthProfile, EndUserOAuthToken } = await import('@agent-platform/database/models');
    const { computeIsAuthorized, getIntegrationCatalog } =
      await import('@agent-platform/shared/services/auth-profile');
    const { id: projectId } = params;

    const isAdmin = user.permissions?.includes(StudioPermission.AUTH_PROFILE_DECRYPT) === true;

    const filter: Record<string, unknown> = {
      tenantId,
      profileType: 'integration',
      $or: [{ projectId }, { projectId: null, scope: 'tenant' }],
    };

    // Respect visibility unless admin
    if (!isAdmin) {
      const visibilityFilter = buildAuthProfileVisibilityFilter(user.id);
      filter.$and = [{ $or: filter.$or as unknown[] }, visibilityFilter];
      delete filter.$or;
    }

    const profiles = await AuthProfile.find(filter)
      .select('_id name connector status usageMode authType visibility encryptedSecrets')
      .sort({ connector: 1, name: 1 })
      .lean();

    // Build vendor groups from existing profiles
    const vendorMap = new Map<string, IntegrationProfile[]>();

    for (const p of profiles as Array<{
      _id: string;
      name: string;
      connector?: string;
      status: string;
      usageMode?: string;
      authType: string;
      visibility?: 'shared' | 'personal';
      encryptedSecrets?: string | null;
    }>) {
      const connector = p.connector ?? 'unknown';
      const usageMode = p.usageMode ?? 'preconfigured';

      const isAuthorized = await computeIsAuthorized(
        {
          _id: String(p._id),
          usageMode,
          encryptedSecrets: p.encryptedSecrets,
          authType: p.authType,
          status: p.status,
          visibility: p.visibility,
        },
        { tenantId, projectId, userId: user.id },
        {
          findOne: (tokenFilter, projection) =>
            (
              EndUserOAuthToken as {
                findOne(
                  filter: Record<string, unknown>,
                  projection: Record<string, number>,
                ): Promise<{ _id: string } | null>;
              }
            ).findOne(tokenFilter, projection),
        },
      );

      const entry: IntegrationProfile = {
        id: String(p._id),
        name: p.name,
        isAuthorized,
        status: p.status,
        usageMode,
        authType: p.authType,
      };

      if (!vendorMap.has(connector)) {
        vendorMap.set(connector, []);
      }
      vendorMap.get(connector)!.push(entry);
    }

    // Left-join with static integration catalog so zero-profile vendors appear
    const catalog = getIntegrationCatalog();
    const catalogMap = new Map(catalog.map((c) => [c.connector, c]));

    // Merge: catalog entries + any DB-only connectors not in catalog
    const allConnectors = new Set([...catalogMap.keys(), ...vendorMap.keys()]);
    const sortedConnectors = Array.from(allConnectors).sort();

    const vendors: VendorGroup[] = sortedConnectors.map((connector) => {
      const catalogEntry = catalogMap.get(connector);
      const vendorProfiles = vendorMap.get(connector) ?? [];
      return {
        connector,
        displayName: catalogEntry?.displayName ?? connector,
        iconKey: catalogEntry?.iconKey,
        profileCount: vendorProfiles.length,
        profiles: vendorProfiles,
        configureHref: `/projects/${encodeURIComponent(projectId)}/auth-profiles?connector=${encodeURIComponent(connector)}`,
      };
    });

    return NextResponse.json({
      success: true,
      data: { vendors },
    });
  },
);
