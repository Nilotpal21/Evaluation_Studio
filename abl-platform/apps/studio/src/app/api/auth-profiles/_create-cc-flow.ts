/**
 * Inline `oauth2_client_credentials` create flow.
 *
 * Pure function for the two-phase create + grant flow:
 *   1. Persist with status='pending_authorization'
 *   2. Run client_credentials token exchange
 *   3. On success: flip to 'active' and return the profile
 *   4. On failure: delete the pending row and return a sanitized AUTH_PROFILE_AUTHORIZE_FAILED
 *
 * Extracted from the create-route handlers (project + admin) so the flow can
 * be tested directly with stub deps — no `vi.mock` of platform modules.
 *
 * Sanitized error messages: tenantId, profileId, secrets, and tokenUrl host
 * are kept out of `userFacingMessage`. Raw context is logged via the logger
 * passed in `deps`.
 */

import type { ClientCredentialsDeps } from '@agent-platform/shared/services/auth-profile';

export interface CreateCCFlowProfile {
  _id: string;
  tenantId: string;
  projectId: string | null;
  scope: 'tenant' | 'project';
  authType: 'oauth2_client_credentials';
  status: string;
  profileVersion?: number;
  config: Record<string, unknown>;
  // Plus other fields from IAuthProfile, but only these are read by the flow.
  [key: string]: unknown;
}

export interface CreateCCFlowInput {
  /** Profile that has just been persisted with status='pending_authorization' */
  profile: CreateCCFlowProfile;
  /** Plain (decrypted) secrets used for the token exchange */
  secrets: { clientId: string; clientSecret: string };
  /** OAuth scopes from profile.config.scopes (defaults to []) */
  scopes: string[];
  /** OAuth token URL from profile.config.tokenUrl */
  tokenUrl: string;
  /** Tenant for cache key + multi-tenant isolation */
  tenantId: string;
}

export interface CreateCCFlowDeps {
  /**
   * Token exchange function. Must match the
   * `resolveClientCredentialsToken` signature so the production wiring is
   * literally the shared service. Tests pass a stub.
   */
  resolveClientCredentialsToken: (
    profileId: string,
    tenantId: string,
    profileVersion: number,
    tokenUrl: string,
    clientId: string,
    clientSecret: string,
    scopes: string[],
    serviceDeps: ClientCredentialsDeps,
  ) => Promise<{ accessToken: string; expiresAt?: string; cached: boolean }>;
  /**
   * Auth-profile model surface needed by the flow. Only these methods are used.
   * The full Mongoose model satisfies this shape; tests pass a stub.
   */
  AuthProfile: {
    findOneAndUpdate(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): unknown;
    deleteOne(filter: Record<string, unknown>): unknown;
  };
  /**
   * Optional bridge cleanup surface. Connector-backed auth profiles upsert a
   * ConnectorConnection before this helper runs; a failed grant must remove the
   * bridge as well as the pending AuthProfile so Studio/runtime cannot see a
   * dangling active connection.
   */
  ConnectorConnection?: {
    deleteOne(filter: Record<string, unknown>): unknown;
  };
  /** Redis client passed through to `resolveClientCredentialsToken` for cache. */
  serviceDeps: ClientCredentialsDeps;
  /** Trace event sink. Production: `emitAuthProfileTraceEvent`. */
  emitTrace: (event: {
    eventType: string;
    profileId: string;
    tenantId: string;
    authType: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
  }) => void;
  /** Trace event names — pass `AUTH_PROFILE_TRACE_EVENTS` in production. */
  traceEventNames: { AUTHORIZED: string; AUTHORIZE_FAILED: string };
  /** Wall clock — overridable in tests. */
  now?: () => Date;
  /**
   * Optional logger for raw error context. Sanitization is the *response*
   * concern; logs may keep tenantId/profileId/tokenUrl per CLAUDE.md
   * "User-Facing Runtime Error Sanitization".
   */
  log?: { warn: (msg: string, ctx?: Record<string, unknown>) => void };
}

export type CreateCCFlowResult =
  | {
      ok: true;
      /** Profile with `status: 'active'` and updated `lastValidatedAt` */
      profile: CreateCCFlowProfile;
      cacheHit: boolean;
    }
  | {
      ok: false;
      code: 'AUTH_PROFILE_AUTHORIZE_FAILED';
      /** Safe to surface to API consumers — no tenantId/profileId/secret leak. */
      userFacingMessage: string;
    };

const SANITIZED_FAILURE_MESSAGE =
  'OAuth client credentials authorization failed. Verify the token URL, client ID, and client secret, then retry.';

// ─── Probe: lightweight CC grant check with no DB side effects ────────────

export interface ProbeCCGrantInput {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** OAuth scopes to include in the probe request (defaults to []). */
  scopes: string[];
  /** OAuth audience parameter (required by some providers like Auth0). */
  audience?: string;
}

export type ProbeCCGrantResult = { ok: true } | { ok: false; userFacingMessage: string };

/**
 * Fire a client_credentials token request and return ok/fail with a
 * sanitised message. No DB mutations.
 *
 * SSRF safety: the token URL is validated against `validateUrlForSSRF`
 * inside this function — callers no longer need to pre-validate.
 * Defense-in-depth ensures legacy profiles whose tokenUrl was stored
 * before SSRF checks existed are still safe when the helper is reused
 * (e.g. from PUT save-gating where only credentials change).
 */
