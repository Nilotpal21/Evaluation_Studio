/**
 * Verify-Draft Helper
 *
 * Shared logic for the workspace and project verify-draft routes. Runs the
 * same structural validation and (where feasible) live verification as the
 * full validate route, but against a transient {authType, config, secrets}
 * payload rather than a persisted auth profile. Used by the slide-over to
 * let users sanity-check a profile before saving it for the first time.
 *
 * What is supported per authType:
 *   - oauth2_client_credentials → live token exchange (real network call)
 *   - oauth2_token              → expiry / structure check
 *   - oauth2_app                → structural validation only (OAuth grant
 *                                  lookup requires a persisted profile, so
 *                                  drafts cannot fully verify; the form
 *                                  guides users to save then click
 *                                  Authorize)
 *   - basic / api_key / bearer / custom_header / none → structural only
 *   - aws_iam (Phase A.7)       → AWS STS GetCallerIdentity live call
 *   - other enterprise types    → structural only for now
 *
 * The response shape mirrors the validate route's response so the slide-over
 * can render the result with the existing AuthProfileHealthPill.
 */

import { z } from 'zod';
import { getMaterializedAuthProfileValidationErrors } from '@agent-platform/shared/validation';
import { getDevSSRFOptions } from '@agent-platform/shared-kernel/security';
import { verifyAwsIamCredentials } from '@agent-platform/shared-auth-profile';
import { computeAuthProfileHealth, type AuthProfileHealth } from '@/lib/auth-profile-health';

export const VerifyDraftRequestSchema = z
  .object({
    authType: z.string().min(1),
    config: z.record(z.string(), z.unknown()).optional().default({}),
    secrets: z.record(z.string(), z.string()).optional().default({}),
  })
  .strict();

export type VerifyDraftRequest = z.infer<typeof VerifyDraftRequestSchema>;

export interface VerifyDraftResult {
  valid: boolean;
  latencyMs: number;
  message?: string;
  validationType?: 'configuration' | 'token_exchange';
  health: AuthProfileHealth;
}

