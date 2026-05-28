/**
 * GET    /api/auth-profiles/:profileId — Get single tenant-scoped profile
 * PUT    /api/auth-profiles/:profileId — Update tenant-scoped profile
 * DELETE /api/auth-profiles/:profileId — Delete tenant-scoped profile
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
import { getAuthProfileMigrationState } from '@agent-platform/shared-auth-profile/legacy-auth-profile';
import { ensureDb } from '@/lib/ensure-db';
import { createLogger } from '@abl/compiler/platform/logger.js';
import type { IAuthProfile } from '@agent-platform/database/models';
import {
  ensureReadableAuthProfile,
  ensureMutableAuthProfile,
  parseAuthProfileSecrets,
} from '@/app/api/auth-profiles/_auth-profile-route-utils';
import { evaluateSaveGating } from '@/app/api/auth-profiles/_save-gating';
import { cascadeDeleteBridge } from '@/app/api/auth-profiles/_bridge-cascade';
import {
  canAutoCascadeInternalDeleteBlockers,
  cleanupAutoCascadeInternalDependencies,
  formatDeleteBlockerLabel,
  hasDeleteBlockers,
  loadModelMap,
  summarizeDeleteBlockers,
} from '@/app/api/auth-profiles/_bulk-handler';
import { getDevSSRFOptions } from '@agent-platform/shared-kernel/security';

const log = createLogger('workspace-auth-profile-detail-route');

// ─── GET — Single tenant-scoped profile ──────────────────────────────────

export const GET = withRouteHandler(
  { permissions: StudioPermission.AUTH_PROFILE_READ },
  async ({ user, params, tenantId }) => {
    await ensureDb();
    const { AuthProfile } = await import('@agent-platform/database/models');
    const { profileId } = params;

    const profile = await AuthProfile.findOne({
      _id: profileId,
      tenantId,
      projectId: null,
      scope: 'tenant',
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
    } catch (err) {
      log.debug('Failed to parse encryptedSecrets for redaction', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const { encryptedSecrets, previousEncryptedSecrets, ...safe } = p;

    return NextResponse.json({
      success: true,
      data: {
        ...safe,
        id: safe._id,
        usageMode: resolveAuthProfileUsageMode(safe.authType, safe.usageMode),
        migration: getAuthProfileMigrationState(safe),
        redactedSecrets,
      },
    });
  },
);

// ─── PUT — Update tenant-scoped profile ──────────────────────────────────

export const PUT = withRouteHandler<UpdateAuthProfileInput>(
  {
    permissions: StudioPermission.AUTH_PROFILE_WRITE,
    bodySchema: UpdateAuthProfileSchema,
  },
  async ({ body: updates, user, params, tenantId }) => {
    await ensureDb();
    const { AuthProfile } = await import('@agent-platform/database/models');
    const { profileId } = params;

    // SSRF validation for URL fields when authType is OAuth
    const existingLean = await AuthProfile.findOne({
      _id: profileId,
      tenantId,
      projectId: null,
      scope: 'tenant',
    }).lean();

    if (!existingLean) {
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
      const { validateAuthProfileUpdate } =
        await import('@agent-platform/shared-auth-profile/update-validator');
      const { AuthProfileError } =
        await import('@agent-platform/shared-auth-profile/linked-app-validator');

      try {
        await validateAuthProfileUpdate({
          existingProfile: {
            authType: existingProfile.authType,
            tenantId,
            linkedAppProfileId: existingProfile.linkedAppProfileId,
            scope: existingProfile.scope,
            visibility: existingProfile.visibility,
            projectId: existingProfile.projectId ?? null,
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

    // ── Save-gating: authorization must succeed before any mutation ──────────
    // Shared with the project PUT route via _save-gating.evaluateSaveGating.
    const gatingOutcome = await evaluateSaveGating({
      existingProfile,
      existingSecrets,
      mergedConfig,
      updates,
      log,
    });
    if (gatingOutcome.kind === 'block-status') {
      return errorJson(gatingOutcome.response.message, 400, ErrorCode.VALIDATION_ERROR);
    }
    if (gatingOutcome.kind === 'block') {
      return NextResponse.json(
        {
          success: false,
          error: gatingOutcome.response,
        },
        { status: 400 },
      );
    }
    const forceReauth = gatingOutcome.forceReauth;

    // CRITICAL: Must use findOne + modify + save() for encryption plugin
    const existing = await AuthProfile.findOne({
      _id: profileId,
      tenantId,
      projectId: null,
      scope: 'tenant',
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
    // forceReauth (from save-gating) overrides any client-supplied status.
    // Client-driven transitions into OAuth-owned states are already rejected
    // earlier by evaluateSaveGating's `block-status` outcome.
    if (forceReauth) {
      doc.status = 'pending_authorization';
    } else if (updates.status !== undefined) {
      doc.status = updates.status;
    }
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

    const savedDoc = doc.toObject();
    const { encryptedSecrets, previousEncryptedSecrets, ...safe } = savedDoc;
    return NextResponse.json({
      success: true,
      data: {
        ...safe,
        id: safe._id,
        usageMode: resolveAuthProfileUsageMode(safe.authType, safe.usageMode),
        migration: getAuthProfileMigrationState(safe),
      },
    });
  },
);

// ─── DELETE — Delete tenant-scoped profile ───────────────────────────────

export const DELETE = withRouteHandler(
  { permissions: StudioPermission.AUTH_PROFILE_DELETE },
  async ({ params, tenantId, user }) => {
    await ensureDb();
    const { AuthProfile } = await import('@agent-platform/database/models');
    const { profileId } = params;

    const existing = await AuthProfile.findOne({
      _id: profileId,
      tenantId,
      projectId: null,
      scope: 'tenant',
    }).lean();

    if (!existing) {
      return errorJson('Auth profile not found', 404, ErrorCode.NOT_FOUND);
    }

    const writeError = ensureMutableAuthProfile(existing as IAuthProfile, user);
    if (writeError) {
      return writeError;
    }

    // Delete is allowed for revoked or pending_authorization profiles.
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
      profileName: typeof existing.name === 'string' ? existing.name : undefined,
      tenantId,
      userId: user.id,
      isAdmin,
      workspaceOnly: true,
      modelMap: models,
    });

    if (hasDeleteBlockers(blockerSummary)) {
      const canAutoCascade = canAutoCascadeInternalDeleteBlockers({
        profile: existing as unknown as Record<string, unknown>,
        summary: blockerSummary,
      });
      if (canAutoCascade) {
        await cleanupAutoCascadeInternalDependencies({
          profileId,
          tenantId,
          modelMap: models,
        });
        blockerSummary = await summarizeDeleteBlockers({
          profileId,
          profileName: typeof existing.name === 'string' ? existing.name : undefined,
          tenantId,
          userId: user.id,
          isAdmin,
          workspaceOnly: true,
          modelMap: models,
        });
      }
    }

    if (hasDeleteBlockers(blockerSummary)) {
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
          },
        },
        { status: 409 },
      );
    }

    const deletedProfile = await AuthProfile.findOneAndDelete({
      _id: profileId,
      tenantId,
      projectId: null,
      scope: 'tenant',
    });

    // Best-effort cascade delete of bridge ConnectorConnection
    if (deletedProfile?.connector) {
      const { ConnectorConnection } = await import('@agent-platform/database/models');
      await cascadeDeleteBridge(
        { profileId, tenantId },
        // eslint-disable-next-line studio-tenant/no-unscoped-mongoose-query -- filter is built by cascadeDeleteBridge and includes tenantId
        { deleteOne: (filter) => ConnectorConnection.deleteOne(filter), log },
      );
    }

    return NextResponse.json({ success: true, data: { deleted: profileId } });
  },
);
