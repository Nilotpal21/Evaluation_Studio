/**
 * GET  /api/auth-profiles       — List tenant-scoped (workspace-level) auth profiles
 * POST /api/auth-profiles       — Create a new tenant-scoped auth profile
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode } from '@/lib/api-response';
import {
  CreateAuthProfileSchema,
  resolveAuthProfileUsageMode,
  type CreateAuthProfileInput,
} from '@agent-platform/shared/validation';
import { resolveClientCredentialsToken } from '@agent-platform/shared-auth-profile/client-credentials-service';
import { getAuthProfileMigrationState } from '@agent-platform/shared-auth-profile/legacy-auth-profile';
import {
  AUTH_PROFILE_TRACE_EVENTS,
  emitAuthProfileTraceEvent,
} from '@agent-platform/shared-auth-profile/trace-events';
import { withTransaction } from '@agent-platform/shared/repos';
import { ensureDb } from '@/lib/ensure-db';
import { resolveOwnerEmails } from '@/lib/owner-email-lookup';
import type { IAuthProfile } from '@agent-platform/database/models';
import { getDevSSRFOptions } from '@agent-platform/shared-kernel/security';
import { createLogger } from '@abl/compiler/platform/logger.js';
import {
  executeClientCredentialsCreateFlow,
  type CreateCCFlowProfile,
} from '@/app/api/auth-profiles/_create-cc-flow';

const log = createLogger('workspace-auth-profiles-route');

function isKerberosBuildEnabled(): boolean {
  const value = process.env.ENABLE_KERBEROS;
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

// ─── GET — List tenant-scoped auth profiles ──────────────────────────────

export const GET = withRouteHandler(
  { permissions: StudioPermission.AUTH_PROFILE_READ },
  async ({ request, user, tenantId }) => {
    if (!user?.id) {
      return errorJson('Unauthorized', 401, ErrorCode.UNAUTHORIZED);
    }

    await ensureDb();

    const { AuthProfile } = await import('@agent-platform/database/models');
    const url = new URL(request.url);
    const authTypes = url.searchParams.getAll('authType');
    const connector = url.searchParams.get('connector');
    const environment = url.searchParams.get('environment');
    const status = url.searchParams.get('status');
    const visibility = url.searchParams.get('visibility');
    const search = url.searchParams.get('search');
    const sortBy = url.searchParams.get('sortBy') ?? 'createdAt';
    const sortDir = url.searchParams.get('sortDir') === 'asc' ? 1 : -1;
    const cursor = url.searchParams.get('cursor');
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10)));

    // Build filter: tenant-scoped only (projectId: null, scope: 'tenant')
    const filter: Record<string, unknown> = {
      tenantId,
      projectId: null,
      scope: 'tenant',
    };

    // Visibility enforcement at DB level
    const isAdmin = user.permissions?.includes(StudioPermission.AUTH_PROFILE_DECRYPT);
    if (!isAdmin) {
      filter.$and = [
        {
          $or: [{ visibility: 'shared' }, { visibility: 'personal', createdBy: user.id }],
        },
      ];
    }

    if (authTypes.length === 1) filter.authType = authTypes[0];
    else if (authTypes.length > 1) filter.authType = { $in: authTypes };
    if (connector) filter.connector = connector;
    if (environment) filter.environment = environment;
    if (status) filter.status = status;
    if (visibility) filter.visibility = visibility;
    if (search) {
      // Escape regex special characters to prevent injection
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.name = { $regex: escaped, $options: 'i' };
    }

    // Cursor-based pagination: cursor is the _id of the last item from previous page
    if (cursor) {
      filter._id = { $gt: cursor };
    }

    // Allowed sort fields (whitelist to prevent injection)
    const allowedSortFields = ['name', 'createdAt', 'lastUsedAt', 'status'];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'createdAt';

    const [profiles, total] = await Promise.all([
      AuthProfile.find(filter)
        .sort({ [sortField]: sortDir })
        .limit(limit + 1)
        .lean(),
      AuthProfile.countDocuments(filter),
    ]);

    // Determine next cursor from the extra item
    const hasMore = profiles.length > limit;
    const typedProfiles = profiles as IAuthProfile[];
    const page = hasMore ? typedProfiles.slice(0, limit) : typedProfiles;
    const nextCursor = hasMore ? (page[page.length - 1]?._id ?? null) : null;

    // Consumer-count aggregation removed: the UI never reads linkedConsumerCount
    // (see api/auth-profiles.ts), and the cross-collection aggregations ran on
    // every list call. Move to on-demand via /[profileId]/consumers if needed.

    // Resolve owner emails in one batched lookup (helper isolates the global
    // User collection from tenant/project query lint heuristics).
    const ownerEmails = await resolveOwnerEmails(page.map((p) => p.createdBy));

    // Redact secrets
    const enriched = page.map((p) => {
      // Build redacted secret key map
      let redactedSecrets: Record<string, string> = {};
      try {
        const parsed =
          typeof p.encryptedSecrets === 'string'
            ? JSON.parse(p.encryptedSecrets)
            : (p.encryptedSecrets ?? {});
        redactedSecrets = Object.fromEntries(
          Object.entries(parsed).map(([k, v]) => {
            const val = typeof v === 'string' ? v : '';
            const suffix = val.length >= 4 ? val.slice(-4) : '';
            return [k, suffix ? `••••••${suffix}` : '••••••••'];
          }),
        );
      } catch (err) {
        log.debug('Failed to parse encryptedSecrets for redaction', {
          profileId: p._id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return {
        ...p,
        id: p._id,
        usageMode: resolveAuthProfileUsageMode(p.authType, p.usageMode),
        migration: getAuthProfileMigrationState(p),
        inherited: false,
        enabled: p.enabled !== false,
        createdByEmail: ownerEmails.get(String(p.createdBy)) ?? null,
        redactedSecrets,
        encryptedSecrets: undefined,
        previousEncryptedSecrets: undefined,
      };
    });

    return NextResponse.json({
      success: true,
      data: enriched,
      pagination: { nextCursor, total },
    });
  },
);

// ─── POST — Create tenant-scoped auth profile ───────────────────────────

export const POST = withRouteHandler<CreateAuthProfileInput>(
  {
    permissions: StudioPermission.AUTH_PROFILE_WRITE,
    bodySchema: CreateAuthProfileSchema as any,
  },
  async ({ body, user, tenantId }) => {
    if (!user?.id) {
      return errorJson('Unauthorized', 401, ErrorCode.UNAUTHORIZED);
    }

    await ensureDb();

    const { AuthProfile } = await import('@agent-platform/database/models');

    // oauth2_token profiles are system-managed migration records — only the
    // OAuth callback finalizer is allowed to create them. Block manual POSTs
    // at the workspace boundary, matching the project route's guard. This
    // guard was present pre-ABLP-775 (PR #920) and was unintentionally
    // dropped during that PR; re-adding here closes the regression and the
    // associated test (auth-profile-api: 'rejects manual oauth2_token create
    // requests for workspace auth profiles').
    if (body.authType === 'oauth2_token') {
      return errorJson(
        'oauth2_token profiles are system-managed and cannot be created manually. Use the OAuth authorize/callback flow instead.',
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    // SSRF validation for URL fields (oauth2_app AND oauth2_client_credentials)
    if (body.authType === 'oauth2_app' || body.authType === 'oauth2_client_credentials') {
      const { validateUrlForSSRF } = await import('@agent-platform/shared/security');
      const config = body.config as Record<string, unknown>;
      const urlFields = [
        'authorizationUrl',
        'tokenUrl',
        'refreshUrl',
        'revocationUrl',
        'deviceAuthorizationUrl',
        'tokenIntrospectionUrl',
        'setupGuideUrl',
        'docsUrl',
      ];
      for (const field of urlFields) {
        const url = config[field];
        if (typeof url === 'string') {
          const check = validateUrlForSSRF(url, getDevSSRFOptions());
          if (!check.safe) {
            return errorJson(
              `URL field '${field}' blocked by SSRF protection`,
              400,
              ErrorCode.VALIDATION_ERROR,
            );
          }
        }
      }
    }

    if (body.authType === 'kerberos' && !isKerberosBuildEnabled()) {
      return errorJson(
        'Kerberos support is not enabled in this build.',
        400,
        'AUTH_KERBEROS_NOT_BUILT',
      );
    }

    const usageMode = resolveAuthProfileUsageMode(body.authType, body.usageMode);

    // ABLP-619: oauth2_app and oauth2_client_credentials persist as
    // pending_authorization. The OAuth callback (oauth2_app) or this
    // create handler's inline grant (oauth2_client_credentials) is the
    // sole writer that flips status to 'active'.
    const initialStatus =
      body.authType === 'oauth2_app' || body.authType === 'oauth2_client_credentials'
        ? 'pending_authorization'
        : 'active';

    // Force tenant scope — projectId: null, scope: 'tenant'
    const profile = await withTransaction(async (session) => {
      const sessionOpts = session ? { session } : {};

      const createdResult = await AuthProfile.create(
        [
          {
            name: body.name,
            description: body.description,
            tenantId,
            projectId: null,
            scope: 'tenant',
            environment: body.environment ?? null,
            visibility: body.visibility,
            createdBy: user.id,
            authType: body.authType,
            usageMode,
            connectionMode: body.connectionMode,
            config: body.config,
            encryptedSecrets: JSON.stringify(body.secrets),
            encryptionKeyVersion: 1,
            linkedAppProfileId: body.linkedAppProfileId,
            connector: body.connector,
            category: body.category,
            tags: body.tags,
            status: initialStatus,
          },
        ],
        sessionOpts,
      );

      const created = Array.isArray(createdResult) ? createdResult[0] : createdResult;
      if (!created) {
        throw new Error('Failed to create auth profile');
      }

      // ABLP-913 follow-up: bridge ConnectorConnection auto-creation removed.
      // See project route for the same change rationale.

      return created;
    });

    let activeProfileDoc: IAuthProfile = (
      (profile as { toObject?: () => IAuthProfile }).toObject
        ? (profile as { toObject: () => IAuthProfile }).toObject()
        : (profile as IAuthProfile)
    ) as IAuthProfile;

    // ABLP-619: oauth2_client_credentials runs the grant inline.
    if (body.authType === 'oauth2_client_credentials') {
      const config = body.config as Record<string, unknown>;
      const secrets = body.secrets as { clientId: string; clientSecret: string };
      const tokenUrl = typeof config.tokenUrl === 'string' ? config.tokenUrl : '';
      const scopes = Array.isArray(config.scopes)
        ? (config.scopes as unknown[]).filter((s): s is string => typeof s === 'string')
        : [];

      const { getRedisClient } = await import('@/lib/redis-client');
      const { ConnectorConnection } = await import('@agent-platform/database/models');
      const redis = getRedisClient();
      const result = await executeClientCredentialsCreateFlow(
        {
          profile: {
            ...(activeProfileDoc as unknown as CreateCCFlowProfile),
            _id: String(activeProfileDoc._id),
          },
          secrets,
          scopes,
          tokenUrl,
          tenantId,
        },
        {
          resolveClientCredentialsToken,
          AuthProfile: AuthProfile as unknown as {
            findOneAndUpdate(
              filter: Record<string, unknown>,
              update: Record<string, unknown>,
              options?: Record<string, unknown>,
            ): unknown;
            deleteOne(filter: Record<string, unknown>): unknown;
          },
          ConnectorConnection: ConnectorConnection as unknown as {
            deleteOne(filter: Record<string, unknown>): unknown;
          },
          serviceDeps: {
            redis: redis ?? undefined,
            audience: typeof config.audience === 'string' ? config.audience : undefined,
          },
          emitTrace: emitAuthProfileTraceEvent,
          traceEventNames: AUTH_PROFILE_TRACE_EVENTS,
          log,
        },
      );

      if (!result.ok) {
        return errorJson(result.userFacingMessage, 400, result.code);
      }

      activeProfileDoc = {
        ...activeProfileDoc,
        ...(result.profile as unknown as IAuthProfile),
        status: 'active',
      };
    }

    const { encryptedSecrets: _, previousEncryptedSecrets: __, ...safe } = activeProfileDoc;

    return NextResponse.json(
      {
        success: true,
        data: {
          ...safe,
          id: safe._id,
          usageMode: resolveAuthProfileUsageMode(safe.authType, safe.usageMode),
          migration: getAuthProfileMigrationState(safe),
        },
      },
      { status: 201 },
    );
  },
);
