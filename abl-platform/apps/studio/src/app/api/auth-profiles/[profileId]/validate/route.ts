/**
 * POST /api/auth-profiles/:profileId/validate — Validate a tenant-scoped auth profile
 *
 * Performs structural checks and, where possible, a live credential check.
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { ensureDb } from '@/lib/ensure-db';
import type { IAuthProfile } from '@agent-platform/database/models';
import { getAuthProfileMigrationState } from '@agent-platform/shared-auth-profile/legacy-auth-profile';
import { buildAuthProfileOAuthProviderKey } from '@agent-platform/shared-auth-profile/oauth-provider-key';
import { verifyAwsIamCredentials } from '@agent-platform/shared-auth-profile/aws-sts-verify';
import {
  getMaterializedAuthProfileValidationErrors,
  resolveAuthProfileUsageMode,
} from '@agent-platform/shared/validation';
import { ensureUsableAuthProfile } from '../../_auth-profile-route-utils';
import { getDevSSRFOptions } from '@agent-platform/shared-kernel/security';
import { computeAuthProfileHealth, type AuthProfileHealth } from '@/lib/auth-profile-health';

const TENANT_SHARED_OAUTH_PRINCIPAL_ID = '__tenant__';

function isGrantExpired(expiresAt: Date | string | null | undefined): boolean {
  if (!expiresAt) {
    return false;
  }

  const expiresAtMs =
    expiresAt instanceof Date ? expiresAt.getTime() : new Date(String(expiresAt)).getTime();

  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}

export const POST = withRouteHandler(
  { permissions: StudioPermission.AUTH_PROFILE_WRITE },
  async ({ params, tenantId, user }) => {
    await ensureDb();
    const { AuthProfile, EndUserOAuthToken } = await import('@agent-platform/database/models');
    const { profileId } = params;

    const profile = await AuthProfile.findOne({
      _id: profileId,
      tenantId,
      projectId: null,
      scope: 'tenant',
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
    let message: string | undefined;
    let validationType: 'configuration' | 'oauth_grant' | 'token_exchange' | undefined;
    let requiresUserAuthorization = false;
    // Captured during the auth-type branch and fed into the health computation
    // at the bottom so the response always carries operational health.
    let configurationErrorCount = 0;
    let oauthGrantState: { found: boolean; expired: boolean; refreshTokenStored: boolean } | null =
      null;

    const buildHealth = (): AuthProfileHealth =>
      computeAuthProfileHealth({
        authType: p.authType ?? '',
        lifecycleStatus: p.status ?? 'invalid',
        valid,
        validationType,
        configurationErrorCount,
        isUserAuthorizedAtRuntime: requiresUserAuthorization,
        ...(oauthGrantState ? { oauthGrant: oauthGrantState } : {}),
        lastValidatedAt: p.lastValidatedAt ? new Date(p.lastValidatedAt).toISOString() : null,
      });

    // Structural checks
    if (!p.authType) {
      return NextResponse.json({
        success: true,
        data: {
          valid: false,
          latencyMs: Date.now() - start,
          message: 'Missing authType',
          health: buildHealth(),
        },
      });
    }

    if (p.status === 'revoked') {
      return NextResponse.json({
        success: true,
        data: {
          valid: false,
          latencyMs: Date.now() - start,
          message: 'Profile has been revoked',
          health: buildHealth(),
        },
      });
    }

    // Mirror the runtime resolver's enabled gate: a disabled profile cannot
    // be considered "valid" even if its credentials would authenticate, since
    // workflows / agents / MCP tools will refuse to use it.
    if ((p as { enabled?: boolean }).enabled === false) {
      return NextResponse.json({
        success: true,
        data: {
          valid: false,
          latencyMs: Date.now() - start,
          message: 'Profile is disabled — re-enable it before testing credentials',
          health: buildHealth(),
        },
      });
    }

    if (p.status === 'expired') {
      return NextResponse.json({
        success: true,
        data: {
          valid: false,
          latencyMs: Date.now() - start,
          message: 'Profile has expired',
          health: buildHealth(),
        },
      });
    }

    if (p.status === 'invalid') {
      return NextResponse.json({
        success: true,
        data: {
          valid: false,
          latencyMs: Date.now() - start,
          message: 'Profile is invalid',
          health: buildHealth(),
        },
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
      const usageMode = resolveAuthProfileUsageMode(p.authType, p.usageMode);

      configurationErrorCount = validationErrors.length;
      if (validationErrors.length > 0) {
        message = validationErrors.join('; ');
        validationType = 'configuration';
      } else if (p.authType === 'oauth2_app') {
        if (usageMode === 'preconfigured') {
          validationType = 'oauth_grant';
          const principalCandidates = [user.id];
          if (p.connectionMode !== 'per_user' && user.id !== TENANT_SHARED_OAUTH_PRINCIPAL_ID) {
            principalCandidates.push(TENANT_SHARED_OAUTH_PRINCIPAL_ID);
          }

          const oauthProvider = buildAuthProfileOAuthProviderKey(String(p._id));
          let grant: {
            userId: string;
            encryptedAccessToken?: string;
            encryptedRefreshToken?: string;
            expiresAt?: Date | string | null;
          } | null = null;

          for (const principalUserId of principalCandidates) {
            grant = (await EndUserOAuthToken.findOne({
              tenantId,
              provider: oauthProvider,
              userId: principalUserId,
              revokedAt: null,
            })
              .select('userId encryptedAccessToken encryptedRefreshToken expiresAt')
              .lean()) as {
              userId: string;
              encryptedAccessToken?: string;
              encryptedRefreshToken?: string;
              expiresAt?: Date | string | null;
            } | null;
            if (grant) {
              break;
            }
          }

          const grantFound =
            !!grant &&
            typeof grant.encryptedAccessToken === 'string' &&
            grant.encryptedAccessToken.trim().length > 0;
          const grantExpired = grantFound && isGrantExpired(grant?.expiresAt);
          const refreshTokenStored =
            !!grant &&
            typeof grant.encryptedRefreshToken === 'string' &&
            grant.encryptedRefreshToken.trim().length > 0;
          oauthGrantState = {
            found: grantFound,
            expired: grantExpired,
            refreshTokenStored,
          };

          if (!grantFound) {
            message =
              'OAuth authorization is required for this auth profile. Click Authorize on this profile, or reconnect from Tool Test.';
          } else if (grantExpired && !refreshTokenStored) {
            message =
              'OAuth authorization exists but is expired and cannot be refreshed. Reconnect the auth profile.';
          } else {
            valid = true;
            message = 'OAuth authorization is connected for this auth profile.';
          }
        } else {
          valid = true;
          validationType = 'configuration';
          requiresUserAuthorization = true;
          message =
            usageMode === 'jit'
              ? 'Configuration is valid. In JIT mode, each user authorizes when the tool is invoked.'
              : 'Configuration is valid. In Preflight mode, each user authorizes before the session starts.';
        }
      } else if (p.authType === 'oauth2_client_credentials') {
        validationType = 'token_exchange';
        if (!config.tokenUrl) {
          message = 'Missing tokenUrl in OAuth config';
        } else {
          const { validateUrlForSSRF } = await import('@agent-platform/shared/security');
          const ssrfResult = validateUrlForSSRF(config.tokenUrl as string, getDevSSRFOptions());
          if (!ssrfResult.safe) {
            return NextResponse.json(
              {
                success: false,
                error: {
                  code: 'VALIDATION_ERROR',
                  message: `Unsafe token URL: ${ssrfResult.reason}`,
                },
              },
              { status: 400 },
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
          message = valid
            ? 'Live client-credentials token exchange succeeded.'
            : `Provider returned ${tokenRes.status}`;
        }
      } else if (p.authType === 'oauth2_token') {
        validationType = 'configuration';
        if (config.expiresAt) {
          valid = new Date(config.expiresAt as string) > new Date();
          message = !valid ? 'Token has expired' : 'Stored OAuth token is active.';
        } else {
          valid = true;
          message = 'Stored OAuth token is configured.';
        }
      } else if (p.authType === 'aws_iam') {
        validationType = 'token_exchange';
        const region = typeof config.region === 'string' ? config.region : '';
        const accessKeyId = typeof secrets.accessKeyId === 'string' ? secrets.accessKeyId : '';
        const secretAccessKey =
          typeof secrets.secretAccessKey === 'string' ? secrets.secretAccessKey : '';
        const sessionToken =
          typeof secrets.sessionToken === 'string' ? secrets.sessionToken : undefined;

        const verifyResult = await verifyAwsIamCredentials({
          region,
          accessKeyId,
          secretAccessKey,
          ...(sessionToken ? { sessionToken } : {}),
        });

        if (verifyResult.ok) {
          valid = true;
          message = `Verified as ${verifyResult.identity.arn} (account ${verifyResult.identity.account}, region ${verifyResult.identity.region}).`;
        } else {
          message = `AWS STS verification failed: ${verifyResult.error}`;
        }
      } else if (p.authType === 'none') {
        valid = true;
        validationType = 'configuration';
        message = 'No authentication required.';
      } else {
        valid = true;
        validationType = 'configuration';
        message = 'Configuration is valid.';
      }
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    const latencyMs = Date.now() - start;

    // Update lastValidatedAt
    if (valid) {
      await AuthProfile.updateOne(
        { _id: profileId, tenantId, projectId: null, scope: 'tenant' },
        { $set: { lastValidatedAt: new Date() } },
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        valid,
        latencyMs,
        ...(message ? { message } : {}),
        ...(validationType ? { validationType } : {}),
        ...(requiresUserAuthorization ? { requiresUserAuthorization } : {}),
        health: buildHealth(),
      },
    });
  },
);