export async function runVerifyDraft(input: VerifyDraftRequest): Promise<VerifyDraftResult> {
  const start = Date.now();
  const { authType, config, secrets } = input;

  // 1. Structural validation — Zod-style schema enforcement on the
  //    {authType, config, secrets} triple. Same helper the validate route
  //    uses for persisted profiles.
  const validationErrors = getMaterializedAuthProfileValidationErrors(
    authType,
    config as Record<string, unknown>,
    secrets,
  );

  if (validationErrors.length > 0) {
    const message = validationErrors.join('; ');
    return {
      valid: false,
      latencyMs: Date.now() - start,
      message,
      validationType: 'configuration',
      health: computeAuthProfileHealth({
        authType,
        lifecycleStatus: 'active', // drafts have no lifecycle yet
        valid: false,
        validationType: 'configuration',
        configurationErrorCount: validationErrors.length,
        isUserAuthorizedAtRuntime: false,
      }),
    };
  }

  // 2. Live verification per auth type
  if (authType === 'oauth2_client_credentials') {
    const tokenUrl = typeof config.tokenUrl === 'string' ? config.tokenUrl : '';
    const clientId = typeof secrets.clientId === 'string' ? secrets.clientId : '';
    const clientSecret = typeof secrets.clientSecret === 'string' ? secrets.clientSecret : '';
    const scopes = Array.isArray(config.scopes)
      ? config.scopes.filter(
          (scope): scope is string => typeof scope === 'string' && scope.length > 0,
        )
      : [];
    const audience = typeof config.audience === 'string' ? config.audience.trim() : '';

    if (!tokenUrl) {
      return draftFailure(start, 'Missing tokenUrl in OAuth config', 'configuration', authType, 1);
    }

    const { validateUrlForSSRF } = await import('@agent-platform/shared/security');
    const ssrfResult = validateUrlForSSRF(tokenUrl, getDevSSRFOptions());
    if (!ssrfResult.safe) {
      return draftFailure(
        start,
        `Token URL blocked by SSRF protection: ${ssrfResult.reason ?? 'unsafe target'}`,
        'configuration',
        authType,
        1,
      );
    }

    let liveOk = false;
    let liveMessage = '';
    try {
      const requestBody = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      });
      if (scopes.length > 0) {
        requestBody.set('scope', scopes.join(' '));
      }
      if (audience.length > 0) {
        requestBody.set('audience', audience);
      }
      const tokenRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: requestBody,
        signal: AbortSignal.timeout(10_000),
      });

      if (tokenRes.ok) {
        liveOk = true;
        liveMessage = 'Live client-credentials token exchange succeeded.';
      } else {
        // Capture RFC 6749 §5.2 error/error_description if present so users see
        // actionable detail (mirrors the runtime CC service's error capture).
        const detail = await readOAuthErrorDetail(tokenRes);
        liveMessage = `Provider returned ${tokenRes.status}${detail ? `: ${detail}` : ''}`;
      }
    } catch (err) {
      liveMessage = err instanceof Error ? err.message : String(err);
    }

    return {
      valid: liveOk,
      latencyMs: Date.now() - start,
      message: liveMessage,
      validationType: 'token_exchange',
      health: computeAuthProfileHealth({
        authType,
        lifecycleStatus: 'active',
        valid: liveOk,
        validationType: 'token_exchange',
        configurationErrorCount: 0,
        isUserAuthorizedAtRuntime: false,
      }),
    };
  }

  if (authType === 'aws_iam') {
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
      return {
        valid: true,
        latencyMs: Date.now() - start,
        message: `Verified as ${verifyResult.identity.arn} (account ${verifyResult.identity.account}, region ${verifyResult.identity.region}).`,
        validationType: 'token_exchange',
        health: computeAuthProfileHealth({
          authType,
          lifecycleStatus: 'active',
          valid: true,
          validationType: 'token_exchange',
          configurationErrorCount: 0,
          isUserAuthorizedAtRuntime: false,
        }),
      };
    }

    return {
      valid: false,
      latencyMs: Date.now() - start,
      message: `AWS STS verification failed: ${verifyResult.error}`,
      validationType: 'token_exchange',
      health: computeAuthProfileHealth({
        authType,
        lifecycleStatus: 'active',
        valid: false,
        validationType: 'token_exchange',
        configurationErrorCount: 0,
        isUserAuthorizedAtRuntime: false,
      }),
    };
  }

  // Default: structural validation passed; no live test for this type
  return {
    valid: true,
    latencyMs: Date.now() - start,
    message: 'Configuration is valid.',
    validationType: 'configuration',
    health: computeAuthProfileHealth({
      authType,
      lifecycleStatus: 'active',
      valid: true,
      validationType: 'configuration',
      configurationErrorCount: 0,
      isUserAuthorizedAtRuntime: false,
    }),
  };
}

function draftFailure(
  start: number,
  message: string,
  validationType: 'configuration' | 'token_exchange',
  authType: string,
  configurationErrorCount: number,
): VerifyDraftResult {
  return {
    valid: false,
    latencyMs: Date.now() - start,
    message,
    validationType,
    health: computeAuthProfileHealth({
      authType,
      lifecycleStatus: 'active',
      valid: false,
      validationType,
      configurationErrorCount,
      isUserAuthorizedAtRuntime: false,
    }),
  };
}

async function readOAuthErrorDetail(response: Response): Promise<string> {
  let raw = '';
  try {
    raw = await response.text();
  } catch {
    return '';
  }
  if (raw.length === 0) return '';

  try {
    const parsed = JSON.parse(raw) as { error?: unknown; error_description?: unknown };
    const code = typeof parsed.error === 'string' ? parsed.error.trim() : '';
    const desc =
      typeof parsed.error_description === 'string' ? parsed.error_description.trim() : '';
    const detail = [code, desc].filter((part) => part.length > 0).join(': ');
    if (detail.length > 0) return detail;
  } catch {
    // Not JSON — fall through to length-capped raw snippet
  }
  return raw.slice(0, 200).trim();
}
