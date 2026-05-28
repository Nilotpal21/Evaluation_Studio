/**
 * GET    /api/projects/:id/auth-profiles/:profileId — Get single profile
 * PUT    /api/projects/:id/auth-profiles/:profileId — Update profile
 * DELETE /api/projects/:id/auth-profiles/:profileId — Delete profile
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode } from '@/lib/api-response';
import {
  UpdateAuthProfileSchema,
  AUTH_TYPE_CONFIG_SCHEMAS,
  getAuthProfileUsageModeValidationError,
  getMaterializedAuthProfileValidationErrors,
  mergeOAuth2AppConfig,
  normalizeOAuth2AppConfig,
  resolveAuthProfileUsageMode,
  type UpdateAuthProfileInput,
} from '@agent-platform/shared/validation';
import { getAuthProfileMigrationState } from '@agent-platform/shared/services/auth-profile';
import { ensureDb } from '@/lib/ensure-db';
import { createLogger } from '@abl/compiler/platform/logger.js';
import type { IAuthProfile } from '@agent-platform/database/models';
import {
  buildAuthProfileVisibilityFilter,
  ensureReadableAuthProfile,
  ensureMutableAuthProfile,
  parseAuthProfileSecrets,
} from '@/app/api/auth-profiles/_auth-profile-route-utils';
import {
  formatDeleteBlockerLabel,
  loadModelMap,
  summarizeDeleteBlockers,
  canAutoCascadeInternalDeleteBlockers,
  cleanupAutoCascadeInternalDependencies,
} from '@/app/api/auth-profiles/_bulk-handler';
import { getDevSSRFOptions } from '@agent-platform/shared-kernel/security';

const log = createLogger('project-auth-profile-detail-route');

// ─── GET — Single profile ───────────────────────────────────────────────

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.AUTH_PROFILE_READ },
  async ({ user, params, tenantId }) => {
    await ensureDb();
    const { AuthProfile } = await import('@agent-platform/database/models');
    const { id: projectId, profileId } = params;

    // .lean() is safe here: encryptedSecrets bypasses Mongoose decryption, but we never
    // return the raw value — it's redacted below and encryptedSecrets is stripped from the response.
    const profile = await AuthProfile.findOne({
      _id: profileId,
      tenantId,
      $or: [{ projectId }, { projectId: null, scope: 'tenant' }],
    }).lean();

    if (!profile) {
      return errorJson('Auth profile not found', 404, ErrorCode.NOT_FOUND);
    }

    const p = profile as IAuthProfile;
    const readError = ensureReadableAuthProfile(p, user);
    if (readError) {
      return readError;
    }

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
    } catch {
      /* ignore parse errors */
    }

    const { encryptedSecrets, previousEncryptedSecrets, ...safe } = p;

    // Compute isAuthorized for the requesting user
    const { computeIsAuthorized } = await import('@agent-platform/shared/services/auth-profile');
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

    return NextResponse.json({
      success: true,
      data: {
        ...safe,
        id: safe._id,
        usageMode: resolveAuthProfileUsageMode(safe.authType, safe.usageMode),
        migration: getAuthProfileMigrationState(safe),
        redactedSecrets,
        isAuthorized,
      },
    });
  },
);

// ─── PUT — Update profile ───────────────────────────────────────────────

