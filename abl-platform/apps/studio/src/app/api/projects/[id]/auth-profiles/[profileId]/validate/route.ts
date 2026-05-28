/**
 * POST /api/projects/:pid/auth-profiles/:profileId/validate
 *
 * Tests the auth profile by attempting a live connection to the provider.
 * Returns: { success: true, data: { valid: boolean, latencyMs: number, message?: string } }
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { ensureDb } from '@/lib/ensure-db';
import type { IAuthProfile } from '@agent-platform/database/models';
import { getAuthProfileMigrationState } from '@agent-platform/shared/services/auth-profile';
import { getMaterializedAuthProfileValidationErrors } from '@agent-platform/shared/validation';
import { ensureUsableAuthProfile } from '@/app/api/auth-profiles/_auth-profile-route-utils';
import { getDevSSRFOptions } from '@agent-platform/shared-kernel/security';

export const POST = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.AUTH_PROFILE_WRITE },
  async ({ params, tenantId, user }) => {
    await ensureDb();
    const { AuthProfile } = await import('@agent-platform/database/models');
    const { id: projectId, profileId } = params;

    const profile = await AuthProfile.findOne({
      _id: profileId,
      tenantId,
      $or: [{ projectId }, { projectId: null, scope: 'tenant' }],
    });

    if (!profile) {
      return errorJson('Auth profile not found', 404, ErrorCode.NOT_FOUND);
    }

    const p = profile as IAuthProfile;
    const useError = ensureUsableAuthProfile(p, user);
    if (useError) {
      return useError;
    }
    const migration = getAuthProfileMigrationState(p);
    if (migration) {
      return errorJson(migration.message, 400, ErrorCode.VALIDATION_ERROR);
    }
    const start = Date.now();
    let valid = false;
    let error: string | undefined;

    // Structural checks
    if (!p.authType) {
      return NextResponse.json({
        success: true,
        data: { valid: false, latencyMs: Date.now() - start, message: 'Missing authType' },
      });
    }

    if (p.status === 'revoked') {
      return NextResponse.json({
        success: true,
        data: { valid: false, latencyMs: Date.now() - start, message: 'Profile has been revoked' },
      });
    }

    if (p.status === 'expired') {
      return NextResponse.json({
        success: true,
        data: { valid: false, latencyMs: Date.now() - start, message: 'Profile has expired' },
      });
    }

    try {
      // Decrypt secrets for live validation
      const secrets: Record<string, string> =
        typeof p.encryptedSecrets === 'string'
          ? JSON.parse(p.encryptedSecrets)
          : ((p.encryptedSecrets as Record<string, string>) ?? {});
      const config = (p.config ?? {}) as Record<string, unknown>;
      const validationErrors = getMaterializedAuthProfileValidationErrors(
        p.authType,
        config,
        secrets,
      );

      if (validationErrors.length > 0) {
        error = validationErrors.join('; ');
      } else if (p.authType === 'oauth2_client_credentials') {
        if (!config.tokenUrl) {
          error = 'Missing tokenUrl in OAuth config';
        } else {
          // SSRF protection: validate tokenUrl before making outbound request
          const { validateUrlForSSRF } = await import('@agent-platform/shared/security');
          const ssrfCheck = validateUrlForSSRF(config.tokenUrl as string, getDevSSRFOptions());
          if (!ssrfCheck.safe) {
            return errorJson(
              'tokenUrl blocked by SSRF protection',
              400,
              ErrorCode.VALIDATION_ERROR,
            );
          }

          const scopes = Array.isArray(config.scopes)
            ? config.scopes.filter(
                (scope): scope is string => typeof scope === 'string' && scope.length > 0,
              )
            : [];
          const audience = typeof config.audience === 'string' ? config.audience.trim() : '';
          const requestBody = new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: secrets.clientId ?? '',
            client_secret: secrets.clientSecret ?? '',
          });
          if (scopes.length > 0) {
            requestBody.set('scope', scopes.join(' '));
          }
          if (audience.length > 0) {
            requestBody.set('audience', audience);
          }

          const tokenRes = await fetch(config.tokenUrl as string, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: requestBody,
            signal: AbortSignal.timeout(10_000),
          });
          valid = tokenRes.ok;
          if (!valid) error = `Provider returned ${tokenRes.status}`;
        }
      } else if (p.authType === 'oauth2_token') {
        if (config.expiresAt) {
          valid = new Date(config.expiresAt as string) > new Date();
          if (!valid) error = 'Token has expired';
        } else {
          valid = true;
        }
      } else if (p.authType === 'none') {
        valid = true;
      } else if (p.connector) {
        // Connector-bound profile (e.g. Azure DI api_key): invoke the piece's
        // `auth.validateAuth` hook so Test Credentials actually probes the
        // provider (Azure DI /info, etc.) instead of returning a hollow
        // "Configuration is valid" success. `runPieceAuthValidate` returns
        // null when no validate hook is registered for the connector, in
        // which case we fall back to structural-success — matching the
        // previous behavior for connectors without a live probe.
        const { runPieceAuthValidate } =
          await import('@/app/api/auth-profiles/_piece-auth-validator');
        const outcome = await runPieceAuthValidate({
          profile: p,
          decryptedSecrets: secrets as Record<string, unknown>,
        });
        if (outcome === null) {
          valid = true;
        } else {
          valid = outcome.valid;
          if (!outcome.valid && outcome.error) error = outcome.error;
        }
      } else {
        valid = true;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const latencyMs = Date.now() - start;

    // Update lastValidatedAt on success
    if (valid) {
      await AuthProfile.updateOne(
        {
          _id: profileId,
          tenantId,
          $or: [{ projectId }, { projectId: null, scope: 'tenant' }],
        },
        { $set: { lastValidatedAt: new Date() } },
      );
    }

    // Collect warnings
    const warnings: Array<{ code: string; message: string }> = [];

    // For oauth2_app + preconfigured profiles missing refreshUrl, emit a non-blocking warning
    if (
      p.authType === 'oauth2_app' &&
      (p.usageMode === 'preconfigured' || p.usageMode === undefined)
    ) {
      const config = (p.config ?? {}) as Record<string, unknown>;
      if (!config.refreshUrl) {
        warnings.push({
          code: 'AUTH_PROFILE_REFRESH_URL_MISSING',
          message:
            'This OAuth profile does not have a refresh URL configured. Token refresh will not be available.',
        });
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        valid,
        latencyMs,
        ...(error ? { message: error } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      },
    });
  },
);
