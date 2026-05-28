/**
 * Shared auth-profile validation logic used by both the workspace
 * (`/api/auth-profiles/:id/validate`) and project
 * (`/api/projects/:pid/auth-profiles/:id/validate`) POST routes.
 *
 * The only caller-supplied difference is `updateFilter` — the DB filter for
 * the `lastValidatedAt` updateOne, which differs because the project route
 * needs to accept both project-scoped and tenant-inherited profiles.
 */

import { NextResponse } from 'next/server';
import type { IAuthProfile } from '@agent-platform/database/models';
import { getMaterializedAuthProfileValidationErrors } from '@agent-platform/shared/validation';
import { getDevSSRFOptions } from '@agent-platform/shared-kernel/security';
import { safeFetch, SSRFError } from '@agent-platform/shared-kernel/security/safe-fetch';
import { sanitizeError } from '@/lib/sanitize-error';
import {
  runPieceAuthValidate,
  validateOAuth2AppProfile,
  type ValidationMethod,
} from './_piece-auth-validator';
import {
  TENANT_SHARED_OAUTH_PRINCIPAL_ID,
  buildAuthProfileOAuthGrantProvider,
} from './_auth-profile-route-utils';
import {
  emitAuthProfileTraceEvent,
  AUTH_PROFILE_TRACE_EVENTS,
} from '@agent-platform/shared/services/auth-profile';

export async function runAuthProfileValidation(params: {
  profile: IAuthProfile;
  profileId: string;
  tenantId: string;
  userId: string;
  /** DB filter for the lastValidatedAt updateOne — differs between workspace and project routes. */
  updateFilter: Record<string, unknown>;
}): Promise<NextResponse> {
  const { profile: p, profileId, tenantId, userId, updateFilter } = params;

  const start = Date.now();
  let valid = false;
  let error: string | undefined;
  let warning: string | undefined;
  let validationMethod: ValidationMethod = 'structural';

  if (!p.authType) {
    return NextResponse.json({
      success: true,
      data: {
        valid: false,
        latencyMs: Date.now() - start,
        validationMethod: 'structural' as ValidationMethod,
        message: 'Missing authType',
      },
    });
  }

  if (p.status === 'revoked') {
    return NextResponse.json({
      success: true,
      data: {
        valid: false,
        latencyMs: Date.now() - start,
        validationMethod: 'structural' as ValidationMethod,
        message: 'Profile has been revoked',
      },
    });
  }

  // Runtime resolver rejects disabled profiles with AUTH_PROFILE_DISABLED
  // before secrets are decrypted; the validate endpoint must mirror that
  // gate so admins don't see a "Credentials valid" signal for a profile
  // that workflows / agents / MCP tools will refuse to use.
  if ((p as { enabled?: boolean }).enabled === false) {
    return NextResponse.json({
      success: true,
      data: {
        valid: false,
        latencyMs: Date.now() - start,
        validationMethod: 'structural' as ValidationMethod,
        message: 'Profile is disabled — re-enable it before testing credentials',
      },
    });
  }

  if (p.status === 'expired') {
    return NextResponse.json({
      success: true,
      data: {
        valid: false,
        latencyMs: Date.now() - start,
        validationMethod: 'structural' as ValidationMethod,
        message: 'Profile has expired',
      },
    });
  }

  try {
    // The mongoose encryptionPlugin auto-decrypts `encryptedSecrets` on read,
    // so by the time it reaches this handler the value is plaintext JSON.
    const decryptedSecretsField = p.encryptedSecrets;
    const secrets: Record<string, string> =
      typeof decryptedSecretsField === 'string'
        ? JSON.parse(decryptedSecretsField)
        : ((decryptedSecretsField as Record<string, string>) ?? {});
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
        validationMethod = 'live';
        try {
          const tokenRes = await safeFetch(
            config.tokenUrl as string,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              redirect: 'error',
              body: (() => {
                const body = new URLSearchParams({
                  grant_type: 'client_credentials',
                  client_id: secrets.clientId ?? '',
                  client_secret: secrets.clientSecret ?? '',
                });
                const scopes = Array.isArray(config.scopes)
                  ? config.scopes.filter((scope): scope is string => typeof scope === 'string')
                  : [];
                if (scopes.length > 0) {
                  body.set('scope', scopes.join(' '));
                }
                return body;
              })(),
              signal: AbortSignal.timeout(10_000),
            },
            getDevSSRFOptions(),
          );
          valid = tokenRes.ok;
          if (!valid) error = `Provider returned ${tokenRes.status}`;
        } catch (fetchErr) {
          if (fetchErr instanceof SSRFError) {
            validationMethod = 'structural';
            valid = false;
            error = 'tokenUrl is not reachable from this environment';
          } else {
            throw fetchErr;
          }
        }
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
    } else if (p.authType === 'oauth2_app') {
      // EndUserOAuthToken is tenant+user scoped (no projectId). Grant lookup is
      // transitively scoped because profileId is already verified by the caller.
      const outcome = await validateOAuth2AppProfile(
        {
          profile: p,
          decryptedSecrets: secrets,
          tenantId,
          grantUserId:
            p.connectionMode === 'per_user' || p.visibility === 'personal'
              ? userId
              : TENANT_SHARED_OAUTH_PRINCIPAL_ID,
          provider: buildAuthProfileOAuthGrantProvider(profileId),
        },
        {
          findGrant: async (q) => {
            const { EndUserOAuthToken } = await import('@agent-platform/database/models');
            const g = await EndUserOAuthToken.findOne({
              tenantId: q.tenantId,
              userId: q.userId,
              provider: q.provider,
              revokedAt: null,
            });
            if (!g) return null;
            return { expiresAt: g.expiresAt, encryptedAccessToken: g.encryptedAccessToken };
          },
        },
      );
      valid = outcome.valid;
      error = outcome.error;
    } else {
      // api_key, basic_auth, custom — try the piece's own `auth.validate` hook
      // (Activepieces "test connection"), falling back to a built-in live check.
      // Returns null when neither is available.
      const pieceOutcome = await runPieceAuthValidate({ profile: p, decryptedSecrets: secrets });
      if (pieceOutcome === null) {
        validationMethod = 'optimistic';
        valid = true;
        warning =
          'No credential check is available for this auth type; the profile is assumed valid';
      } else {
        validationMethod = 'live';
        valid = pieceOutcome.valid;
        if (!valid) error = pieceOutcome.error ?? 'Provider rejected the credentials';
      }
    }
  } catch (err) {
    error = sanitizeError(err, 'Live credential check failed.');
  }

  const latencyMs = Date.now() - start;

  emitAuthProfileTraceEvent({
    eventType: valid
      ? AUTH_PROFILE_TRACE_EVENTS.VALIDATION_SUCCEEDED
      : AUTH_PROFILE_TRACE_EVENTS.VALIDATION_FAILED,
    profileId,
    tenantId,
    authType: p.authType,
    timestamp: new Date().toISOString(),
    metadata: { validationMethod, latencyMs, ...(error ? { error } : {}) },
  });

  if (valid) {
    const { AuthProfile } = await import('@agent-platform/database/models');
    await AuthProfile.updateOne(
      { ...updateFilter, tenantId },
      { $set: { lastValidatedAt: new Date() } },
    );
  }

  return NextResponse.json({
    success: true,
    data: {
      valid,
      latencyMs,
      validationMethod,
      ...(error ? { message: error } : {}),
      ...(warning ? { warning } : {}),
    },
  });
}
