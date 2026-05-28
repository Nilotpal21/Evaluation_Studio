/**
 * GET  /api/projects/:id/auth-profiles       — List auth profiles (project + inherited tenant)
 * POST /api/projects/:id/auth-profiles       — Create a new auth profile
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
import {
  computeIsAuthorized,
  getAuthProfileMigrationState,
  resolveClientCredentialsToken,
  AUTH_PROFILE_TRACE_EVENTS,
  emitAuthProfileTraceEvent,
} from '@agent-platform/shared/services/auth-profile';
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

const log = createLogger('project-auth-profiles-route');

function isKerberosBuildEnabled(): boolean {
  const value = process.env.ENABLE_KERBEROS;
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

// ─── GET — List auth profiles ──────────────────────────────────────────

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.AUTH_PROFILE_READ },
  async ({ request, user, params, tenantId }) => {
    if (!user?.id) {
      return errorJson('Unauthorized', 401, ErrorCode.UNAUTHORIZED);
    }

    await ensureDb();

    const { AuthProfile } = await import('@agent-platform/database/models');
    const projectId = params.id;
    const url = new URL(request.url);
    const authTypes = url.searchParams.getAll('authType');
    const connector = url.searchParams.get('connector');
    const environment = url.searchParams.get('environment');
    const status = url.searchParams.get('status');
    const scope = url.searchParams.get('scope');
    const visibility = url.searchParams.get('visibility');
    const profileType = url.searchParams.get('profileType');
    const search = url.searchParams.get('search');
    const sortBy = url.searchParams.get('sortBy') ?? 'createdAt';
    const sortDir = url.searchParams.get('sortDir') === 'asc' ? 1 : -1;
    const cursor = url.searchParams.get('cursor');
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10)));

    // Build filter: project-level + inherited tenant-level
    const filter: Record<string, unknown> = {
      tenantId,
      $or: [{ projectId }, { projectId: null, scope: 'tenant' }],
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
    if (scope === 'tenant' || scope === 'project') filter.scope = scope;
    if (visibility) filter.visibility = visibility;
    // ABLP-913: HTTP tools / MCP / A2A surfaces filter to profileType='custom'.
    if (profileType === 'custom' || profileType === 'integration') {
      filter.profileType = profileType;
    }
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

    // .lean() is safe here: encryptedSecrets bypasses Mongoose decryption, but we never
    // return the raw value — it's redacted below and encryptedSecrets is stripped from the response.
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
    // (see api/auth-profiles.ts), and the 6 cross-collection aggregations ran on
    // every list call. Move to on-demand via /[profileId]/consumers if needed.

    // Resolve owner emails in a single batched lookup (helper isolates the
    // global-collection query from project-isolation lint heuristics).
    const ownerEmails = await resolveOwnerEmails(page.map((p) => p.createdBy));

    // Mark inherited profiles + redact secrets
    const enriched = await Promise.all(
      page.map(async (p) => {
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
        const isAuthorized = await computeIsAuthorized(
          {
            _id: String(p._id),
            usageMode: p.usageMode,
            encryptedSecrets: p.encryptedSecrets,
            authType: p.authType,
            status: p.status,
            visibility: p.visibility,
          },
          { tenantId, projectId, userId: user.id },
        );
        return {
          ...p,
          id: p._id,
          usageMode: resolveAuthProfileUsageMode(p.authType, p.usageMode),
          migration: getAuthProfileMigrationState(p),
          inherited: p.projectId === null,
          enabled: p.enabled !== false,
          createdByEmail: ownerEmails.get(String(p.createdBy)) ?? null,
          isAuthorized,
          redactedSecrets,
          encryptedSecrets: undefined,
          previousEncryptedSecrets: undefined,
        };
      }),
    );

    return NextResponse.json({
      success: true,
      data: enriched,
      pagination: { nextCursor, total },
    });
  },
);

// ─── POST — Create auth profile ────────────────────────────────────────

export const POST = withRouteHandler<CreateAuthProfileInput>(
  {
    requireProject: true,
    permissions: StudioPermission.AUTH_PROFILE_WRITE,
    bodySchema: CreateAuthProfileSchema as any,
  },
  async ({ body, user, params, tenantId }) => {
    if (!user?.id) {
      return errorJson('Unauthorized', 401, ErrorCode.UNAUTHORIZED);
    }

    await ensureDb();

    const { AuthProfile } = await import('@agent-platform/database/models');
    const projectId = params.id;

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

    const profileProjectId = body.scope === 'tenant' ? null : projectId;

    // ABLP-619: oauth2_app and oauth2_client_credentials persist as
    // pending_authorization. The OAuth callback (oauth2_app) or this
    // create handler's inline grant (oauth2_client_credentials) is the
    // sole writer that flips status to 'active'.
    const initialStatus =
      body.authType === 'oauth2_app' || body.authType === 'oauth2_client_credentials'
        ? 'pending_authorization'
        : 'active';

    const profile = await withTransaction(async (session) => {
      const sessionOpts = session ? { session } : {};

      const createdResult = await AuthProfile.create(
        [
          {
            name: body.name,
            description: body.description,
            tenantId,
            projectId: profileProjectId,
            scope: body.scope,
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
            // ABLP-913: derive profileType from connector presence at write time so
            // new rows are correctly classified as integration/custom without relying
            // on the model's default of 'custom'.
            profileType: body.connector ? 'integration' : 'custom',
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
      // Workflow nodes consume auth-profile ids directly; ConnectionResolver
      // resolves an id as ConnectorConnection first, then falls back to
      // AuthProfile. The bridge wrote a phantom record that inflated
      // linkedConsumerCount with no real workflow attached.

      return created;
    });

    let activeProfileDoc: IAuthProfile = (
      (profile as { toObject?: () => IAuthProfile }).toObject
        ? (profile as { toObject: () => IAuthProfile }).toObject()
        : (profile as IAuthProfile)
    ) as IAuthProfile;

    // ABLP-619: oauth2_client_credentials runs the grant inline. On failure,
    // the pending row is deleted and the API returns 400 with a sanitized error.
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

    // ABLP-1073: live-validate connector-bound credential profiles before
    // returning success. Mirrors the inline-grant pattern that
    // oauth2_client_credentials already uses above — without this, a user
    // could save an Azure DI profile with a wrong subscription key and the
    // failure wouldn't surface until the first workflow run. Skip for
    // OAuth flows (they have their own pending_authorization → callback
    // lifecycle) and for `none` (Docling has no credentials to validate).
    const shouldLiveValidateOnSave =
      activeProfileDoc.connector &&
      activeProfileDoc.authType !== 'none' &&
      activeProfileDoc.authType !== 'oauth2_app' &&
      activeProfileDoc.authType !== 'oauth2_token' &&
      activeProfileDoc.authType !== 'oauth2_client_credentials';
    if (shouldLiveValidateOnSave) {
      const { runPieceAuthValidate } =
        await import('@/app/api/auth-profiles/_piece-auth-validator');
      const outcome = await runPieceAuthValidate({
        profile: activeProfileDoc,
        decryptedSecrets: (body.secrets ?? {}) as Record<string, unknown>,
      });
      if (outcome && !outcome.valid) {
        // Roll back the row + the bridge ConnectorConnection so we don't
        // leave an invalid profile behind. Same cleanup the cc-flow path
        // does on grant failure.
        const { ConnectorConnection } = await import('@agent-platform/database/models');
        // eslint-disable-next-line studio-tenant/no-unscoped-mongoose-query
        await AuthProfile.deleteOne({ _id: activeProfileDoc._id, tenantId });
        if (activeProfileDoc.connector) {
          await ConnectorConnection.deleteOne({
            tenantId,
            projectId,
            connectorName: activeProfileDoc.connector,
            authProfileId: activeProfileDoc._id,
          });
        }
        return errorJson(
          outcome.error || 'Credential validation failed against the connector provider.',
          400,
          ErrorCode.VALIDATION_ERROR,
        );
      }
      // outcome === null is "no validate hook registered" — leave the profile
      // active (matches existing semantic for non-validatable connectors).
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