export async function probeClientCredentialsGrant(
  input: ProbeCCGrantInput,
  log?: { warn: (msg: string, ctx?: Record<string, unknown>) => void },
): Promise<ProbeCCGrantResult> {
  try {
    const { validateUrlForSSRF } = await import('@agent-platform/shared/security');
    const { getDevSSRFOptions } = await import('@agent-platform/shared-kernel/security');
    const ssrfCheck = validateUrlForSSRF(input.tokenUrl, getDevSSRFOptions());
    if (!ssrfCheck.safe) {
      log?.warn('cc_probe_blocked_ssrf', { tokenUrl: input.tokenUrl, reason: ssrfCheck.reason });
      return { ok: false, userFacingMessage: SANITIZED_FAILURE_MESSAGE };
    }

    const params: Record<string, string> = {
      grant_type: 'client_credentials',
      client_id: input.clientId,
      client_secret: input.clientSecret,
    };
    if (input.scopes.length > 0) params.scope = input.scopes.join(' ');
    if (input.audience) params.audience = input.audience;

    const tokenRes = await fetch(input.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(10_000),
    });

    if (!tokenRes.ok) {
      log?.warn('cc_probe_failed', { tokenUrl: input.tokenUrl, status: tokenRes.status });
      return { ok: false, userFacingMessage: SANITIZED_FAILURE_MESSAGE };
    }
    return { ok: true };
  } catch (err) {
    log?.warn('cc_probe_failed', { tokenUrl: input.tokenUrl, error: String(err) });
    return { ok: false, userFacingMessage: SANITIZED_FAILURE_MESSAGE };
  }
}

/**
 * Run the client_credentials grant for a freshly-persisted (pending) profile.
 *
 * Contract:
 * - Caller MUST have already persisted `input.profile` with status='pending_authorization'.
 * - On success: this function flips status to 'active' via the model and returns the updated doc.
 * - On any failure: this function deletes the pending row and returns a structured error
 *   suitable for a 400 response.
 *
 * The function does not throw on token-exchange failures — callers branch on `result.ok`.
 * It will rethrow only if the model surface fails (DB outage, etc.).
 */
export async function executeClientCredentialsCreateFlow(
  input: CreateCCFlowInput,
  deps: CreateCCFlowDeps,
): Promise<CreateCCFlowResult> {
  const now = deps.now ?? (() => new Date());
  const profileVersion = Number.isInteger(input.profile.profileVersion)
    ? Math.max(1, Number(input.profile.profileVersion))
    : 1;

  let tokenResult: { accessToken: string; expiresAt?: string; cached: boolean };
  try {
    tokenResult = await deps.resolveClientCredentialsToken(
      input.profile._id,
      input.tenantId,
      profileVersion,
      input.tokenUrl,
      input.secrets.clientId,
      input.secrets.clientSecret,
      input.scopes,
      deps.serviceDeps,
    );
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    deps.log?.warn('cc_grant_failed', {
      profileId: input.profile._id,
      tenantId: input.tenantId,
      tokenUrl: input.tokenUrl,
      error: rawMessage,
    });

    deps.emitTrace({
      eventType: deps.traceEventNames.AUTHORIZE_FAILED,
      profileId: input.profile._id,
      tenantId: input.tenantId,
      authType: 'oauth2_client_credentials',
      timestamp: now().toISOString(),
      metadata: {
        reason: 'token_exchange_failed',
        scope: input.profile.scope,
        metric: 'auth_profile_authorize_failed_total',
      },
    });

    const cleanupErrors: string[] = [];
    try {
      // Cleanup: delete the pending row scoped to tenant + status.
      await deps.AuthProfile.deleteOne({
        _id: input.profile._id,
        tenantId: input.tenantId,
        status: 'pending_authorization',
      });
    } catch (cleanupErr) {
      cleanupErrors.push(cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr));
    }

    if (deps.ConnectorConnection) {
      try {
        await deps.ConnectorConnection.deleteOne({
          tenantId: input.tenantId,
          authProfileId: input.profile._id,
        });
      } catch (cleanupErr) {
        cleanupErrors.push(cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr));
      }
    }

    if (cleanupErrors.length > 0) {
      throw new Error(
        `Failed to clean up oauth2_client_credentials authorization artifacts: ${cleanupErrors.join('; ')}`,
      );
    }

    return {
      ok: false,
      code: 'AUTH_PROFILE_AUTHORIZE_FAILED',
      userFacingMessage: SANITIZED_FAILURE_MESSAGE,
    };
  }

  // Success path: flip pending_authorization → active.
  const updated = (await deps.AuthProfile.findOneAndUpdate(
    {
      _id: input.profile._id,
      tenantId: input.tenantId,
      status: 'pending_authorization',
    },
    { $set: { status: 'active', lastValidatedAt: now() } },
    { new: true },
  )) as CreateCCFlowProfile | null;

  const activatedProfile: CreateCCFlowProfile = updated
    ? { ...input.profile, ...updated, status: 'active' }
    : { ...input.profile, status: 'active' };

  deps.emitTrace({
    eventType: deps.traceEventNames.AUTHORIZED,
    profileId: input.profile._id,
    tenantId: input.tenantId,
    authType: 'oauth2_client_credentials',
    timestamp: now().toISOString(),
    metadata: {
      scope: input.profile.scope,
      cached: tokenResult.cached,
    },
  });

  return { ok: true, profile: activatedProfile, cacheHit: tokenResult.cached };
}