export const PUT = withRouteHandler<UpdateAuthProfileInput>(
  {
    requireProject: true,
    permissions: StudioPermission.AUTH_PROFILE_WRITE,
    bodySchema: UpdateAuthProfileSchema,
  },
  async ({ body: updates, user, params, tenantId }) => {
    await ensureDb();
    const { AuthProfile } = await import('@agent-platform/database/models');
    const { id: projectId, profileId } = params;

    // SSRF validation for URL fields when authType is OAuth
    const existingLean = await AuthProfile.findOne({
      _id: profileId,
      tenantId,
      projectId,
    }).lean();

    if (!existingLean) {
      // Check if this is an inherited tenant-level profile (visible via GET but not editable here)
      const isAdmin = user.permissions?.includes(StudioPermission.AUTH_PROFILE_DECRYPT) === true;
      const tenantLevel = await AuthProfile.findOne({
        _id: profileId,
        tenantId,
        projectId: null,
        scope: 'tenant',
        ...(isAdmin ? {} : buildAuthProfileVisibilityFilter(user.id)),
      }).lean();
      if (tenantLevel) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'FORBIDDEN',
              message:
                'This is a workspace-level auth profile. Edit it at Settings > Auth Profiles.',
            },
          },
          { status: 403 },
        );
      }
      return errorJson('Auth profile not found', 404, ErrorCode.NOT_FOUND);
    }

    const existingProfile = existingLean as IAuthProfile;
    const writeError = ensureMutableAuthProfile(existingProfile, user);
    if (writeError) {
      return writeError;
    }
    const effectiveVisibility = updates.visibility ?? existingProfile.visibility;
    if (existingProfile.scope === 'tenant' && effectiveVisibility === 'personal') {
      return errorJson(
        'Tenant-scoped profiles cannot have personal visibility.',
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (updates.usageMode !== undefined) {
      const usageModeError = getAuthProfileUsageModeValidationError(
        existingProfile.authType,
        updates.usageMode,
      );
      if (usageModeError) {
        return errorJson(usageModeError, 400, ErrorCode.VALIDATION_ERROR);
      }
    }
    const oauthTypes = ['oauth2_app', 'oauth2_client_credentials', 'oauth2_token'];
    let mergedConfig =
      updates.config !== undefined
        ? existingProfile.authType === 'oauth2_app'
          ? mergeOAuth2AppConfig(
              (existingProfile.config ?? {}) as Record<string, unknown>,
              updates.config,
            )
          : {
              ...((existingProfile.config ?? {}) as Record<string, unknown>),
              ...updates.config,
            }
        : undefined;
    let existingSecrets: Record<string, unknown> | undefined;
    if (updates.config && oauthTypes.includes(existingProfile.authType)) {
      const { validateUrlForSSRF } = await import('@agent-platform/shared/security');
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
        if (updates.config[field]) {
          const check = validateUrlForSSRF(updates.config[field] as string, getDevSSRFOptions());
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

    if (updates.config !== undefined || updates.secrets !== undefined) {
      try {
        existingSecrets = parseAuthProfileSecrets(existingProfile);
      } catch {
        return errorJson(
          'Failed to parse existing auth profile secrets',
          500,
          ErrorCode.INTERNAL_ERROR,
        );
      }

      const mergedSecrets =
        updates.secrets !== undefined
          ? {
              ...existingSecrets,
              ...updates.secrets,
            }
          : existingSecrets;
      const validationErrors = getMaterializedAuthProfileValidationErrors(
        existingProfile.authType,
        mergedConfig ?? ((existingProfile.config ?? {}) as Record<string, unknown>),
        mergedSecrets,
      );
      if (validationErrors.length > 0) {
        return errorJson(validationErrors, 400, ErrorCode.VALIDATION_ERROR);
      }

      if (updates.config !== undefined && existingProfile.authType === 'oauth2_app') {
        mergedConfig = normalizeOAuth2AppConfig(
          mergedConfig ?? ((existingProfile.config ?? {}) as Record<string, unknown>),
        );
      }
    }

    // Per-type config validation
    if (mergedConfig) {
      const typeSchema = AUTH_TYPE_CONFIG_SCHEMAS[existingProfile.authType];
      if (typeSchema) {
        const configResult = typeSchema.safeParse(mergedConfig);
        if (!configResult.success) {
          return errorJson('Invalid config for auth type', 400, ErrorCode.VALIDATION_ERROR);
        }
      }
    }

    if (updates.linkedAppProfileId !== undefined || updates.visibility !== undefined) {
      const { validateAuthProfileUpdate, AuthProfileError } =
        await import('@agent-platform/shared/services/auth-profile');

      try {
        await validateAuthProfileUpdate({
          existingProfile: {
            authType: existingProfile.authType,
            tenantId,
            linkedAppProfileId: existingProfile.linkedAppProfileId,
            scope: existingProfile.scope,
            visibility: existingProfile.visibility,
            projectId:
              existingProfile.projectId === undefined
                ? undefined
                : (existingProfile.projectId ?? null),
            createdBy: existingProfile.createdBy,
          },
          updatePayload: updates as Record<string, unknown>,
        });
      } catch (err) {
        if (err instanceof AuthProfileError) {
          return errorJson(err.message, err.statusCode, err.code);
        }
        throw err;
      }
    }

    // CRITICAL: Must use findOne + modify + save() for encryption plugin
    const existing = await AuthProfile.findOne({
      _id: profileId,
      tenantId,
      projectId,
    });

    if (!existing) {
      return errorJson('Auth profile not found', 404, ErrorCode.NOT_FOUND);
    }

    // Apply updates — cast to IAuthProfile for field access on Mongoose document
    const doc = existing as unknown as IAuthProfile & {
      save: () => Promise<unknown>;
      toObject: () => IAuthProfile;
    };
    if (updates.name !== undefined) doc.name = updates.name;
    if ('description' in updates) doc.description = updates.description ?? undefined;
    if (mergedConfig !== undefined) doc.config = mergedConfig;
    if (updates.environment !== undefined) doc.environment = updates.environment ?? null;
    if (updates.visibility !== undefined) doc.visibility = updates.visibility;
    if (updates.usageMode !== undefined) doc.usageMode = updates.usageMode;
    if (updates.connectionMode !== undefined) doc.connectionMode = updates.connectionMode;
    if (updates.connector !== undefined) doc.connector = updates.connector;
    if (updates.category !== undefined) doc.category = updates.category;
    if (updates.tags !== undefined) doc.tags = updates.tags;
    if (updates.linkedAppProfileId !== undefined)
      doc.linkedAppProfileId = updates.linkedAppProfileId ?? undefined;
    if (updates.status !== undefined) doc.status = updates.status;
    if (updates.enabled !== undefined) doc.enabled = updates.enabled;
    if (updates.secrets !== undefined) {
      try {
        doc.encryptedSecrets = JSON.stringify({
          ...(existingSecrets ?? parseAuthProfileSecrets(doc)),
          ...updates.secrets,
        });
      } catch {
        return errorJson(
          'Failed to parse existing auth profile secrets',
          500,
          ErrorCode.INTERNAL_ERROR,
        );
      }
    }

    await doc.save();

    // ABLP-1073: live-validate connector-bound credential profiles after the
    // update writes. Matches the create-route block in
    // `apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts` so an
    // updated Azure DI key with the wrong value gets rejected before the
    // caller sees a fake-success, instead of silently going active and
    // surfacing the failure at the first workflow run.
    //
    // Skip when secrets + config + linkedAppProfileId didn't change — name /
    // description / visibility edits don't change the credentials and shouldn't
    // pay the round-trip cost.
    const credentialFieldsTouched =
      updates.secrets !== undefined ||
      updates.config !== undefined ||
      updates.linkedAppProfileId !== undefined;
    const shouldLiveValidateOnUpdate =
      credentialFieldsTouched &&
      doc.connector &&
      doc.authType !== 'none' &&
      doc.authType !== 'oauth2_app' &&
      doc.authType !== 'oauth2_token' &&
      doc.authType !== 'oauth2_client_credentials';
    if (shouldLiveValidateOnUpdate) {
      const { runPieceAuthValidate } =
        await import('@/app/api/auth-profiles/_piece-auth-validator');
      const decryptedSecrets = parseAuthProfileSecrets(doc) as Record<string, unknown>;
      const outcome = await runPieceAuthValidate({
        profile: doc as unknown as Parameters<typeof runPieceAuthValidate>[0]['profile'],
        decryptedSecrets,
      });
      if (outcome && !outcome.valid) {
        // Roll the doc back to its prior secrets + config so the caller's
        // failed edit doesn't leave the row in a broken state. We saved the
        // previous shape into `existingProfile` at the top of the handler.
        doc.encryptedSecrets = existingProfile.encryptedSecrets;
        doc.config = existingProfile.config;
        if (existingProfile.linkedAppProfileId !== undefined) {
          doc.linkedAppProfileId = existingProfile.linkedAppProfileId;
        }
        await doc.save();
        return errorJson(
          outcome.error || 'Credential validation failed against the connector provider.',
          400,
          ErrorCode.VALIDATION_ERROR,
        );
      }
    }

    // Detect sensitive field changes
    const SENSITIVE_FIELDS = ['clientId', 'clientSecret', 'scopes', 'tokenUrl', 'refreshUrl'];
    const sensitiveFieldsChanged: string[] = [];

    if (updates.config !== undefined) {
      const oldConfig = (existingProfile.config ?? {}) as Record<string, unknown>;
      const newConfig = (mergedConfig ?? {}) as Record<string, unknown>;
      for (const field of SENSITIVE_FIELDS) {
        if (
          field in newConfig &&
          String(newConfig[field] ?? '') !== String(oldConfig[field] ?? '')
        ) {
          sensitiveFieldsChanged.push(field);
        }
      }
    }
    if (updates.secrets !== undefined) {
      for (const field of SENSITIVE_FIELDS) {
        if (field in updates.secrets) {
          if (!sensitiveFieldsChanged.includes(field)) {
            sensitiveFieldsChanged.push(field);
          }
        }
      }
    }

    // Emit audit events (fire-and-forget)
    try {
      const { emitAuthProfileAuditEvent } =
        await import('@agent-platform/shared/services/auth-profile');
      await emitAuthProfileAuditEvent({
        tenantId,
        projectId,
        profileId,
        eventType: 'profile_updated',
        actorUserId: user.id,
        actorContext: { source: 'profile' },
        eventPayload: { changedFields: Object.keys(updates) },
      });

      if (sensitiveFieldsChanged.length > 0) {
        await emitAuthProfileAuditEvent({
          tenantId,
          projectId,
          profileId,
          eventType: 'sensitive_field_changed',
          actorUserId: user.id,
          actorContext: { source: 'profile' },
          eventPayload: { sensitiveFieldsChanged },
        });
      }
    } catch (err) {
      log.warn('Failed to emit profile_updated audit event', {
        profileId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const savedDoc = doc.toObject();
    const { encryptedSecrets, previousEncryptedSecrets, ...safe } = savedDoc;
    return NextResponse.json({
      success: true,
      data: {
        ...safe,
        id: safe._id,
        usageMode: resolveAuthProfileUsageMode(safe.authType, safe.usageMode),
        migration: getAuthProfileMigrationState(safe),
        ...(sensitiveFieldsChanged.length > 0 ? { sensitiveFieldsChanged } : {}),
      },
    });
  },
);

// ─── DELETE — Delete profile ────────────────────────────────────────────

export const DELETE = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.AUTH_PROFILE_DELETE },
  async ({ request, params, tenantId, user }) => {
    await ensureDb();
    const { AuthProfile } = await import('@agent-platform/database/models');
    const { id: projectId, profileId } = params;

    const existing = await AuthProfile.findOne({
      _id: profileId,
      tenantId,
      projectId,
    }).lean();

    if (!existing) {
      // Check if this is an inherited tenant-level profile (visible via GET but not deletable here)
      const isAdmin = user.permissions?.includes(StudioPermission.AUTH_PROFILE_DECRYPT) === true;
      const tenantLevel = await AuthProfile.findOne({
        _id: profileId,
        tenantId,
        projectId: null,
        scope: 'tenant',
        ...(isAdmin ? {} : buildAuthProfileVisibilityFilter(user.id)),
      }).lean();
      if (tenantLevel) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'FORBIDDEN',
              message:
                'This is a workspace-level auth profile. Delete it at Settings > Auth Profiles.',
            },
          },
          { status: 403 },
        );
      }
      return errorJson('Auth profile not found', 404, ErrorCode.NOT_FOUND);
    }

    const writeError = ensureMutableAuthProfile(existing as IAuthProfile, user);
    if (writeError) {
      return writeError;
    }

    // Delete is allowed for revoked or pending_authorization profiles.
    // - revoked: explicit user lifecycle action; tokens already invalidated.
    // - pending_authorization: never authorized, no tokens or consumers exist,
    //   safe to delete directly. This also unblocks the connection-creation
    //   rollback path in EditConnectionDialog / AgentDesktopConnectionDialog
    //   which deletes a just-created profile when setup fails.
    // Active / expired / invalid profiles must be revoked first.
    const currentStatus = (existing as IAuthProfile).status;
    if (currentStatus !== 'revoked' && currentStatus !== 'pending_authorization') {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'MUST_REVOKE_FIRST',
            message: 'Auth profile must be revoked before it can be deleted. Use Revoke first.',
            currentStatus,
          },
        },
        { status: 409 },
      );
    }

    const models = await loadModelMap();
    // Exclude bridge ConnectorConnection from blocker check for integration profiles —
    // the bridge is auto-created alongside the profile and will be cascade-deleted.
    if (existing.connector) {
      delete (models as Record<string, unknown>).ConnectorConnection;
    }
    const isAdmin = user.permissions?.includes(StudioPermission.AUTH_PROFILE_DECRYPT) === true;
    let blockerSummary = await summarizeDeleteBlockers({
      profileId,
      tenantId,
      projectId,
      userId: user.id,
      isAdmin,
      modelMap: models,
    });

    // Auto-cascade internal dependencies (the profile's own OAuth grant +
    // linked-token children). These aren't real external consumers — they
    // live inside the profile and should be cleaned up transparently rather
    // than blocking delete.
    if (
      canAutoCascadeInternalDeleteBlockers({
        profile: existing as unknown as Record<string, unknown>,
        summary: blockerSummary,
      })
    ) {
      await cleanupAutoCascadeInternalDependencies({
        profileId,
        tenantId,
        modelMap: models,
      });
      blockerSummary = await summarizeDeleteBlockers({
        profileId,
        tenantId,
        projectId,
        userId: user.id,
        isAdmin,
        modelMap: models,
      });
    }

    const actualConsumerCount =
      blockerSummary.visibleConsumers.length + (blockerSummary.hiddenBlockers ? 1 : 0);

    // Check for force-delete via ?confirm=true&consumerCount=N
    const url = new URL(request.url);
    const confirmParam = url.searchParams.get('confirm');
    const consumerCountParam = url.searchParams.get('consumerCount');

    if (blockerSummary.visibleConsumers.length > 0 || blockerSummary.hiddenBlockers) {
      // If confirm=true and consumerCount matches, allow force-delete
      if (confirmParam === 'true' && consumerCountParam !== null) {
        const providedCount = Number(consumerCountParam);
        if (Number.isNaN(providedCount) || providedCount !== actualConsumerCount) {
          return NextResponse.json(
            {
              success: false,
              error: {
                code: 'CONSUMER_COUNT_MISMATCH',
                message: `Consumer count mismatch. Expected ${actualConsumerCount}, got ${providedCount}.`,
                consumers: blockerSummary.visibleConsumers,
                hiddenBlockers: blockerSummary.hiddenBlockers,
                actualConsumerCount,
              },
            },
            { status: 409 },
          );
        }
        // Force-delete allowed — fall through
      } else {
        const visibleParts = blockerSummary.visibleConsumers.map(formatDeleteBlockerLabel);
        const hiddenMessage = blockerSummary.hiddenBlockers
          ? blockerSummary.visibleConsumers.length > 0
            ? ' and additional resources outside this scope'
            : ' resources outside this scope or hidden from your account'
          : '';
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'PROFILE_IN_USE',
              message:
                blockerSummary.visibleConsumers.length > 0
                  ? `Cannot delete auth profile — it is referenced by ${visibleParts.join(', ')}${hiddenMessage}`
                  : `Cannot delete auth profile — it is referenced by${hiddenMessage}`,
              consumers: blockerSummary.visibleConsumers,
              hiddenBlockers: blockerSummary.hiddenBlockers,
              consumerCount: actualConsumerCount,
            },
          },
          { status: 409 },
        );
      }
    }

    const deletedProfile = await AuthProfile.findOneAndDelete({
      _id: profileId,
      tenantId,
      projectId,
    });

    // Best-effort cascade delete of bridge ConnectorConnection
    // Not wrapped in transaction — an orphaned bridge (empty credentials) is harmless.
    if (deletedProfile?.connector) {
      try {
        const { ConnectorConnection } = await import('@agent-platform/database/models');
        await ConnectorConnection.deleteOne({
          authProfileId: profileId,
          tenantId,
        });
      } catch (err) {
        log.warn('Failed to cascade-delete bridge ConnectorConnection', {
          profileId,
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Best-effort cascade delete of EndUserOAuthToken rows and audit events
    try {
      const { EndUserOAuthToken, AuthProfileAuditEvent } =
        await import('@agent-platform/database/models');
      const { buildAuthProfileOAuthProviderKey } =
        await import('@agent-platform/shared/services/auth-profile');
      const provider = buildAuthProfileOAuthProviderKey(profileId);
      await (
        EndUserOAuthToken as {
          deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount: number }>;
        }
      ).deleteMany({ tenantId, provider });
      await (
        AuthProfileAuditEvent as {
          deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount: number }>;
        }
      ).deleteMany({ tenantId, profileId });
    } catch (err) {
      log.warn('Failed to cascade-delete tokens/audit-events', {
        profileId,
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Emit profile_deleted audit event (fire-and-forget)
    try {
      const { emitAuthProfileAuditEvent } =
        await import('@agent-platform/shared/services/auth-profile');
      await emitAuthProfileAuditEvent({
        tenantId,
        projectId,
        profileId,
        eventType: 'profile_deleted',
        actorUserId: user.id,
        actorContext: { source: 'profile' },
        eventPayload: {
          name: (existing as Record<string, unknown>).name,
          authType: (existing as Record<string, unknown>).authType,
        },
      });
    } catch (err) {
      log.warn('Failed to emit profile_deleted audit event', {
        profileId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return NextResponse.json({ success: true, data: { deleted: profileId } });
  },
);
