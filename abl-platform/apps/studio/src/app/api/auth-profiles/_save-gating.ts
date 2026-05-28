/**
 * Save-gating helpers for the auth-profile PUT routes.
 *
 * Both the workspace and the project PUT handlers ran the same OAuth
 * save-gating logic inline:
 *   - oauth2_client_credentials: probe the CC grant when credentials or tokenUrl
 *     change; on failure return a structured 400 without mutating the profile.
 *   - oauth2_app: when client credentials change, force the profile back to
 *     `pending_authorization` so the UI re-opens the OAuth dialog.
 *
 * Extracting the logic into one helper keeps the workspace and project
 * PUT routes in lockstep and makes the gating individually testable.
 */

import { probeClientCredentialsGrant } from './_create-cc-flow';

/** Subset of the platform logger needed by the gating helper. */
export interface SaveGatingLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface SaveGatingExistingProfile {
  authType: string;
  config?: Record<string, unknown> | null;
}

export interface SaveGatingUpdates {
  config?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  status?: string;
}

/** OAuth-bearing types whose status state machine is owned server-side. */
const OAUTH_BEARING_TYPES = new Set(['oauth2_app', 'oauth2_client_credentials']);
/** Statuses a client must NOT push directly for OAuth-bearing profiles. */
const OAUTH_OWNED_STATUSES = new Set(['active', 'pending_authorization']);

export type SaveGatingOutcome =
  | { kind: 'allow'; forceReauth: boolean }
  | {
      kind: 'block';
      response: {
        code: 'AUTH_PROFILE_AUTHORIZE_FAILED';
        message: string;
      };
    }
  | {
      kind: 'block-status';
      response: {
        code: 'VALIDATION_ERROR';
        message: string;
      };
    };

/**
 * Decide whether a PUT update should be allowed and whether the OAuth state
 * machine should be reset back to `pending_authorization`.
 *
 * Pure: side effects are limited to the optional logger and the live token
 * probe. No DB writes — the caller applies `forceReauth` to the doc.
 */
export async function evaluateSaveGating(params: {
  existingProfile: SaveGatingExistingProfile;
  existingSecrets: Record<string, unknown> | undefined;
  mergedConfig: Record<string, unknown> | undefined;
  updates: SaveGatingUpdates;
  log?: SaveGatingLogger;
}): Promise<SaveGatingOutcome> {
  const { existingProfile, existingSecrets, mergedConfig, updates, log } = params;

  // Reject client-driven transitions into OAuth-owned states (active /
  // pending_authorization) for oauth2_app and oauth2_client_credentials. The
  // OAuth callback / inline grant is the sole writer for those values.
  if (
    OAUTH_BEARING_TYPES.has(existingProfile.authType) &&
    updates.status !== undefined &&
    OAUTH_OWNED_STATUSES.has(updates.status)
  ) {
    return {
      kind: 'block-status',
      response: {
        code: 'VALIDATION_ERROR',
        message: 'Status cannot be set directly for OAuth profiles. Use the OAuth authorize flow.',
      },
    };
  }

  if (existingProfile.authType === 'oauth2_client_credentials') {
    const ccFieldChanged =
      updates.secrets?.clientId !== undefined ||
      updates.secrets?.clientSecret !== undefined ||
      updates.config?.tokenUrl !== undefined;

    if (ccFieldChanged) {
      const finalSecrets = {
        ...((existingSecrets as Record<string, string | undefined>) ?? {}),
        ...((updates.secrets as Record<string, string | undefined>) ?? {}),
      };
      const finalConfig =
        mergedConfig ?? ((existingProfile.config ?? {}) as Record<string, unknown>);
      const probeResult = await probeClientCredentialsGrant(
        {
          tokenUrl: (finalConfig.tokenUrl as string) ?? '',
          clientId: finalSecrets.clientId ?? '',
          clientSecret: finalSecrets.clientSecret ?? '',
          scopes: Array.isArray(finalConfig.scopes) ? (finalConfig.scopes as string[]) : [],
          audience: typeof finalConfig.audience === 'string' ? finalConfig.audience : undefined,
        },
        log,
      );
      if (!probeResult.ok) {
        return {
          kind: 'block',
          response: {
            code: 'AUTH_PROFILE_AUTHORIZE_FAILED',
            message: probeResult.userFacingMessage,
          },
        };
      }
    }
    return { kind: 'allow', forceReauth: false };
  }

  if (existingProfile.authType === 'oauth2_app') {
    const oauthAppCredentialChanged =
      updates.secrets?.clientId !== undefined ||
      updates.secrets?.clientSecret !== undefined ||
      updates.config?.tokenUrl !== undefined ||
      updates.config?.authorizationUrl !== undefined;

    return { kind: 'allow', forceReauth: oauthAppCredentialChanged };
  }

  return { kind: 'allow', forceReauth: false };
}
